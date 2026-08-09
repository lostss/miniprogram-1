# AI 对话调用链路深度审计报告

**审计范围**：微信小程序 AI 对话前后端调用链路（聚焦数据流与错误处理）
**审计日期**：2026-08-09
**审计路径**：`c:\Users\lyy\WeChatProjects\miniprogram-1`

---

## 0. 审计概述与文件清单

### 0.1 实际审计文件

任务描述中部分文件路径与实际代码结构存在差异，实际审计以下文件：

| 层 | 文件 | 说明 |
|----|------|------|
| 前端 | `miniprogram/utils/apiClient.js` | 统一 API 路由（归一化返回契约） |
| 前端 | `miniprogram/utils/chat-source.js` | 双 adapter（stream/fallback） |
| 前端 | `miniprogram/utils/errorHandler.js` | 错误码 → 提示映射 |
| 前端 | `miniprogram/utils/callCloud.js` | 云函数调用包装（超时+重试） |
| 前端 | `miniprogram/components/chat-panel/index.js` | 调用方组件 |
| 后端 | `cloudfunctions/conversationAI/index.js` | 云函数入口（四模式路由） |
| 后端 | `cloudfunctions/conversationAI/_shared/config.js` | 统一配置（非根目录 config.js） |
| 后端 | `cloudfunctions/conversationAI/_shared/ai-client.js` | AI 客户端（非根目录 ai-client.js） |
| 后端 | `cloudfunctions/conversationAI/_shared/ai-gateway.js` | AI 安全网关 |
| 后端 | `cloudfunctions/conversationAI/tool-orchestration.js` | 工具编排内核 |
| 后端 | `cloudfunctions/conversationAI/confirm-handler.js` | 确认/保留卡片处理 |
| 后端 | `cloudfunctions/conversationAI/_shared/cross-fn-call.js` | 跨函数调用 seam |
| 后端 | `cloudfunctions/conversationAI/_shared/guard.js` | 限流/注入/输出审计 |
| 后端 | `cloudfunctions/conversationAI/_shared/retry.js` | 重试策略 seam |
| 后端 | `cloudfunctions/conversationAI/_shared/errorHandler.js` | 后端错误格式化 |
| 后端 | `cloudfunctions/conversationAI/_shared/v2-context.js` | 上下文构建（Grep 抽样） |

### 0.2 关键架构差异说明

1. **`stream-handler.js` 不存在**：流式处理完全在前端 `chat-source.js` 完成，云函数不参与流式。后端无独立 stream-handler 模块。
2. **`config.js` / `ai-client.js` 实际位于 `_shared/` 子目录**：被 `index.js` 按需 require。
3. **流式不走云函数**：前端 `wx.cloud.extend.AI.createModel('cloudbase').streamText` 直连混元（hy3，小程序成长计划），云函数仅在收尾（postProcess/record）介入。

---

## 1. 数据流图（文字描述）

### 1.1 主链路：流式 + 无工具（纯问答）

```
用户输入
  ↓
chat-panel.onSend()
  ├─ 守卫：thinking / _postProcessing 拦截
  ├─ 安全：sanitize → desensitize → detectInjection（前端三步）
  ├─ 拼 systemPrompt = promptCache.get(familyId).systemPrompt + context
  ├─ streamHist = ms.slice(-15)（含当前用户消息，截断1500字）
  ├─ genHist   = ms.slice(0,-1)（不含当前用户消息，降级用）
  ↓
chatSource.send()
  ├─ 生成 _streamSession（UI 流隔离用，不传后端）
  ├─ 检测 wx.cloud.extend.AI 可用 → stream 模式
  ↓
stream()  [前端直连混元 hy3]
  ├─ desensitize(sp) + desensitize(hist)
  ├─ model.streamText({ model:'hy3', messages:[system,...hist], max_tokens:1500 })
  ├─ onText: fullText += c；_maskToolIntent → 节流100ms → setData 渲染
  ├─ 30s 首字超时定时器
  ├─ onFinish: _extractToolIntent → { text, toolIntent }
  ↓
chat-panel._finalizeConversation(userText, fullText, ..., toolIntent=null, forcePost=false)
  ├─ hasTool=false → mode='record'
  ├─ api('conversationAI', { mode:'record', familyId, userText, text, sessionId })
  ↓
callCloud('conversationAI', data, {})  [默认 timeout=30s, retries=1]
  ↓
conversationAI.exports.main → _handleRecord
  ├─ auditOutput(text)  [禁止承诺 + PII 脱敏]
  ├─ checkContentSafe(cloud, cleanText)  [事后内容安全复核]
  ├─ _writeMessage(user, cleanedUserText)
  ├─ _writeMessage(assistant, cleanText)
  └─ logAI(action:'conversation_record')
  ↓
apiClient 归一化 { ok, code, msg, data }
  ↓
chat-panel：cleanText 不变则 UI 无变化
```

