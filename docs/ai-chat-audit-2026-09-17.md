# AI 对话全链路审计报告

- **日期**：2026-09-17
- **范围**：chat-panel（前端）→ apiClient/callCloud → conversationAI/index.js（入口/历史注入/消息落库）→ ctx-cache → tool-orchestration.js（DeepSeek function calling 工具循环）→ 工具执行（dataWrite/dataQuery）→ 确认卡（confirm-handler）/撤销（undo-handler）→ 消息落库
- **方法**：前端、后端两个并行深审代理 + 主线程对关键发现逐条行级交叉验证
- **关联文档**：[code-audit-2026-09-15.md](./code-audit-2026-09-15.md)（全项目审计，本文的跨家庭污染 P1-2 等已知问题不重复展开）

## 复核与修复状态（2026-09-17 逐条核验后补记）

**核验结论**：本份行号精度高（抽查 10 条，9 条精确命中）。已修复项与未修复项如下。

| 项 | 状态 | 说明 |
|---|---|---|
| **P1-B1** PII 明文透出 | ✅ 已修（`conversationAI`） | `cleanText = stripToolCardMarkers(audit.text \|\| '').trim()`。`auditOutput` 形状恒为 `{pass, text}`（guard.js L85/L97/L112），故以 `audit.text` 为基是安全的 |
| **P1-B2** 撤销删存量 | ✅ 已修（`conversationAI`） | 快照失败置 `snapshotFailed`，`needSnapshot && snapshotFailed` 时不落 undo。补回归测试（快照成功→有 undo 与 快照失败→无 undo 形成对照） |
| **P1-F1** 下拉刷新索引位移 | ✅ 已修（小程序待发版） | `onPullRefresh` 入口加在途守卫。**选择"阻止翻页"而非"作废请求"**——作废会让 AI 回复白丢 |
| **P1-F2/F3** 收起重展开 / `_postProcessing` 残留 | ✅ 已修（小程序待发版） | 引入请求代数 `_reqGen`：`_loadHistory` 的 `replace` 分支递增，`_isStaleRequest(familyId, gen)` 双重校验。**注意**：仅在列表真被整体替换时递增（不在 `onCollapse` 递增）→ 收起但未重展开时 list 未变，旧 patch 仍有效，回复不丢 |
| **P1-B3** 落库失败被吞 | ✅ 已修（`conversationAI`） | 复核补验了本文缺失的前提：`_dispatch`(L132-143) 三个分支全是 `return {...}`、**不抛错**。修复按**两类失败形状**判定：`callSibling` 归一化的 `{code:500}` **和** dispatch 守卫的 `{success:false,error}`（后者**无 `code` 字段**，只判 code 会漏）。成功形状 `{code:200,msg}`（message-write.js L24） |
| **P1-B4** 60s 超时错位 | 🟡 部分修复（`conversationAI`） | **已做（a）user 消息前置落库**。插入点必须在 `getFamilyHistory` / `_compactHistory` / `_ensureContexts` **之后**——前两者会把本轮提问一并读进「历史」导致 prompt 里重复一次（该依赖在原文 L340 注释"本轮 user 尚未落库"里有记载），`_ensureContexts` 经核实只读家庭档案（families/policies）不读 messages。**未做（b）(c)**：phase1 仍吃 `ai-client` 默认 `timeoutMs=30000`（最坏 30+1.5+30=61.5s 仍可能击穿函数 60s），前端超时仍与函数同为 60s → "前端先放弃 → 用户重试 → 双计费"仍存在。(b) 需先取 `agent_logs` 的对话阶段耗时分布定阈值，不宜拍脑袋收紧 |
| **P1-F4** 会话内新消息不更新缓存 | ✅ 已修（小程序待发版） | 新增 `history-store.invalidate(familyId)`，在 `_postChat` 的 `finally` 调用（一次往返结束即作废快照）。**只在发生过对话往返时作废**——纯浏览会话仍享秒开。补 3 条测试（含 storage 异常降级） |

