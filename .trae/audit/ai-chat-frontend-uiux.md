# AI 对话组件 UI/UX 深度审计报告

> 审计范围：`miniprogram/components/chat-panel/*`、`miniprogram/components/markdown-render/*`、`miniprogram/utils/{chat-source,history-store,prompt-cache,md-inline,markers,injection-guard,pii-rules}.js`
> 审计维度：对话交互体验（8 大类检查清单）
> 审计日期：2026-08-09
> 审计方式：静态代码审查，未修改任何代码

---

## 一、消息发送流程

### 1.1 onSend 守卫链是否完整（空文本/thinking/postProcessing/注入检测）？
- **✅ 已覆盖**
- `chat-panel/index.js:139` 一行完成前置守卫：`if (!text || this.data.thinking || this._postProcessing) return false`，覆盖空文本、thinking、postProcessing 三态。
- 注入检测在 sanitize/desensitize 之后执行（`:145`），命中即清空 inputText + Toast + return false。
- 守卫链顺序：trim → 空文本/thinking/postProcessing → sanitize → desensitize → detectInjection，无遗漏。

### 1.2 sanitize → desensitize → detectInjection 三步顺序是否正确？
- **✅ 已覆盖**
- `:144` `text = desensitize(sanitize(text))`，随后 `:145` `detectInjection(text)`。
- 顺序合理：sanitize 先做 NFKC 归一化（全角→半角）和零宽字符清理，使后续 PII 正则与注入正则匹配更稳定；desensitize 在注入检测前脱敏，避免身份证/手机号等被注入规则误伤；detectInjection 最后判定。
- 与后端 guard.js 共用同一规则源（`injection-guard.js` 注释），前后端一致。

### 1.3 发送按钮禁用是否真实（JS 守卫 vs 仅 CSS 视觉禁用）？
- **⚠️ 部分覆盖**
- 组件内部 JS 守卫真实有效（onSend 入口三态检查）。
- 但 chat-panel/index.wxml 中**未见 input 输入框与 send 按钮**，输入区 UI 在父级 FAB 栏。本审计目标文件不含父级实现，无法确认发送按钮的 `disabled` 视觉态是否与 thinking/postProcessing 实时绑定。
- 风险：若父级仅用 CSS 视觉禁用而未绑定 JS 守卫，用户快速连点可能触发多次 onSend（但 onSend 内部守卫会拦截，影响有限）。

### 1.4 FAB 输入框清空时机是否正确（onSend 返回 boolean）？
- **⚠️ 部分覆盖**
- onSend 返回 boolean 设计存在（`:137` 注释明确），供 FAB 决定是否清空。
- 但组件内部在**两条路径上都自行清空了 inputText**：
  - 成功路径 `:155` `setData({ inputText: '' })`
  - 注入拦截路径 `:147` `setData({ inputText: '' })`
- 注入拦截返回 false 时组件内部已清空 inputText，与注释"FAB 决定是否清空"语义冲突：FAB 若依返回值再清空属于二次清空（无害但冗余）；若 FAB 依赖 inputText 同步显示，则注入拦截后输入框已被清空，用户丢失输入且无恢复入口。
- 建议：明确 inputText 的唯一所有者（组件 or FAB），避免双向清空。

### 1.5 预设问题（askPreset）流程是否绕过守卫？
- **✅ 已覆盖（含轻微缺口）**
- askPreset（`:123`）仅设置 inputText 后调用 onSend，onSend 内部执行完整三步安全守卫，**未绕过**。
- 轻微缺口：askPreset 入口仅检查 `this.data.thinking`（`:125`），未检查 `_postProcessing`。若 postProcessing 中调用 askPreset，inputText 被设置为预设问题，但 onSend 会被 `_postProcessing` 守卫拦截，输入框显示预设文本但未发送，用户需手动点发送。影响低（onSend 兜底拦截），但体验上"点了没反应"。