### 1.2 主链路：流式 + 有工具

```
（1-6 同 1.1，streamText 输出含 {TOOL_INTENT:{"tools":[{"name":"..."}]}} 标识行）
  ↓
chat-panel._finalizeConversation(..., toolIntent={tools:[{name}]}, forcePost=false)
  ├─ hasTool=true → mode='postProcess'
  ├─ payload.intent = toolIntent.tools.map(t => ({ name: t.name }))  [仅传 name，不传 args]
  ├─ payload.aText = aText；payload.history = ms.slice(0,-1)
  ↓
api('conversationAI', { mode:'postProcess', familyId, userText, text, aText, history, intent, sessionId })
  ↓
conversationAI._handlePostProcess
  ├─ [0] CONFIRM/KEEP/sug 拦截（确认卡路径，见 1.4）
  ├─ checkRateLimit(db, openid)  [60次/60s，排除 OCR action]
  ├─ auditOutput(text)
  ├─ _buildToolContext(familyId, openid)  [CtxCache TTL=5s，key带openid]
  ↓
tool-orchestration.orchestrate()
  ├─ filterToolDefs(toolDefs, userText)  [按意图关键词裁剪工具 schema]
  ├─ intentNames 预选 intentDefs（A 判定的工具必保留）
  ├─ Phase1: safeCallChatWithTools(toolMessages, filteredDefs, callChatWithTools)
  │           └─ withRetry maxAttempts=3, retryOn=429（指数退避 2s/4s）
  ├─ Phase1.toolCalls → Promise.all(dispatch)  [并发执行工具]
  │   ├─ validateArgs（L3 参数校验）
  │   └─ dispatch(tool, {...args, familyId}, openid)  [familyId 在后防注入覆盖]
  ├─ buildSuggestions(toolResults)  [生成确认卡/建议]
  ├─ 数据变更 → ctxCache.invalidate(familyId+':'+openid)
  ├─ 分支：
  │   ├─ hasPending → cleanText = phase1Text
  │   ├─ failedResults>0 → P2.5 失败回流 _reflowWithResults（safeCallChat 再生成失败提示）
  │   ├─ reflowable>0 → v9.3 成功回流 _reflowWithResults（基于真实结果组织确认语）
  │   └─ else → cleanText = aText（保留 A 断言）
  ↓
回到 _handlePostProcess
  ├─ stripToolCardMarkers(cleanText)
  ├─ checkContentSafe(cloud, cleanText)  [输出内容安全]
  ├─ _writeMessage(user) + _writeMessage(assistant, cleanText, suggestions, pending_confirms)
  └─ logAI(action:'conversation_postprocess', tools:toolResults)
  ↓
chat-panel：cleanText !== aText 则替换 UI；toolResults 有写操作 → _debouncedReportRefresh
```

### 1.3 降级链路：流式失败 → generateText

```
stream() 内 onError / 30s首字超时
  ├─ 429/超时 → 重试2次（指数退避 1s→2s）
  ├─ 重试耗尽或其他错误 → handleError
  ↓
fallback(sp, genHist, userText)
  ├─ api('conversationAI', { mode:'generateText', familyId, systemPrompt, messages, text, sessionId })
  ↓
conversationAI._handleGenerateText
  ├─ sanitize(text) + checkRateLimit
  ├─ safeCallChat(fullMessages, callChat, ctx, {maxTokens:1200})
  │   └─ ai-gateway: secureInput → injectCheck → contentSafe(输入) → callChat(hy3) → audit → contentSafe(输出) ∥ logAI
  └─ 返回 { content, logId }  [不写消息、不执行工具，由 postProcess 统一]
  ↓
chat-source 返回 { text: content, toolIntent: null }
  ↓
chat-panel._finalizeConversation（无工具 → record 落库）
```