**补记（2026-09-18）：P1-F1/F2 与 P1-F4 的交互**

本文对 P1-F2 的建议是"请求代数 → 过期即丢弃"，实现后发现一个副作用：服务端虽已落库，但**静默丢弃会让用户
看到自己刚发的消息消失**（视图停在缓存旧快照 / 重载后仍缺本轮对话）。故过期分支不再 `return` 了事，改为调
`_resyncHistory()` 触发一次历史重载让视图追平服务端（收起态、已切家庭不处理，交由各自路径重新 load）。
| **P2-4** 幻觉工具名可达内部 dispatch | ⬜ 未修（定性已修正，见下） | |

**对本文的两处修正**（复核发现）：

1. **P2-4 的定性需限定**：本文说"schema-validate 对未注册工具返回 ok"，暗示是校验漏了。但 `schema-validate.js` L8 注释明确写着
   **"未注册工具不在此拦截（交由 dispatch 策略表拒绝）"**——这是**刻意设计**。真正的问题是**这个委托落空了**：
   `TOOL_DISPATCHERS`（index.js L91-94）里存在内部专用条目 `writeMessage`（注释自述"特殊：内部写消息用…不出现在工具摘要里"），
   而它确实**不在** `tools.js` 的 TOOL_DEFINITIONS 里 → AI 看不到、但 `dispatch` 得到。
   准确定性应为：**AI 白名单与内部 dispatch 表共用同一命名空间、无隔离，设计意图（由 dispatch 表拒绝内部工具）未实现**。
   另：可利用性还取决于 DeepSeek function calling 是否转发未在 schema 中声明的函数名（OpenAI 兼容实现通常服务端会校验拒绝），
   这一环本文未验；但不影响修复结论——隔离本身属于防御纵深。
2. **"已修复（本轮）"一节宜注明是本次审计自己改的代码**（`cursorAdvanced` + `_writeCache(…, oldestCreatedAt)`），
   并据此把 `code-audit-2026-09-15.md` 的 **P1-8 标记为已闭环**——复核 L130-131 确认该条已完整实现。

## 总体结论

链路骨架健康：apiClient 契约、undo TTL/归属校验、跨函数 openid 剥离、消息字段契约前后端一致、ctx-cache LRU 语义均正确。但存在 8 个 P1 功能性缺陷——其中 **PII 脱敏结果被丢弃**（安全）与 **快照失败后撤销删除存量数据**（数据丢失）最严重；前端 4 个 P1 同根（全局布尔守卫 + 索引 patch 无请求代数校验），可一套方案收口。另修复了上轮缓存改动引入的 SWR 游标竞态回归。

---

## P1 — 功能性 Bug（已验证）

### 后端

#### P1-B1 输出审计结果被丢弃，PII 明文透出

- **位置**：`cloudfunctions/conversationAI/index.js` L381-384
- **证据**：

```js
const audit = auditOutput(cleanText)          // audit.text 含拒答替换 + PII 脱敏
cleanText = stripToolCardMarkers(cleanText).trim()  // 继续用原 text
...
auditBlocked: !audit.pass                     // 只回传标志，脱敏文本未应用
```

- **影响**：纯问答走 phase1 直连（不经 gateway 审计）时，回复中的手机号/身份证/收益承诺原样透出并落库。
- **修复**：`cleanText = audit.text`（一行）。

#### P1-B2 快照失败 → 撤销把"存量数据"当"新建"整删（数据丢失级）

- **位置**：`cloudfunctions/conversationAI/tool-orchestration.js` L330-348 + `_shared/memberRepo.js` L336-339
- **证据**：

```js
let before = null
try {
  if (toolName === 'updateFinances') before = await snapshotFinance(db, familyId, openid)
  ...
} catch (e) { console.warn('快照失败(继续执行):', ...) }   // before=null 继续执行
...
const opId = await createUndo(db, { familyId, openid, toolName, args, before, after })
```