### 1.6 错误消息重试（onRetrySend）是否会丢失用户输入？
- **❌ 缺失（严重问题：重试导致用户消息重复）**
- onRetrySend（`:213`）从错误消息读取 `retryText` 写回 inputText，原文本不丢失。
- 但 onRetrySend **只移除错误消息（assistant）**（`:223` `msgs.slice(0, idx).concat(msgs.slice(idx + 1))`），**未移除原用户消息**。
- 随后 onSend 从 inputText 读取 retryText 并**追加一条新的 user 消息**（`:153` `[...this.data.messages, { role: 'user', content: text }]`）。
- 结果：重试后消息列表出现**两条相同的用户消息**（原 user + 重试 user），视觉混乱且污染上下文。
- 详见严重问题清单 P0-1。

---

## 二、流式输出体验

### 2.1 流式 chunk 拼接是否正确（增量更新 vs 全量替换）？
- **✅ 已覆盖**
- `chat-source.js:154` `fullText += c`（增量拼接内部状态）。
- `:162` `setData({ ['messages[' + lastIdx + '].content']: _fullWidthPunct(displayText) })`（全量替换显示）。
- 拼接逻辑正确，displayText 经 `_maskToolIntent(cleanMarkers(fullText, {partial:true}))` 处理，屏蔽工具标识行。

### 2.2 流式过程中 UI 是否有加载指示（thinking 状态）？
- **✅ 已覆盖**
- onSend `:155` 设置 `thinking: true`。
- chat-source onText 首字时 `:152` `component.setData({ thinking: false })`，三点动画消失。
- WXML `:31-33` 三点动画（thinking-row），仅 thinking 时显示。
- 首字前三点指示，首字后流式文本自指示，状态切换清晰。

### 2.3 流式输出是否可中止？
- **✅ 已覆盖（设计亮点）**
- onStopGenerate（`:206`）设置 `_streamAborted = true` + Toast"已停止生成"。
- chat-source onText（`:140-148`）每帧检查 `_streamAborted`，命中即 resolve 已生成文本（`_extractToolIntent(fullText)`），保留部分输出。
- WXML `:35-38` 流式期间显示"正在生成… 停止"按钮。
- 设计完善：用户可控、部分输出保留、状态正确收尾。

### 2.4 流式过程中滚动锚点是否跟随最新消息？
- **✅ 已覆盖**
- chat-source `_doFlush`（`:92`）每次 content 更新后调用 `component.scrollToBottom()`。
- 节流分支也安排 `_pendingFlush` 调用 scrollToBottom（`:165-172`）。
- scrollToBottom 用 scroll-into-view 锚点（`msg-bottom-anchor`）。

### 2.5 流式渲染节流（80ms）是否合理？是否会导致视觉跳跃？
- **⚠️ 部分覆盖**
- 实际存在**双层节流**：
  - chat-source.js `:159` content 更新节流 **100ms**（非检查清单所述 80ms）
  - markdown-render/index.js `:51` markdown 解析节流 **80ms**
- 叠加效应：content 每 100ms 更新，markdown-render 可能在 content 更新后最多再延迟 80ms 才解析渲染，用户感知延迟最高 ~180ms。
- 在快速流式输出时（如每 50ms 一个 chunk），用户看到的文本可能比实际生成滞后 1-2 帧，存在轻微视觉跳跃。
- 100ms/80ms 单独看合理，但双层叠加未协同优化。

### 2.6 markdown 异步渲染后高度变化是否重算滚动位置？
- **⚠️ 部分覆盖**
- 历史加载后 `_scrollAfterRender`（`:85`）安排 3 次 scrollToBottom（立即/300ms/800ms），覆盖 markdown 异步高度变化。
- 但**流式结束后**（onSend `:181-185` 设置最终 content）**未调用 scrollToBottom**。最后一次 _doFlush 可能对应倒数第二个 chunk，最终 content 比 displayText 多末尾字符 + _fullWidthPunct 转换，markdown-render 可能在 80ms 后才解析最终内容导致高度变化，此时无滚动重算。
- `_finalizeConversation` 中 cleanText 替换（`:257`）也未 scrollToBottom。
- 影响：流式结束后若最后一段含表格/列表等高度变化大的元素，底部可能被遮挡。

---

## 三、历史消息加载

### 3.1 历史加载分页是否正确（loadMore 触发时机）？
- **✅ 已覆盖**
- WXML `:7` scroll-view 配置 `refresher-enabled refresher-threshold="60" bindrefresherrefresh="onPullRefresh"`，下拉触发。
- history-store.js `:41` `limit: 20`，`:44` `params.before = oldestMsgTime` 游标分页。
- 游标取 `raw[raw.length-1].created_at`（最旧，已修复原取 raw[0] 的 bug）✅。
- 首次加载 reverse 转正序（`:68`）✅。