### 1.4 确认卡片链路

```
用户点击建议/确认卡 → chat-panel.onSugTap(sug)
  ├─ 守卫：_postProcessing 拦截
  ├─ _finalizeConversation(sug, '', ..., null, forcePost=true)
  ↓
api('conversationAI', { mode:'postProcess', familyId, userText:sug, text:'', sessionId })
  ↓
_handlePostProcess
  ├─ cleanedUserText 匹配 /^\{CONFIRM:([\w-]+)\}$/ 或 /^\{KEEP:([\w-]+)\}$/
  ├─ 或 sug 拦截：getLatestAssistantMsg → 匹配 suggestions[idx] → pending_confirms[idx]
  ↓
_handleConfirm / _handleKeep（confirm-handler.js）
  ├─ 从 lastMsg.pending_confirms 找 pendingId
  ├─ STRATEGIES[type].exec → dispatch(updateFactConfidence / upsertMember / deleteXxx, {...,confirmed:true})
  ├─ ctxCache.invalidate
  ├─ writeMessage(user, actualUserText) + writeMessage(assistant, replyText)
  └─ logAI(action: fact_confirm/member_confirm/delete_confirm)
```

---

## 2. 检查项逐项评估

### 2.1 调用链路完整性

| 检查项 | 评估 | 证据/说明 |
|--------|------|-----------|
| onSend → apiClient → 云函数 → AI 模型链路清晰 | ✅ 清晰 | onSend → chatSource.send → stream(直连混元)/fallback(→apiClient→conversationAI generateText→callChat) |
| stream vs generate 选择逻辑正确 | ✅ 正确 | `chat-source.js:194` 检测 `wx.cloud.extend.AI` 可用性；流式优先，不可用则 fallback |
| 流式响应正确传递（SSE → chunk 拼接） | ✅ 正确 | `onText` 累加 `fullText`，节流 100ms 更新 UI；`_maskToolIntent` 屏蔽标识行；`onFinish` 剥离解析 |
| 非流式降级覆盖（流式失败 → generate 兜底） | ✅ 覆盖 | `handleError` 在 429/超时重试 2 次耗尽后调 `fallback(sp, genHist, userText)` |
| callChat vs callChatDirect 选择逻辑 | ⚠️ 需澄清 | 对话链路 `generateText` 用 `callChat`（hy3 via TokenHub）；`callChatDirect`（DeepSeek 直连）仅 OCR 场景使用。`config.AI.USE_DIRECT=true` 存在但对话链路未消费，配置名易误解 |

**说明**：流式不走云函数（前端直连 `wx.cloud.extend.AI`），云函数仅在收尾（record/postProcess）和降级（generateText）介入。这是有意设计，但与"前后端调用链路"的直觉不同——流式阶段无后端参与。

### 2.2 参数传递

| 检查项 | 评估 | 证据/说明 |
|--------|------|-----------|
| familyId 每层正确传递 | ✅ 正确 | 前端 `payload.familyId`；后端 `exports.main` 校验；`_dispatch` 解构 `params.familyId`；`callSibling` 透传 |
| sessionId 一致性 | ⚠️ 双重命名 | `chat-panel._sessionId`（落库用，`s_`+时间戳）vs `chat-source.send` 内部 `sessionId`（UI 流隔离用，时间戳+random）。两者用途不同但命名易混淆；同会话内落库 sessionId 一致 |
| messages 历史正确传递（截断/摘要） | ✅ 正确 | streamHist=`slice(-15)` 1500字；genHist=`slice(0,-1)`；后端 generateText `slice(-15)` 1500字；tool-orchestration `history.slice(-6)` 500字 |
| tools 按意图裁剪后传递 | ✅ 正确 | `tool-orchestration.filterToolDefs` 按关键词裁剪；`intentNames` 预选 intentDefs；无意图命中回退全量 |
| CtxCache 上下文注入到 prompt | ✅ 正确 | `_buildToolContext` → `buildToolSystemPrompt() + ctx`；`_buildContext`（getPrompt）注入画像 |
| memberId 列在上下文表格中存在 | ✅ 存在 | `v2-context.js:38` 表头 `| memberId | 姓名 | 角色...`；`:43` `m.member_id \|\| m._id` |