restoreFinance 对 `before=null` 按"新建回滚"处理 → `silentRemoveDoc('finances', doc._id)`。
- **触发**：snapshotFinance/snapshotMember 的 safeQuery 抛错（不 catch）+ 用户点撤销。
- **影响**：已存在的财务文档被整删、存量成员被软删。
- **修复**：快照失败时不落 undo 记录（可撤销性是写入的前置条件，而非事后补齐）。

#### P1-B3 消息落库失败被静默吞掉

- **位置**：`cloudfunctions/conversationAI/index.js` L245-246（`_writeMessage`）
- **证据**：`_dispatch('writeMessage', ...)` 经 cross-fn-call 归一化，业务失败返回 `{code:500}` **不抛错**；`_writeMessage` 只 catch throw，`return true` 恒真。
- **影响**：user/assistant/确认卡全部丢失但前端显示正常——历史断档、点确认报"未找到待确认项"（正是 L404 注释要防的场景）。
- **修复**：检查返回 `code !== 200` 时返回 false 并告警。

#### P1-B4 60s 超时预算 vs 落库时序错位（端到端缝隙）

- **位置**：cloudbaserc.json（conversationAI timeout=60）+ chat-panel L174（前端 60s）+ tool-orchestration L167-177（phase1 直连 2 次重试+退避 ≈61.5s 最坏）+ index.js L397-418（落库在整个 orchestrate 之后）
- **影响**：前端请求与云函数同寿命竞速——函数被杀时 user/assistant 均未落库，前端已显示的消息刷新后消失（会话断档），token 已消耗。
- **修复**：user 消息在 orchestrate 前先落库；phase1 传更紧的 `timeoutMs`。

### 前端

#### P1-F1 下拉刷新 × 在途请求索引位移竞态

- **位置**：`miniprogram/components/chat-panel/index.js` L385-391（`onPullRefresh` 无 thinking/_postProcessing 守卫）+ L181（`patch['messages[' + lastIdx + '].content']`）
- **触发链**：AI 请求 60s 在途 → 下拉加载更多前插 K 条 → 索引整体位移 → 旧响应按 `lastIdx` patch 到某条**历史消息**上（内容被覆盖、确认卡/撤销挂错消息），assistant 占位永远空白。
- **修复**：处理中禁用 refresher 并在 `onPullRefresh` 入口 return（一行守卫）。

#### P1-F2 同家庭"收起→重展开"后，在途响应 patch 进已被替换的列表

- **位置**：chat-panel L123（onCollapse 只清 UI 态不清请求）+ L113-119（`_isStaleRequest` 只拦 familyId 变化）+ L158-160（重展开整体 replace messages）
- **影响**：同家庭下旧响应按失效 lastIdx patch（覆盖错误消息或索引越界）。
- **修复**：请求代数（generation）——replace/收起时递增，patch 前校验。

#### P1-F3 `_postProcessing` 残留 → 发送静默失效最长 60s

- **位置**：chat-panel L37（onSend 双守卫）、L123（onCollapse 清 thinking/bProcessing 但不清 `_postProcessing`）、familyId observer 同
- **影响**：旧请求 settle 前，新家庭/重展开后面板 busy=false 按钮可点，但 `onSend` 静默 return false 无任何反馈。
- **修复**：与 P1-F2 同用请求代数替代全局布尔。

#### P1-F4 会话内新消息不更新缓存 → 3min 内重展开"丢"最近消息

- **位置**：`miniprogram/utils/history-store.js` L126-145 + chat-panel L123
- **触发链**：打开 → 聊 N 条 → 收起 → 3 分钟内重展开：缓存命中 replace 为旧快照，刚发的 N 条从界面消失；SWR 后台刷新只写 storage 不刷 UI，本会话不自愈。
- **修复**：`_postChat` 成功后使该 familyId 缓存失效（或 onCollapse 时删除缓存）。

> **P1-F1/F2/F3 同根**：全局布尔守卫 + 索引 patch 无请求代数校验。前次审计的跨家庭污染（chat-panel L162/L168）也属同族，建议一套"请求代数"方案一并收口。