### 3.2 历史加载失败是否有错误反馈？
- **⚠️ 部分覆盖**
- history-store.load catch（`:72`）仅 `console.error`，返回 0。
- onPullRefresh（`:294-296`）`if (count === 0) wx.showToast({ title: '没有更多了' })`。
- **加载失败与无更多数据返回相同的 0**，用户看到"没有更多了"但实际是网络错误，**误导性提示**。
- 无独立的错误反馈 Toast 或重试入口。

### 3.3 历史消息时间格式是否合理（刚刚/X分钟前/HH:mm/昨天/M月D日）？
- **✅ 已覆盖**
- `_fmtTime`（`:53-66`）与 history-store `_fmtTime` 逻辑一致：
  - <1 分钟 → "刚刚"
  - 当天 <60 分钟 → "X分钟前"
  - 当天 ≥60 分钟 → "HH:mm"
  - 昨天 → "昨天 HH:mm"
  - 更早 → "M月D日 HH:mm"
- 格式合理，跨天区分清晰。

### 3.4 切换 familyId 时历史是否正确重置？
- **✅ 已覆盖**
- observers familyId（`:41-50`）：reset historyStore + invalidate promptCache + 新 sessionId + 清空 messages + 重新加载历史。
- 空值守护 `if (!id) return` ✅。

### 3.5 历史加载和流式输出是否会冲突（并发问题）？
- **❌ 缺失（严重问题：familyId 切换时旧流式未中止）**
- familyId observer 重置 historyStore 和 messages，但**未更新 `_streamSession`**（chat-source 的 sessionId），也**未设置 `_streamAborted`**。
- chat-source onText 仅检查 `component._streamSession !== sessionId`（`:161`），而 familyId 切换不改变 _streamSession，旧流式继续认为 session 匹配。
- 结果：切换 familyId 后，旧 family 的流式 onText 仍会 `setData({ ['messages[' + lastIdx + '].content']: ... })`，写入新 family 的 messages 数组（lastIdx 可能越界或写入错误位置）。
- 详见严重问题清单 P0-2。
- 补充：_loadHistory 与 onSend 并发概率低（onSend 守卫 thinking），但 familyId 切换路径明确存在并发窗口。

---

## 四、错误处理与重试

### 4.1 网络错误是否有友好提示？
- **✅ 已覆盖**
- errorHandler.js ERROR_MAP 含 NETWORK/TIMEOUT 映射，tip 友好。
- onSend catch（`:192`）使用 `errorHandler.getErrorInfo(e)`，错误以气泡形式展示（`:198`），含"可点击重试"引导。
- Toast mask:true 防误操作。

### 4.2 流式失败时空 AI 占位消息是否正确替换（F-S3 修复）？
- **✅ 已覆盖**
- onSend catch（`:195-199`）：检查最后一条是否 `role==='assistant' && !content`，是则 slice 替换，否则 concat 追加。
- 注释明确标注 F-S3 修复，避免"空消息+错误消息"双条残留。

### 4.3 错误消息是否保留原文本供重试（retryText）？
- **✅ 已覆盖**
- onSend catch `:198` `retryText: text`（注意：text 已经过 sanitize+desensitize，是脱敏后文本）。
- onRetrySend `:221` 读取 retryText。
- 轻微注意：retryText 是脱敏后文本，重试时 onSend 会再次脱敏（二次脱敏对已脱敏文本通常无副作用，因掩码字符不匹配 PII 正则）。

### 4.4 重试时是否防止重复发送（thinking/postProcessing 守卫）？
- **✅ 已覆盖**
- onRetrySend `:216` `if (this._postProcessing || this.data.thinking) return`，防重入。
- 注释标注 F-S5 修复。

### 4.5 429/超时/服务异常是否区分提示？
- **✅ 已覆盖**
- errorHandler ERROR_MAP：429→"AI服务繁忙，请稍后重试"、500→"服务繁忙，请稍后重试"、TIMEOUT→"操作超时，请重试"、NETWORK→"网络连接失败，请检查网络"。
- chat-source stream（`:108-120`）对 429/超时自动重试 2 次（指数退避 1s→2s），失败后降级 generateText。
- 区分清晰，降级链路完整。