### 2.3 错误处理链路

| 检查项 | 评估 | 证据/说明 |
|--------|------|-----------|
| 前端错误码 → 用户提示映射完整 | ✅ 基本完整 | `errorHandler.ERROR_MAP` 覆盖 400/401/403/404/429/500/NETWORK/TIMEOUT/UNKNOWN |
| 网络超时正确处理 | ✅ 正确 | `_classifyError` 检查 `errMsg`/`errno`（600001=NETWORK, 600002=TIMEOUT） |
| 429 限流正确传播（不重试直接提示） | ⚠️ 部分 | 前端 `errorHandler` 429 单独映射；但 `chat-source` stream 对 429 重试 2 次后才降级（非"不重试"）。后端 `tool-orchestration` 对 429 退避重试 maxAttempts=3。**429 实际会重试**，与清单描述"不重试"不符 |
| ai_empty 处理 | ⚠️ 未映射 | `callChatDirect` 抛 `err.code='ai_empty'`，经 `wrapError` 变 code:500，前端归入 UNKNOWN。对话链路用 callChat 不触发；OCR 场景受影响 |
| ai_format 处理 | ⚠️ 未映射 | 同上，`callChatDirect` 抛 `err.code='ai_format'`，前端归 UNKNOWN |
| 云函数执行失败（SCF）兜底 | ✅ 有兜底 | 后端 `wrapError` 返回 code:500；前端 `apiClient` 归一化；`chat-panel._finalizeConversation` catch 块 `_saveMsg` 兜底落库 |
| 流式中断处理 | ✅ 正确 | `onStopGenerate` 设 `_streamAborted`，`onText` 检测后提前 resolve 保留已生成文本；`handleError` 处理网络波动/服务端关闭 |

### 2.4 重试机制

| 检查项 | 评估 | 证据/说明 |
|--------|------|-----------|
| 前端 apiClient 重试策略 | ✅ 明确 | `callCloud` 默认 retries=1；写操作（create/update/delete/write/record 前缀）强制 retries=0 防双写 |
| AI 请求 maxAttempts=1（不重试） | ❌ 不一致 | 对话 `generateText` 的 `safeCallChat` 无 withRetry 包裹（实质不重试 ✓）；但 `tool-orchestration` 的 function calling 有 `withRetry maxAttempts=3`（429 退避）。**AI 请求存在重试**，与"maxAttempts=1"描述不符 |
| 流式失败自动降级到非流式 | ✅ 正确 | `chat-source.handleError` → `fallback(sp, genHist, userText)` |
| 重试导致重复写入 | ✅ 已规避 | 写操作 retries=0；tool dispatch 在 AI 决策后执行一次不重试；429 退避重试仅针对 AI 调用非 dispatch |
| 失败回流（P2.5）触发与执行 | ✅ 正确 | `tool-orchestration:285` `failedResults.length>0 && !hasPending` → `_reflowWithResults`/safeCallChat 再生成失败提示 |

### 2.5 超时控制

| 检查项 | 评估 | 证据/说明 |
|--------|------|-----------|
| wx.cloud.callFunction 默认超时（30s）足够 | ❌ 不足 | `callCloud` 默认 30000ms。`postProcess` 串行多次 AI 调用+dispatch 易超 30s（见严重问题 #1） |
| 流式输出超时控制（前端/后端） | ✅ 前端有 | `chat-source` 30s 首字超时定时器；后端不参与流式无超时问题 |
| DeepSeek 直连超时（90s）配置 | ❌ 非90s | `callChatDirect` 默认 `timeout=30000`（30s），非 90s；可被 opts.timeoutMs 覆盖 |
| 多图 OCR 批处理超时（90s） | ❌ 非90s | `config.OCR_BATCH_TIMEOUT=55000`（55s），非 90s；且 OCR 不在本次审计链路 |
| 超时后资源清理 | ✅ 清理 | `chat-source` timeoutTimer clearTimeout + push `_timers`；`detached` 清理所有 timer；`ai-client` Promise.race+clearTimeout |

### 2.6 并发控制