---

## P2 — 隐患

| # | 问题 | 位置 |
|---|------|------|
| 1 | 409 待确认（needsConfirm）也判 success 并 createUndo：未实际写入的操作也渲染撤销按钮、reflow 摘要谎称"已更新" | tool-orchestration.js L338-353 |
| 2 | CONFIRM 无幂等/并发防护：双端/双击并发确认同一 pendingId → 双写（仅靠"新 assistant 消息顶掉 lastMsg"间接失效） | confirm-handler.js L74-93 |
| 3 | phase2 回流 system 提示被 sanitize 截断（MAX_INPUT=16000）：决策用全量档案、落笔用半量；phase1 特意绕开此问题，phase2 没绕 | tool-orchestration.js L249-259 + ai-gateway.js L24-30 |
| 4 | 幻觉工具名可直达内部 writeMessage：schema-validate 对未注册工具返回 ok，AI 可调工具白名单与内部 dispatch 表未隔离，模型伪造工具名可写任意消息污染历史 | schema-validate.js L23-24 + index.js L91-94 |
| 5 | 确认卡点击即清除：CONFIRM 网络失败后卡片已删、错误消息无 retryText，操作不可恢复（后端 pending 仍在且会过期） | chat-panel L298-299、L221-227 |
| 6 | 撤销失败 `undoing:true` 永不回滚：撤销入口永久消失、倒计时冻结 | chat-panel L347-351、L322 |
| 7 | 前端 `_saveMsg` 兜底补写可能双写：连接中断但后端已落库时前端再补一份 user/assistant | chat-panel L240-245 |
| 8 | messages 无上限增长 + `wx:key="index"` + 撤销定时器每秒全列表扫描：长会话卡顿、前插整列表重渲染 | chat-panel L267/L100/L313-331 + index.wxml L15 |

---

## 已修复（本轮，随审计顺带）

**SWR 游标竞态回归**（`utils/history-store.js` L112-114、L157、L183）：上轮"缓存命中恢复游标"改动引入——SWR 后台刷新回写游标时，若用户已下拉翻页（游标走深），游标被重置回浅层 → 下一次"加载更多"重复 prepend 已显示消息。已加 `cursorAdvanced` 标志：`more` 推进后 SWR 不回写内存游标（缓存仍写最新快照），reset 时重置。history-store 测试 5/5 通过。

---

## 检查通过

- **apiClient 契约**：WRITE_ACTIONS 含 conversationAI → retries=0；60s 超时显式传递；ok/code/msg/data 归一化正确
- **callCloud**：超时 Promise.race、retries=0 不重发、错误信息含"超时"可被上层识别
- **WXML 绑定**：确认卡（data-idx/cidx + JS 守卫）、撤销（undoing/ttl 双条件）、重试按钮、thinking 气泡、空态 hints 完整
- **undo-handler**：TTL（expires_at）+ status + openid 归属校验完整；addFact 撤销 supersede 幂等
- **跨函数调用**：`_authOpenid` 剥离 + 后置覆盖；delete 工具 `confirmed` 旁路被 schema 未知字段校验拦截
- **消息字段契约**：writeMessage 的 family_id/suggestions/pending_confirms/undoOps 与前端 history-store 消费一致
- **ctx-cache**：LRU 语义与注释一致；CONFIRM/KEEP/UNDO 正则与 pendingId/opId 字符集匹配

---

## 修复优先级建议

1. **P1-B1（PII 透出）**：一行修复 `cleanText = audit.text`，安全收益最大
2. **P1-B2（undo 删存量数据）**：快照失败不落 undo（数据丢失级）
3. **P1-F1/F2/F3**：请求代数方案一次收口（含前次审计的跨家庭污染）
4. **P1-B3 / P1-B4**：落库检查返回 code；user 消息前置落库
5. **P1-F4**：`_postChat` 成功后失效对应家庭缓存
6. P2 按排期处理（P2-4 工具白名单隔离建议提前——安全类）