### 4.6 错误码映射是否完整（ai_empty/ai_format/timeout/network/quota）？
- **⚠️ 部分覆盖**
- ERROR_MAP 覆盖 HTTP 标准码（400/401/403/404/429/500）+ NETWORK/TIMEOUT/UNKNOWN。
- **缺失业务码**：`ai_empty`（AI 返回空）、`ai_format`（AI 格式异常）、`quota`（配额用尽）无专项映射。
- `_classifyError`（`:46`）对未识别 code 直接 `return err.code`，ERROR_MAP 无对应项则回退 UNKNOWN（"操作失败，请重试"）。
- 影响：ai_empty/quota 等业务错误统一显示"操作失败"，用户无法区分"AI 没听懂"与"系统故障"。

---

## 五、安全防护

### 5.1 输入注入检测（detectInjection）规则是否充分？
- **⚠️ 部分覆盖**
- injection-guard.js 含 11 条 INJECTION_RULES，覆盖中英文常见注入模式（忽略指令/角色扮演/系统提示词窃取等）。
- confusable 检测（西里尔/希腊字母混淆）+ 零宽字符检测 ✅。
- 缺口：
  - 未覆盖 base64/编码注入（如 `aWdub3JlIGFsbA==`）
  - 未覆盖分段/拼接注入（如"忽"+"略"+"指令"跨行）
  - 未覆盖多语言变体（日文/韩文注入指令）
  - 规则正则未考虑大小写变体的 Unicode 绕过（如全角字母，但 sanitize 的 NFKC 已部分归一化）

### 5.2 PII 脱敏（desensitize）是否覆盖身份证/手机/银行卡？
- **✅ 已覆盖**
- pii-rules.js PII_PATTERNS：
  - 身份证 18 位（保留地区码+出生日期）+ 15 位兜底
  - 手机号（保留前 3 后 4）
  - 银行卡（含分隔符 + 纯数字 16-19 位，排除已匹配的手机号/身份证）
- 脱敏策略合理，正则覆盖主流格式。

### 5.3 sanitize 是否清理危险字符？
- **✅ 已覆盖**
- sanitize：NFKC 归一化 + 零宽字符清理 + 长度截断（16000）+ 去"客户说："前缀。
- 小程序环境非 HTML 渲染，WXML 天然防 XSS，无需 HTML 转义。
- 零宽字符清理覆盖 U+200B-200D/FEFF/00AD/2060-2064。

### 5.4 AI 输出是否也需清理（XSS 防护）？
- **✅ 已覆盖**
- AI 输出经 cleanMarkers（markers.js）清理 `[TOOL:]/[CARD:]/[INTENT]` 标记。
- `_extractToolIntent`（chat-source.js）剥离 `{TOOL_INTENT:...}` 标识行。
- markdown-render 自行解析 markdown 为结构化 nodes（非 HTML 注入），小程序 text/view 组件不执行脚本。
- XSS 防护由小程序框架天然保障 ✅。

### 5.5 确认卡片（低置信度事实）流程是否正确？
- **⚠️ 部分覆盖**
- 代码中存在 `suggestions` 机制（WXML `:18-20` sug-bar + onSugTap `:299`），支持快捷建议点击直通 postProcess。
- 但**未找到"低置信度事实确认卡片"的专门数据结构或流程**（无 confirm/cancel 字段、无置信度阈值判断、无确认卡 UI 组件）。
- suggestions 可能是确认卡的简化实现，但缺少"低置信度触发 → 确认/取消确认 → 数据修正"的完整闭环。

### 5.6 确认/取消确认的数据流是否完整？
- **❌ 缺失（在审计范围内未实现）**
- 无 confirm/cancel 事件处理，无确认状态字段，无取消确认后的数据回滚逻辑。
- 若后端有此能力，前端未对接；若设计上无此需求，标记 N/A。基于检查清单要求，判定缺失。

---

## 六、对话上下文管理