| 检查项 | 评估 | 证据/说明 |
|--------|------|-----------|
| 快速连续发送拦截（thinking 守卫） | ✅ 正确 | `onSend` 检查 `this.data.thinking \|\| this._postProcessing`；`onSugTap`/`onRetrySend` 同样检查 |
| 多工具并发调用控制 | ✅ Promise.all | `tool-orchestration:242` `Promise.all(dispatchPromises)` 并发执行；同资源并发写风险低（AI 决策通常不重复） |
| 流式中发新消息处理 | ✅ 拦截 | thinking 守卫在流式期间为 true，拦截新发送 |
| 组件销毁时请求取消 | ⚠️ 部分取消 | `detached` 设 `_disposed`；`chat-source.onText` 检查 `_disposed` 提前 return。但**已发起的 streamText 请求无法真正 abort**（无 abort API），仅停止 UI 更新；postProcess 进行中销毁则 `_finalizeConversation` 检查 `_disposed` 后 return，**但后端请求仍会执行完**（数据会写入，前端不更新 UI） |

### 2.7 数据一致性

| 检查项 | 评估 | 证据/说明 |
|--------|------|-----------|
| 对话消息持久化到 messages 集合 | ✅ 是 | `_writeMessage` → `_dispatch('writeMessage')` → `_callWrite('writeMessage')` → `callSibling('dataWrite')` |
| 持久化时机（流式完成后） | ✅ 正确 | 流式完成后 `_finalizeConversation` 统一写；不在流式中写（避免双写）；`chat-panel:154` 注释明确"由 postProcess 统一写" |
| 持久化失败影响用户体验 | ✅ 不影响 | `_writeMessage` try/catch 返回 false；`_finalizeConversation` catch 块 `_saveMsg` 兜底；返回 `userWritten/assistantWritten` 标志 |
| 工具调用结果回流到对话上下文 | ✅ 正确 | `_reflowWithResults`（v9.3 成功回流）/ P2.5 失败回流；toolResults 以 tool role 消息回流模型再生成 |
| 确认卡片数据流（前端确认 → 后端 updateFactConfidence） | ✅ 正确 | `onSugTap` → `postProcess` CONFIRM 拦截 → `_handleConfirm` → `STRATEGIES.fact_confirm.exec` → `dispatch('updateFactConfidence')` |

### 2.8 安全与合规

| 检查项 | 评估 | 证据/说明 |
|--------|------|-----------|
| openid 每层正确传递和校验 | ✅ 正确 | `exports.main` 从 `cloud.getWXContext()` 取 openid；`callSibling` 自动注入 `_authOpenid`；各 dispatcher 透传 |
| 跨家庭数据访问阻止（familyId+openid 双校验） | ✅ 正确 | `getFamily(db, familyId, openid)` 校验；`_buildToolContext` key=`familyId+':'+openid`；CtxCache 多租户隔离；S3-8 修复 familyId 防 args 覆盖 |
| prompt 注入后端检测 | ✅ 双校验 | 前端 `detectInjection`（chat-panel:145）；后端 `ai-gateway._checkInjection`（guard.detectInjection）双校验 |
| AI 输出过滤敏感信息后展示 | ✅ 正确 | `auditOutput`（禁止承诺+PII 脱敏）+ `checkContentSafe`（内容安全）；postProcess 事后复核覆写 |
| 工具调用权限校验 | ✅ 基本正确 | dispatch 传 openid；底层 dataWrite 网关做 familyId+openid 校验（不在本次审计范围）；S3-8 防 familyId 注入覆盖 |

---

## 3. 严重问题清单

### 🔴 P0-1：postProcess 链路超时风险（数据不一致）

**位置**：`chat-panel._finalizeConversation`（index.js:251）→ `apiClient` → `callCloud`（默认 30s）

**问题**：
- `_finalizeConversation` 调用 `api('conversationAI', payload)` 未传 `opts.timeout`，`callCloud` 默认 30000ms。
- `postProcess` 串行执行：`_buildToolContext`（查 5 集合）→ `safeCallChatWithTools`（AI function calling，5-15s）→ `Promise.all(dispatch)`（跨函数调用，每次 1-3s）→ 可能的 `_reflowWithResults`（又一次 AI 调用，5-15s）。
- 单轮 postProcess 总时长可达 15-35s+，**极易超过前端 30s 超时**。

**影响**：
- 前端超时报错（用户看到"操作超时，请重试"），但后端可能已执行工具并写入数据。
- 用户重试时 `_postProcessing` 守卫已释放（前端超时后 finally 复位），导致**重复发送 → 重复工具执行 → 重复写入**。
- 数据不一致：用户以为失败，实际数据已落库。