### 6.1 prompt-cache 的 TTL 是否合理？
- **✅ 已覆盖**
- prompt-cache.js `:17` `TTL_MS = 5 * 60 * 1000`（5 分钟）。
- 5 分钟内重复对话命中缓存，避免频繁请求 getPrompt；familyId 切换时 invalidate。
- 合理平衡新鲜度与性能。

### 6.2 上下文截断策略是否合理（防止 token 超限）？
- **⚠️ 部分覆盖**
- onSend `:164` `streamHist = ms.slice(-15)`（最近 15 条），每条 content `substring(0, 1500)` ✅。
- model.streamText `:136` `max_tokens: 1500` ✅。
- **缺口**：`genHist = ms.slice(0, -1)`（`:165`）取除最后一条外的**所有**历史消息，**未截断条数**。降级 generateText 时，若历史很长（如 50 轮），genHist 含 49 条 × 1500 字符 = 73500 字符，可能超出模型 token 上限导致 413/500。
- streamHist 截断 15 条合理，genHist 未截断是隐患。

### 6.3 CtxCache 多租户隔离是否正确？
- **✅ 已覆盖**
- prompt-cache get `:26` 检查 `cached.familyId === familyId`，不匹配则重取。
- familyId observer 调用 invalidate 清空缓存。
- 单例缓存 + familyId 校验，隔离正确。

### 6.4 对话摘要压缩是否实现（长对话 >15 轮）？
- **❌ 缺失**
- 代码中无摘要压缩实现。streamHist 仅 `slice(-15)` 截断，**超过 15 轮的早期消息被直接丢弃**，无摘要注入。
- 影响：长对话场景（>15 轮）AI 丢失早期上下文，可能导致重复提问、遗忘用户信息。
- 建议：超过阈值时调后端生成摘要，作为 system 消息注入 streamHist 头部。

### 6.5 上下文中 memberId 列是否存在（防关联丢失）？
- **⚠️ 部分覆盖**
- 前端 context 来自后端 getPrompt 返回的 `p.context`（onSend `:160`），前端不主动处理 memberId。
- prompt-cache 透传 context，未校验是否含 memberId 列。
- 若后端 context 未包含 memberId，前端无法补偿，关联可能丢失。前端层面无保障，依赖后端正确性。

---

## 七、视觉与交互细节

### 7.1 消息气泡样式是否区分用户/AI/错误？
- **✅ 已覆盖**
- WXSS：
  - `.bubble.user`（`:20`）：accent 背景 + 深色文字 + 右对齐 + 圆角 18/6/18/18
  - `.ai-msg`（`:13`）：无气泡 + 左 border-left 强调 + 平铺
  - `.ai-msg--err`（`:15`）：红色 border-left + red-dim 背景 + 圆角
- 三态视觉区分清晰。注释标注对比度修复（`:19` accent 白字 2.24:1 不达标改深色文字 7.62:1）。

### 7.2 思考中动画是否流畅（三点动画 or spinner）？
- **✅ 已覆盖**
- WXSS `:39-41` 三点 dotBounce 动画 1.4s infinite，nth-child 延迟 0.2s/0.4s 错开。
- dotFadeIn 0.1s 延迟渐入，避免突兀。
- 流畅且符合 AI 对话常见范式。

### 7.3 空态引导是否友好（emptyHints 点击直接发送）？
- **✅ 已覆盖**
- WXML `:10-13` 空态显示 3 个引导芯片（"查看当前家庭的保障情况"等）。
- onEmptyHintTap（`:69`）→ askPreset → 直接触发发送，零跳转。
- 空态条件 `!messages.length && !thinking`，避免处理中显示空态。

### 7.4 消息时间戳显示是否合理？
- **⚠️ 部分覆盖**
- AI 消息：WXML `:21` 显示 time（ai-msg-time 样式，fs-tiny + text-disabled）✅。
- **用户消息**：WXML `:26-28` bubble.user 内仅显示 content，**无时间戳**。
- **错误消息**：WXML `:16-24` 无时间戳（仅重试按钮）。
- 用户消息无时间戳，长对话中用户无法感知自己的发送时间，体验不一致。

### 7.5 长文本是否正确换行（word-break/overflow-wrap）？
- **⚠️ 部分覆盖**
- WXSS `.bubble`（`:18`）有 `word-break:break-word` ✅。
- **`.ai-msg`（`:13`）无显式 word-break**，默认 normal。AI 消息含长 URL 或长英文串时可能溢出容器宽度（虽然 width:100% 有限制，但长 URL 可能撑破布局或无法换行）。
- markdown-render 内部元素（code-block 等）的 overflow 未在本审计 WXSS 中体现（在 markdown-render wxss，未列入目标文件）。

### 7.6 链接点击是否复制到剪贴板（小程序限制）？
- **✅ 已覆盖**
- onLinkTap（`:74-78`）：`wx.setClipboardData` + `wx.showToast({ title: '链接已复制' })`。
- markdown-render onLinkTap（`:295`）triggerEvent 上抛，chat-panel 统一处理。
- 符合小程序无法直接打开外链的限制，复制是合理替代。

---

## 八、组件生命周期

### 8.1 detached 时是否清理定时器和流式 session？
- **✅ 已覆盖**
- detached（`:38`）：`_disposed=true; _streamSession=null; _timers.forEach(clearTimeout); _timers=[]`。
- 流式 session 置空使 onText 后续回调的 sessionId 检查失败而跳过 setData。
- markdown-render detached（`:24`）清理 _parseTimer。
- 清理完整。

### 8.2 _disposed 标记是否在所有异步回调中检查？
- **✅ 已覆盖**
- 全量检查点：
  - onSend catch `:191` `if (this._disposed) return false`
  - onSend try `:175` `if (this._disposed)` 仍调 _finalizeConversation 落库
  - _finalizeConversation `:252` `if (this._disposed) return`
  - _loadHistory `:95` `if (this._disposed || !r) return 0`
  - scrollToBottom `:81` / _scrollAfterRender `:86,89` 检查
  - chat-source onText `:138` `if (component._disposed) return`
  - chat-source handleError `:106` `if (component._disposed) { reject; return }`
  - chat-source _pendingFlush `:166` 检查
- 覆盖全面，无遗漏回调。
- 亮点：disposed 时仍完成 DB 落库（`:176-178`），避免整轮消息丢失。

### 8.3 familyId observer 是否正确处理空值和切换？
- **✅ 已覆盖**
- `:42` `if (!id) return` 处理空值。
- 切换时 reset historyStore + invalidate promptCache + 新 sessionId + 清空 messages + 条件重新加载。
- 唯一缺口：未中止旧流式（见 3.5），但 observer 本身的空值与切换处理正确。

### 8.4 组件复用时状态是否正确重置？
- **⚠️ 部分覆盖**
- created（`:26-30`）初始化 _chatSource/_historyStore/_promptCache。
- attached（`:32-37`）初始化 _timers/_sessionId/_lastReportRefresh/_postProcessing。
- **未在 attached 中初始化**：`_streamAborted`、`_streamSession`、`_disposed`。
  - _streamAborted 在 onSend `:141` 重置，复用时首条消息前为 undefined（falsy），不影响。
  - _streamSession 未初始化，复用时首条 onSend 在 chat-source.send 中赋值，不影响。
  - _disposed 未在 attached 重置，若组件复用（detached 后重新 attached），_disposed 仍为 true，导致所有异步回调跳过。
- 风险：小程序组件复用场景（如页面切换保留组件实例），attached 未重置 _disposed 会导致组件"假死"。
- 建议：attached 中 `this._disposed = false`。

---

## 严重问题清单

### P0（严重，影响功能正确性）

**P0-1：重试导致用户消息重复显示**
- 位置：`chat-panel/index.js` onRetrySend `:213-227` + onSend `:153`
- 现象：onRetrySend 仅移除错误消息（assistant），保留原 user 消息；随后 onSend 从 inputText 追加新 user 消息，导致两条相同 user 消息。
- 影响：视觉混乱、上下文污染（AI 看到两条相同用户消息）、消息计数错误。
- 修复建议：onRetrySend 移除错误消息时同时移除其前一条的 user 消息（即 `slice(0, idx-1).concat(slice(idx+1))`，前提是 idx-1 是 user 消息）；或 onSend 检测末尾已有相同 content 的 user 消息时跳过追加。