**建议**：
- `_finalizeConversation` 显式传 `opts.timeout=60000`（或更高）。
- 或将 postProcess 拆分为"快速返回 + 后台异步执行工具"模式。
- 或前端对 postProcess 超时后查询实际执行结果再决定是否重试。

### 🔴 P0-2：generateText 降级链路前后端超时不匹配

**位置**：`chat-source.fallback` → `apiClient` → `callCloud`（30s）vs 后端 `callChat`（无 timeoutMs，依赖 SDK_TIMEOUT=60s）

**问题**：
- 后端 `_handleGenerateText` 调 `safeCallChat(fullMessages, callChat, ctx, { maxTokens:1200 })`，未传 `timeoutMs`。
- `ai-client.callChat`：`if (!timeoutMs) return callPromise`——**无应用层超时保护**，仅依赖 `tcb.init({ timeout: AI.SDK_TIMEOUT=60000 })`。
- 前端 `callCloud` 30s 先超时，后端 AI 可能 30-60s 才返回。

**影响**：
- 前端报超时降级失败，用户看到错误；后端 AI 实际成功并返回，但结果被前端丢弃。
- 由于 generateText 不写消息（由 postProcess 统一写），降级失败后 `_finalizeConversation` 不触发，**整轮对话丢失**（用户消息和 AI 回复都不落库）。

**建议**：
- 后端 `callChat` 调用显式传 `timeoutMs`（如 25000，留 5s 给网关日志）。
- 前端 fallback 失败时兜底落库（当前 `_finalizeConversation` catch 块有 `_saveMsg`，但 fallback 失败走的是 `chat-source` 内部 catch 返回错误文本，不会触发 `_finalizeConversation` 的 catch）。

### 🟡 P1-1：429 限流重试策略与清单描述不符

**位置**：`chat-source.stream`（429 重试 2 次）、`tool-orchestration`（429 退避 maxAttempts=3）

**问题**：
- 检查清单期望"429 限流正确传播（不重试，直接提示）"。
- 实际：前端 stream 对 429 重试 2 次（指数退避 1s→2s）；后端 tool-orchestration 对 429 退避重试 3 次（2s/4s）。
- 重试本身合理（限流是瞬时的），但与清单描述不一致，且重试会延长用户等待（最多 +6s）。

**影响**：非严重，但需明确策略口径。若成长计划 hy3 限流严格，重试可能加剧限流。

**建议**：明确 429 策略文档化；若坚持不重试，移除 `withRetry` 的 429 退避。

### 🟡 P1-2：ai_empty / ai_format 错误码前端未映射

**位置**：`callChatDirect`（ai-client.js:206-215）→ `wrapError` → 前端 `errorHandler`

**问题**：
- `callChatDirect` 抛 `err.code='ai_empty'`/`'ai_format'`，经后端 `wrapError` 统一变 `code:500`。
- 前端 `errorHandler` 无这两个码的映射，归入 UNKNOWN"操作失败，请重试"。
- 对话链路用 `callChat`（hy3）不触发；但 OCR/提取场景（callChatDirect）受影响，提示不够精准。

**影响**：OCR 场景用户看到通用错误，无法区分"AI 返回空"vs"格式异常"vs"服务异常"。

**建议**：`errorHandler.ERROR_MAP` 增加 `ai_empty`/`ai_format` 映射；或后端 `wrapError` 保留原 code 透传。

### 🟡 P1-3：组件销毁时后端请求未真正取消

**位置**：`chat-panel.detached` → `_disposed=true`

**问题**：
- `detached` 设 `_disposed=true`，前端停止 UI 更新，但**已发起的 streamText 和 postProcess 请求无法 abort**。
- postProcess 进行中销毁：`_finalizeConversation` 检查 `_disposed` 后 return，但**后端请求仍在执行**，工具会写入数据，前端不更新 UI。
- 用户销毁组件后重新进入，可能看到"刚才的操作其实成功了"的历史消息。

**影响**：轻微数据视图不一致（用户预期取消但实际执行完）。

**建议**：可接受（落库数据本身正确）；若需真正取消，需后端支持请求中断（复杂，ROI 低）。

### 🟢 P2-1：sessionId 双重命名易混淆