**P0-2：切换 familyId 时旧流式未中止，写入新 family 消息**
- 位置：`chat-panel/index.js` observers.familyId `:41-50` + `chat-source.js` onText `:161`
- 现象：familyId observer 重置 messages 但未更新 `_streamSession`、未设 `_streamAborted`；旧流式 onText 的 sessionId 检查仍通过，继续 setData 写入新 family 的 messages 数组（lastIdx 越界或错位）。
- 影响：跨家庭数据串扰、UI 错乱、可能触发 setData 异常。
- 修复建议：familyId observer 中 `this._streamSession = null`（使旧 onText sessionId 检查失败）+ `this._streamAborted = true`（主动中止旧流式 resolve）。

### P1（重要，影响体验与健壮性）

**P1-1：历史加载失败误提示"没有更多了"**
- 位置：`chat-panel/index.js` onPullRefresh `:296` + `history-store.js` load catch `:72`
- 现象：加载失败返回 0，与无更多数据返回值相同，统一显示"没有更多了"。
- 修复建议：history-store load 失败时抛出或返回错误标记，onPullRefresh 区分"无更多"与"加载失败"分别提示。

**P1-2：错误码映射缺少 ai_empty/ai_format/quota 专项**
- 位置：`errorHandler.js` ERROR_MAP `:17-27`
- 现象：业务错误码无专项映射，回退 UNKNOWN"操作失败，请重试"。
- 修复建议：补充 `ai_empty`→"AI 暂时没有理解，请换个问法"、`ai_format`→"回复格式异常，请重试"、`quota`→"AI 额度已用尽"。

**P1-3：长对话无摘要压缩，>15 轮丢失早期上下文**
- 位置：`chat-panel/index.js` onSend `:164` `streamHist = ms.slice(-15)`
- 现象：超过 15 轮直接截断，无摘要注入。
- 修复建议：超过阈值时调后端生成摘要，作为 system 消息注入 streamHist 头部。

**P1-4：流式结束后最终 content 更新未触发 scrollToBottom**
- 位置：`chat-panel/index.js` onSend `:181-185` + _finalizeConversation `:257`
- 现象：流式完成设置最终 content 后无 scrollToBottom，markdown-render 80ms 后解析导致高度变化无重算。
- 修复建议：onSend 成功路径 setData 最终 content 后调用 `_scrollAfterRender()`；_finalizeConversation cleanText 替换后同理。

**P1-5：AI 消息容器缺少 word-break，长 URL/英文可能溢出**
- 位置：`chat-panel/index.wxss` `.ai-msg` `:13`
- 现象：无 word-break/overflow-wrap，长 URL 可能撑破布局。
- 修复建议：`.ai-msg` 添加 `word-break:break-all; overflow-wrap:anywhere;`。

**P1-6：genHist 未截断条数，极端长历史可能 token 超限**
- 位置：`chat-panel/index.js` onSend `:165` `genHist = ms.slice(0, -1)`
- 现象：降级 generateText 时 genHist 含全部历史，仅截断单条 1500 字符，总 token 可能超限。
- 修复建议：`genHist = ms.slice(0, -1).slice(-15)` 与 streamHist 一致截断 15 条。

### P2（次要，优化项）

**P2-1：用户消息不显示时间戳**
- 位置：`chat-panel/index.wxml` `:26-28`
- 现象：仅 AI 消息显示时间，用户消息无时间戳，体验不一致。
- 修复建议：bubble.user 下增加 time 显示。

**P2-2：双层节流（100ms + 80ms）叠加导致流式视觉延迟最高 180ms**
- 位置：`chat-source.js` `:159`（100ms）+ `markdown-render/index.js` `:51`（80ms）
- 修复建议：两层节流对齐为同一值（如均 80ms），或 markdown-render 解析在 content 更新同帧触发。

**P2-3：askPreset 未检查 _postProcessing**
- 位置：`chat-panel/index.js` askPreset `:125`
- 现象：postProcessing 中调用 askPreset，inputText 被设置但 onSend 拦截，"点了没反应"。
- 修复建议：askPreset 入口增加 `if (this._postProcessing) return`。

**P2-4：组件复用时 _disposed 未在 attached 重置**
- 位置：`chat-panel/index.js` attached `:32-37`
- 现象：组件复用（detached 后重新 attached）_disposed 仍为 true，组件假死。
- 修复建议：attached 中 `this._disposed = false`。

**P2-5：注入检测规则未覆盖编码/分段注入**
- 位置：`injection-guard.js` INJECTION_RULES
- 修复建议：补充 base64 检测、跨行拼接检测（可选，视威胁模型）。

---

## 设计亮点

1. **流式中止设计完善（onStopGenerate + _streamAborted）**
   - 用户可控停止、保留已生成部分文本、状态正确收尾 resolve，体验优于多数竞品（多数仅支持等待或刷新）。

2. **F-S3 空占位消息替换修复**
   - 流式失败时精准识别空 AI 占位消息并替换为错误消息，避免"空消息+错误消息"双条残留，细节考究。

3. **双通道架构（A 流式 + B postProcess）职责清晰**
   - 通道 A 纯流式出文本 + 工具意图标识，通道 B 执行工具 + 落库；A 失败降级 generateText，B 失败有兜底落库。架构解耦，故障隔离。

4. **markers.js 单一事实源设计**
   - cleanMarkers 统一清理 `[TOOL:]/[CARD:]/[INTENT]` 标记，流式 partial 模式与落库兜底模式共用一函数，避免规则漂移。

5. **三步安全防护（sanitize → desensitize → detectInjection）**
   - 顺序合理，前后端共用同一规则源（sync-shared.js CONTRACT_FILES 同步），一致性有保障。

6. **_disposed 在全异步回调中检查 + disposed 仍落库**
   - 所有异步回调（onText/handleError/_pendingFlush/_loadHistory/_finalizeConversation）均检查 _disposed；disposed 时仍调 _finalizeConversation 完成 DB 落库，避免整轮消息丢失，责任心强。

7. **429/超时自动重试 + 指数退避降级**
   - chat-source stream 对 429/超时自动重试 2 次（1s→2s），失败后降级 generateText，用户无感知恢复。

8. **历史游标修复（取最旧而非最新）**
   - history-store 注释明确记录原 bug（取 raw[0]=最新导致重复加载 19 条+1 条），修复为取数组末尾=最旧，并 reverse 转正序，可追溯性强。

9. **三点动画 + streaming-row 双重状态指示**
   - thinking 三点（首字前）+ streaming-row"正在生成…停止"（流式中）双态指示，用户始终知道 AI 状态，且提供停止入口。

10. **对比度修复注释可追溯**
    - WXSS `:19` 注释记录 accent 白字 2.24:1 不达标改深色文字 7.62:1，无障碍意识强，决策有据可查。

---

## 审计总结

| 维度 | 覆盖情况 |
|------|----------|
| 消息发送流程 | ⚠️ 5 项 ✅ / 1 项 ⚠️ / 1 项 ❌（重试消息重复） |
| 流式输出体验 | ⚠️ 3 项 ✅ / 3 项 ⚠️（双层节流、结尾滚动） |
| 历史消息加载 | ⚠️ 3 项 ✅ / 1 项 ⚠️（失败误提示）/ 1 项 ❌（并发冲突） |
| 错误处理与重试 | ⚠️ 5 项 ✅ / 1 项 ⚠️（错误码不全） |
| 安全防护 | ⚠️ 3 项 ✅ / 2 项 ⚠️ / 1 项 ❌（确认卡缺失） |
| 对话上下文管理 | ⚠️ 2 项 ✅ / 2 项 ⚠️ / 1 项 ❌（无摘要压缩） |
| 视觉与交互细节 | ⚠️ 4 项 ✅ / 2 项 ⚠️（用户时间戳、word-break） |
| 组件生命周期 | ⚠️ 3 项 ✅ / 1 项 ⚠️（_disposed 重置） |

**整体评价**：组件架构清晰、安全防护与错误处理基础扎实、流式中止与双通道设计是亮点。主要问题集中在**重试消息重复（P0-1）**与**familyId 切换并发（P0-2）**两个功能正确性缺陷，建议优先修复。其次补齐错误码映射、长对话摘要、流式结尾滚动等体验项。

**优先修复顺序**：P0-1 → P0-2 → P1-4 → P1-1 → P1-2 → P1-5 → P1-6 → P1-3 → P2 系列。