**位置**：`chat-panel._sessionId`（落库）vs `chat-source.send` 内部 `sessionId`（UI 流隔离）

**问题**：
- `chat-source.send:192` 生成 `sessionId = Date.now()+'_'+Math.random()`，赋给 `component._streamSession`，仅用于 `onText` 中 `component._streamSession !== sessionId` 判断（防过期流式写入新会话 UI）。
- `chat-panel._sessionId`（`s_`+时间戳）传给后端落库。
- 两者用途不同，但都叫 sessionId，命名易混淆。

**影响**：无功能问题，但可读性差，维护易错。

**建议**：`chat-source` 内部变量改名 `streamSeq`/`uiStreamId`，与落库 sessionId 区分。

### 🟢 P2-2：record 模式无频控

**位置**：`_handleRecord`（index.js:263）

**问题**：
- `record` 模式（纯问答落库）不做 `checkRateLimit`，仅 `postProcess` 做。
- 流式直连不经后端 AI，record 只落库，不消耗 AI 资源，不限流合理。
- 但用户快速发纯问答会快速写 messages 集合（无频控），可能产生大量落库请求。

**影响**：低（写库压力通常可承受）；但恶意场景无防护。

**建议**：record 模式加轻量频控（如 10 次/10s），或复用 checkRateLimit。

### 🟢 P2-3：流式直连无后端安全网关（残余风险已接受）

**位置**：`chat-source.stream` → `wx.cloud.extend.AI.streamText`

**问题**：
- 流式直连混元，**不经后端 ai-gateway**（sanitize/injectCheck/rateLimit/contentSafe 均不执行）。
- 前端 `chat-panel.onSend` 做了 sanitize/desensitize/detectInjection；但后端安全网关的 `checkContentSafe`（输入内容安全）未对流式输入执行。
- 输出安全靠 postProcess 事后复核（`checkContentSafe` 覆写），但**违规内容可能已短暂展示**（代码注释明确"残余风险已接受"）。

**影响**：流式期间违规内容可能闪现；事后覆写不能撤销已展示内容。

**建议**：已接受风险，建议持续监控 `agent_logs` 的 `OUTPUT_UNSAFE` 比例。

---

## 4. 改进建议汇总（按优先级）

| 优先级 | 问题 | 建议 |
|--------|------|------|
| P0 | postProcess 超时 | `_finalizeConversation` 显式传 `timeout:60000`；或后端 postProcess 拆分异步 |
| P0 | generateText 超时不匹配 | 后端 `callChat` 显式传 `timeoutMs:25000`；前端 fallback 失败兜底落库 |
| P1 | 429 重试策略 | 明确文档化；或移除 tool-orchestration 的 429 退避（若坚持不重试） |
| P1 | ai_empty/ai_format 未映射 | errorHandler 增加映射；或 wrapError 保留原 code |
| P1 | 销毁未取消请求 | 可接受；或后端支持中断 |
| P2 | sessionId 命名 | chat-source 内部变量改名 |
| P2 | record 无频控 | 加轻量频控 |
| P2 | 流式无后端网关 | 已接受风险，监控 OUTPUT_UNSAFE |

---

## 5. 审计结论

**整体评估**：调用链路设计清晰，分层合理（前端双 adapter + 后端四模式 + 安全网关 + 工具编排策略表）。数据流闭环完整，错误处理覆盖面广，安全合规（openid 隔离、注入双校验、输出审计）到位。

**核心风险集中在超时控制**：
1. `postProcess` 多次串行 AI 调用 + dispatch，总时长易超前端 30s 超时，导致"前端报错、后端成功"的数据不一致。
2. `generateText` 降级链路后端无应用层超时，依赖 SDK 60s，前端 30s 先超时，降级失败时整轮对话丢失。

**其余问题多为命名混淆或策略口径不一致，非功能性缺陷**。建议优先修复 P0 超时问题，其余按优先级排期。

**未审计范围**（需补充）：
- `dataWrite`/`dataQuery` 网关的 familyId+openid 双校验实现（工具权限最终保障）。
- `ocrService` 多图批处理超时（任务清单提及 90s，实际配置 55s）。
- `prompts.js` 的 prompt 注入细节（工具意图标识协议）。
- `history-store.js`/`prompt-cache.js` 的缓存失效策略。
