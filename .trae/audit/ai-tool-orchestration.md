# AI 工具编排与副作用深度审计报告

**审计范围**：微信小程序后端 AI 对话工具调用机制（conversationAI + dataWrite + dataQuery）
**审计焦点**：工具编排 + 副作用 + 数据一致性
**审计日期**：2026-08-09
**审计版本**：PROMPT_VERSION v9.3

---

## 一、审计范围与文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `conversationAI/index.js` | 508 | 主入口，模式分发 + postProcess 主流程 |
| `conversationAI/tool-orchestration.js` | 331 | 工具编排内核（裁剪+dispatch+失败回流） |
| `conversationAI/tools.js` | 290 | 14 个工具 schema 单一事实源 |
| `conversationAI/prompts.js` | 100 | BASE/STREAMING/TOOL 三段 prompt |
| `conversationAI/_shared/v2-context.js` | 217 | 5 集合并行查询 + 场景化裁剪 |
| `conversationAI/_shared/familyPortrait.js` | 241 | 扁平 facts → 统一画像 |
| `conversationAI/schema-validate.js` | 51 | L3 参数校验 |
| `conversationAI/ctx-cache.js` | 52 | TTL+LRU 上下文缓存 |
| `conversationAI/tool-summaries.js` | 65 | 工具结果 UI 文案 |
| `conversationAI/confirm-handler.js` | 124 | CONFIRM/KEEP 三分支策略表 |
| `conversationAI/suggestion-builder.js` | 68 | 工具结果 → 确认卡片建议 |
| `conversationAI/_shared/memberRepo.js` | 308 | 成员/财务仓库层 |
| `conversationAI/_shared/cross-fn-call.js` | 103 | 跨云函数调用 seam |
| `conversationAI/_shared/writeSeam.js` | 217 | 写入接缝（_openid+updated_at+钩子） |
| `conversationAI/_shared/guard.js` | 86 | 安全检查 + 限流 + 输出审计 |
| `conversationAI/_shared/injection-guard.js` | 34 | 注入检测规则 |
| `conversationAI/_shared/policy-read.js` | 42 | 保单读取接缝 |
| `conversationAI/_shared/logSeam.js` | 124 | agent_logs + operation_logs |
| `conversationAI/_shared/message-read.js` | 31 | 最近 assistant 消息读取 |
| `conversationAI/policyFactSplitter.js` | 83 | 自由文本保障拆分 |
| `dataWrite/handlers.js` | 60 | 写入聚合入口 |
| `dataWrite/fact-write.js` | 203 | addFact + FACT_STRATEGIES |
| `dataWrite/policy-write.js` | 468 | 保单 CRUD + 现价表 |
| `dataWrite/member-write.js` | 187 | 成员 CRUD |
| `dataWrite/policyToFacts.js` | 81 | 保单 → facts 三元组 |
| `dataWrite/fact-member-sync.js` | 31 | fact → members 反向同步 |
| `dataWrite/policy-locate.js` | 56 | 保单三级定位 |
| `dataQuery/entity-query.js` | 139 | 保单/成员/事实查询 |

---

## 二、检查项逐项评估

### 1. 工具定义完整性

#### 1.1 schema 完整性
14 个工具定义（TOOL_DEFINITIONS）均包含 `type`/`function.name`/`function.description`/`function.parameters`/`function.parameters.required`。✅

#### 1.2 addFact enum 与 FACT_STRATEGIES 对齐
- `tools.js` addFact enum：67 个谓词
- `fact-write.js` FACT_STRATEGIES keys：67 个谓词
- 逐项核对：**完全对齐** ✅
- 注：FACT_STRATEGIES 中 "保单号" 在两个分类注释下出现，但作为 JS 对象 key 唯一，只算一次，与 enum 一致

#### 1.3 工具描述充分性
- `addFact` description 详尽，含 L1/L2 维度引导 ✅
- `upsertMember` 描述"多字段批量"+年龄差≥2岁追问提示 ✅
- `queryMemberProfile` 描述对比 queryFacts 的优势 ✅
- `updatePolicy` 含示例 ✅
- 整体良好

#### 1.4 必填参数标记

| 工具 | schema required | 后端实际必填 | 对齐 |
|------|----------------|-------------|------|
| upsertMember | `['data']` | data（白名单字段） | ✅ |
| updateFinances | `[]` | 至少一个标准字段 | ⚠️ |
| addPolicy | `['product_name','insurance_category','sum_assured','annual_premium','insured_name']` | 同 | ✅ |
| deletePolicy | `[]` | policyId/policy_number/product_name 至少一个 | ❌ M1 |
| addFact | `['subjectName','predicate','objectValue']` | 同 | ✅ |
| triggerAnalysis | `[]` | 无 | ✅ |
| queryPolicies | `[]` | 无 | ✅ |
| queryMembers | `[]` | 无 | ✅ |
| createFamily | `['family_name','members']` | 同 | ✅ |
| deleteMember | `[]` | memberId/memberName 至少一个 | ❌ M1 |
| updatePolicy | `[]` | policyId 等定位 + data | ❌ M1 |
| deleteFact | `['factId']` | factId | ✅ |
| queryFacts | `[]` | 无 | ✅ |
| queryMemberProfile | `[]` | memberId/memberName 至少一个 | ❌ M1 |

#### 1.5 参数类型
均使用正确的 `string`/`number`/`array`/`object`，`addFact.confidence` 为 number，`upsertMember.data.age` 为 number ✅

#### 工具定义完整性 - 问题清单
- **M1**（中）：4 个工具（deletePolicy/deleteMember/updatePolicy/queryMemberProfile）的 `required:[]` 与后端实际必填字段不符，AI 可能产出参数全空的调用，被后端拒绝后才回流，浪费一轮 AI 调用
- **L1**（低）：updateFinances required:[] 但后端 upsertFinances 要求"缺少有效财务字段" → 同 M1 类问题，但影响小（AI 自然会传字段）

---

### 2. 工具路由与分发

#### 2.1 TOOL_DISPATCHERS 覆盖
TOOL_DISPATCHERS 包含 16 个工具（14 对外 + writeMessage 内部 + updateFactConfidence 确认路径）。对照 TOOL_DEFINITIONS 14 个对外工具：**全覆盖** ✅

#### 2.2 dispatch 参数传递

```js
// conversationAI/index.js
async function _dispatch(tool, params, openid) {
  const { familyId, ...args } = params
  const dispatcher = TOOL_DISPATCHERS[tool]
  if (!dispatcher) return { success: false, error: '未注册工具: ' + tool }
  if (tool !== 'createFamily' && !familyId) return { success: false, error: '缺少 familyId' }
  if (dispatcher.needsConfirm && !args.confirmed) {
    const p = dispatcher.pending(args)
    return { code: 409, needsConfirm: true, confirmType: 'delete', ...p }
  }
  return dispatcher.exec({ familyId, args, params, openid })
}
```

逐个 dispatcher 核对 exec 签名：
- upsertMember/updateFinances：进程内 memberRepo（含 confirmOnConflict）✅
- addPolicy/addFact/updateFactConfidence/createFamily/updatePolicy/deleteMember/deletePolicy/deleteFact：经 _callWrite → dataWrite 云函数 ✅
- queryPolicies/queryMembers/queryFacts/queryMemberProfile：经 _callQuery → dataQuery 云函数 ✅
- triggerAnalysis：经 _runReport（fireAndForget）✅
- writeMessage：经 _callWrite（内部）✅

**S3-8 修复确认**：`{ ...args, familyId }` 顺序正确（familyId 在后防 AI 提示注入覆盖）✅

#### 2.3 _callWrite vs _callQuery 路由
- 写工具 → _callWrite（dataWrite 云函数）✅
- 查工具 → _callQuery（dataQuery 云函数）✅
- upsertMember/updateFinances 走进程内 memberRepo（与 dataWrite/handlers.js 的 memberRepo 路径并行存在，前端 agentic 单通道走 dataWrite，后端 postProcess 兜底走进程内）✅

#### 2.4 工具名拼写错误兜底
`if (!dispatcher) return { success: false, error: '未注册工具: ' + tool }` ✅
返回 success:false → P2.5 失败回流让 AI 修正

#### 2.5 未注册工具调用处理
同上 ✅

#### 工具路由与分发 - 问题清单
- **L2**（低）：writeMessage/updateFactConfidence 在 TOOL_DISPATCHERS 但不在 TOOL_DEFINITIONS（设计如此，AI 不会主动调用）✅
- **L3**（低）：_dispatch 在 needsConfirm 路径同步调用 dispatcher.pending(args)，若 args 缺字段，pending 函数有兜底字符串（如 '成员'/'保单 '），不会抛错 ✅

---

### 3. 意图裁剪

#### 3.1 BASE_TOOLS 常驻
```js
const BASE_TOOLS = ['queryPolicies', 'queryMembers', 'queryFacts', 'queryMemberProfile']
```
4 个查询工具常驻 ✅，合理性：查询类无副作用，常驻不增风险。但 queryMemberProfile 与 queryFacts 功能重叠，token 浪费 ⚠️ L4

#### 3.2 INTENT_TOOLS 关键词匹配充分性

| 意图 | 关键词 | 缺失关键词 |
|------|--------|-----------|
| 成员 | 成员/家人/孩子/配偶/老人/父母/加人/添加 | 儿子/女儿/老公/老婆/爸爸/妈妈 |
| 财务 | 收入/支出/负债/财务/年薪/月薪/预算 | — |
| 保单 | 保单/保险/保额/投保/续保/合同/重疾险/医疗险/寿险/意外险 | 年金险/教育金/防癌险/护理险 |
| 事实 | 事实/记一下/记录/注意/患有/过敏/职业/血压/手术/烟酒 | 备注/注： |
| 分析 | 分析/报告/生成/检视/评估 | — |
| 新建 | 新建/创建/新客户/添加家庭 | — |

#### 3.3 无意图命中回退全量
```js
if (extra.size === 0) return defs // 无法判断意图，回退全量保证工具能力不降级
```
✅

#### 3.4 "全部/所有/帮助" 显式回退
```js
if (t.includes('全部') || t.includes('所有') || t.includes('帮助')) return defs
```
✅

#### 3.5 裁剪后工具列表完整性
- BASE_TOOLS + 命中意图工具 ✅
- intentNames 预选（v9.2）：`if (intentNames.length > 0) filteredDefs = intentDefs` — 通道 A 已判定工具必须保留，即使关键词裁剪未命中 ✅

#### 3.6 裁剪逻辑遗漏场景
- "年金险"未命中保单类 → 回退全量兜底 ⚠️ L5
- "加备注"未命中事实类 → 回退全量兜底 ⚠️ L6
- "删除张三"未命中（"删"不在关键词）→ 回退全量兜底 ✅

#### 意图裁剪 - 问题清单
- **L4**（低）：BASE_TOOLS queryMemberProfile 与 queryFacts 功能重叠，token 浪费
- **L5**（低）：INTENT_TOOLS 保单类关键词缺"年金险/教育金/防癌险/护理险"，依赖回退全量兜底
- **L6**（低）：INTENT_TOOLS 事实类关键词缺"备注"
- **L7**（低）：INTENT_TOOLS 成员类关键词缺口语称谓

---

### 4. postProcess 执行链

#### 4.1 function calling 结果解析
```js
for (const tc of phase1.toolCalls) {
  if (tc.type === 'function' && tc.function) {
    const toolName = tc.function.name
    let args = {}
    try { args = JSON.parse(tc.function.arguments || '{}') } catch (_) {}
    ...
  }
}
```
- JSON.parse 容错 ✅
- 跳过非 function 类型 ✅
- 缺失 tc.function 时跳过 ✅

#### 4.2 工具调用顺序（串行 vs 并行）
```js
const dispatchPromises = []
for (const tc of phase1.toolCalls) {
  ...
  dispatchPromises.push(...)
}
toolResults = await Promise.all(dispatchPromises)
```
**并行执行** ⚠️ H1
- 多工具并发可能产生竞态
- "先删后加"等依赖顺序场景可能出错

#### 4.3 工具失败后的回流逻辑（P2.5 失败回流）
```js
if (failedResults.length > 0 && !hasPending) {
  try {
    const toolCallMsgs = ...
    const toolResultMsgs = ...
    const refineMsgs = [...]
    const phase2 = await safeCallChat(refineMsgs, ...)
    if (phase2.text && phase2.text.trim()) cleanText = phase2.text.trim()
  } catch (e) {
    console.warn(...)
  }
}
```
- ✅ 失败回流逻辑存在
- ✅ phase2 失败时回退模板拼接
- ✅ 失败信息经 toolResultMsgs 注入（content: JSON.stringify({ error })）

#### 4.4 needsConfirm（code 409）处理
```js
.then(r => ({ ..., success: !(r && (r.success === false || ((r.code && r.code !== 200) && !r.needsConfirm))), ... }))
```
- ✅ needsConfirm 不计为 success:false

但 hasPending 判定：
```js
const { suggestions, pending_confirms } = buildSuggestions(toolResults)
const hasPending = suggestions.length > 0
```
- ⚠️ M2：buildSuggestions 仅对 upsertMember/addFact/删除类生成 pending_confirms，其他工具返回 needsConfirm 但非 delete 类型时被遗漏

#### 4.5 工具结果回流到 AI
- v9.3 成功回流（_reflowWithResults）：写类工具全部成功时回流 ✅
- v9 失败回流：failedResults.length > 0 时回流 ✅
- 两套回流代码结构重复 ⚠️ M3

#### 4.6 postProcess 最大循环次数
- **关键设计**：postProcess 仅一次 function calling（phase1），失败回流后不再尝试重新调用工具
- ✅ 防无限循环
- ⚠️ L8：AI 无自我修复能力（仅生成失败解释文本），复杂场景（参数微错→AI 修正→重试）无法恢复。设计 trade-off，需文档明示

#### postProcess 执行链 - 问题清单
- **H1**（高）：工具并行执行（Promise.all）无顺序保证，"先删后加"等依赖顺序场景可能出错
- **M2**（中）：buildSuggestions 覆盖不全，其他工具返回 needsConfirm 但非 delete 类型时被遗漏，hasPending=false 走失败回流
- **M3**（中）：_reflowWithResults 与 P2.5 失败回流代码结构重复
- **L8**（低）：postProcess 仅一次 function calling，AI 无自我修复能力

---

### 5. 副作用与数据一致性

#### 5.1 addFact versioned 策略 supersede 旧事实
```js
if (strategy === 'versioned') {
  const whereActive = { family_id: familyId, subject_id: resolvedSubjectId, predicate, status: 'active' }
  if (source !== 'agent_confirmed' && _ && typeof _.neq === 'function') whereActive.source = _.neq('agent_confirmed')
  await ws.silentUpdateWhere('facts', whereActive, { status: 'superseded' })
}
```
- ✅ supersede 旧事实
- ✅ agent_confirmed 防覆盖（5.2b）
- 维度：family_id + subject_id + predicate + status:active ✅
- ⚠️ H2：whereActive 不排除当前 add 的 fact，并发场景下 T2 的 supersede 可能把 T1 刚 add 的 fact 也 supersede 掉

#### 5.2 addFact dedup 策略去重维度
```js
const exists = await db.collection('facts').where({ family_id: familyId, _openid: openid, subject_id: resolvedSubjectId, predicate, object_value: objectValue, status: 'active' }).limit(1).get()
```
维度：family_id + _openid + subject_id + predicate + object_value + status:active ✅

#### 5.3 writePolicy 后自动触发 policyToFacts
```js
if ((resolvedMemberId || resolvedInsuredName) && product_name) {
  const factEvents = policyToFacts(doc, {...})
  await Promise.all(factEvents.map(ev => addFact(db, openid, { familyId, ...ev }).catch(e => console.error(...))))
}
```
- ✅ 自动触发 policyToFacts
- ✅ addFact 失败不阻断入库（catch 兜底）

#### 5.4 deletePolicy 级联 supersede 关联 facts
```js
// 步骤 1：先 supersede facts
await ws.silentUpdateWhere('facts', { subject_type: 'policy', subject_id: pid, status: 'active' }, { status: 'superseded' })
await ws.silentUpdateWhere('facts', { predicate: _.in(['拥有保障', '公司提供保障', '投保']), object_id: pid, status: 'active' }, { status: 'superseded' })
// 步骤 2：软删保单
await ws.silentUpdateDoc('policies', target._id, { status: 'deleted', ... })
```
- ✅ 级联 supersede（policy 节点 + 保障边 + 投保边）
- ✅ 顺序正确（先 facts 后 policies，避免幽灵保单）
- ✅ 包含"投保"谓词

#### 5.5 deleteMember 级联 supersede 正向 + 反向 facts
```js
// 正向：被删成员作为 subject 的事实
await ws.silentUpdateWhere('facts', { subject_type: 'member', subject_id: mid, status: 'active' }, { status: 'superseded' })
// 反向：其他成员指向被删成员的关系边
await ws.silentUpdateWhere('facts', { family_id: familyId, _openid: openid, predicate: _.in(['配偶', '子女', '父母']), object_id: mid, status: 'active' }, { status: 'superseded' })
```
- ✅ 正向 supersede（subject_id=mid）
- ✅ 反向 supersede（关系边 object_id=mid）
- ⚠️ M4：反向仅 supersede 关系类谓词，不 supersede "投保" 边（被删成员作为投保人）
- ⚠️ M4：不处理被删成员作为被保人的保单（保单仍 active 但 facts 中"拥有保障"边已被正向 supersede，画像中不可见 → 数据不一致）

#### 5.6 工具调用幂等性

| 工具 | 幂等性 | 说明 |
|------|--------|------|
| addFact dedup | ✅ | 同值不重复写入 |
| addFact versioned | ⚠️ L9 | 每次写入新 fact_id，旧 supersede；语义等价但 fact_id 变化 |
| writePolicy | ✅ | policy_number 或 product_name+insured_name+policyholder_name 去重 |
| updatePolicy | ⚠️ L9 | 多次相同 patch 仍会写入，触发 addFact versioned supersede 链 |
| deletePolicy | ✅ | 已 deleted 再删返回 deleted:true（locatePolicy excludeDeleted=false） |
| deleteMember | ⚠️ | 已删成员再删返回 404（成员已不在） |
| upsertMember | ✅ | 按 memberId/memberName+role 匹配更新或创建 |

#### 副作用与数据一致性 - 问题清单
- **H2**（高）：addFact versioned 并发 supersede where 条件过宽，并发场景下 T2 的 supersede 可能把 T1 刚 add 的 fact 也 supersede 掉，或导致两条 active fact 并存
- **M4**（中）：deleteMember 级联不完整，不 supersede "投保" 边，不处理被删成员作为被保人的保单
- **L9**（低）：updatePolicy 多次相同 patch 不幂等

---

### 6. 上下文构建

#### 6.1 v2-context 返回契约 {markdown, familyMeta, birthMap, datasets}
```js
return {
  markdown: parts.join('\n\n'),
  familyMeta,
  birthMap,
  datasets: { members, finances }  // tool 场景
}
```
- ✅ 契约完整
- ✅ 所有场景（list/conversation/report/tool/默认）都返回 4 个字段

#### 6.2 成员列表包含 member_id 列
```js
const rows = ['| memberId | 姓名 | 角色 | 年龄 | 性别 | 健康 | 职业 | 个人年收入 |', ...]
rows.push('|' + [m.member_id || m._id, ...].join('|') + '|')
```
✅

#### 6.3 保单列表包含 id 列
_buildToolContext 中：
```js
const pt = buildPolicyTable(policies, { title: '## 保单清单（updatePolicy/deletePolicy 定位用）', columns: AI_LOCATOR_COLUMNS })
```
- 标题暗示"定位用"，AI_LOCATOR_COLUMNS 应包含 id（未读取 policy-table.js 验证）⚠️ L10

#### 6.4 事实列表按维度分组
- v2-context 的 tool/conversation 场景使用 buildPortrait + renderPortraitMarkdown（已按维度分组的画像）✅
- familyPortrait 通过 coverage matrix（STANDARD_COVERAGE 8 维度）+ memberPortraits 按维度组织 ✅

#### 6.5 上下文 token 长度控制
- v2-context **无显式 token 限制** ⚠️ M5
- familyPortrait compact 模式压缩
- 保单列表 limit:50
- queryFacts limit:300
- queryMembers limit:50
- queryMemberProfile facts limit:100, policies limit:20
- 潜在风险：大家庭（多成员/多保单/多事实）的 markdown 可能超模型 token 上限

#### 6.6 CtxCache TTL 和失效策略
```js
const _ctxCache = new CtxCache({ ttlMs: TOOL_CTX_TTL, maxSize: TOOL_CTX_MAX })
// TOOL_CTX_TTL: 5000, TOOL_CTX_MAX: 20
```
- TTL: 5s ✅
- LRU: 20 条 ⚠️ M6（实为 FIFO）
- 失效：`if (toolResults.some(tr => tr.success)) ctxCache.invalidate(familyId + ':' + openid)` ✅
- key: `familyId + ':' + openid` ✅ 防多租户污染

#### 上下文构建 - 问题清单
- **M5**（中）：v2-context 无显式 token 长度控制，大家庭场景可能超限
- **M6**（中）：CtxCache 实为 FIFO 非 LRU，get 命中时不更新 Map 顺序，高频 family 可能因 size 超限被淘汰
- **L10**（低）：AI_LOCATOR_COLUMNS 未在本次审计范围内验证（policy-table.js 未读取）

---

### 7. 错误处理

#### 7.1 工具执行异常捕获
```js
dispatchPromises.push(
  dispatch(toolName, { ...args, familyId }, openid)
    .then(r => ({ ... }))
    .catch(e => ({ toolName, toolCallId: ..., success: false, error: e.message, args }))
)
```
- ✅ dispatch 异常被 catch，转为 success:false 结构化错误
- ✅ 不中断整个对话

#### 7.2 部分工具失败影响
- Promise.all + 每个工具独立 .catch → 部分失败不影响其他 ✅

#### 7.3 错误信息回流给 AI
- P2.5 失败回流：toolResultMsgs 中 `tr.success=false` 时 `content: JSON.stringify({ error: tr.error || '执行失败' })` ✅
- AI 可基于错误信息生成修正建议

#### 7.4 错误日志记录
```js
await logAI(db, {
  ...
  tools: toolResults.map(tr => ({ tool: tr.toolName, success: tr.success, error: tr.error || null, result: tr.result })),
  metrics: { total: Date.now() - t0, toolCount: toolResults.length },
  ...
})
```
- ✅ agent_logs 记录工具结果
- dataWrite 内部 handler 有 logOperation（如 writePolicy 失败时）✅
- ⚠️ L11：conversationAI 的 _dispatch 抛错时不单独写 operation_logs（仅 console.error + agent_logs）

#### 7.5 SCF 超时对工具调用的影响
- conversationAI 默认 SCF 超时（注释提到"conversationAI(30s)"）
- 多工具并发 + 失败回流（phase2 AI 调用）可能逼近超时
- _runReport fireAndForget 设计避免 reportAI 60s 阻塞 conversationAI 30s ✅
- ⚠️ L12：失败回流 phase2 超时时 cleanText 兜底可能不连贯

#### 错误处理 - 问题清单
- **L11**（低）：_dispatch 抛错时不单独写 operation_logs
- **L12**（低）：失败回流 phase2 超时时 cleanText 兜底可能不连贯

---

### 8. 安全与权限

#### 8.1 每个工具调用校验 familyId + openid
- _dispatch: `if (tool !== 'createFamily' && !familyId) return { success: false, error: '缺少 familyId' }` ✅
- 所有 db 查询经 safeQuery（注入 _openid）✅
- 所有 db 写入经 writeSeam（注入 _openid）✅
- getFamily(db, familyId, openid) 校验归属 ✅

#### 8.2 跨家庭数据访问阻止
- safeQuery: `db.collection(collection).where({ ...where, _openid: openid })` ✅
- writeSeam.safeUpdateWhere: `where({ ...where, _openid: openid })` ✅
- writeSeam.safeUpdateDoc: 先校验 _openid 归属 ✅
- writeSeam.safeRemoveDoc: 先校验 _openid 归属 ✅
- ✅ 跨家庭访问被阻止

#### 8.3 工具参数注入检测

| 工具 | 注入检测 | 状态 |
|------|---------|------|
| upsertMember | `detectInjection(v).injected` | ✅ |
| updateFinances | （间接，经 _normalizeFinancePatch 白名单） | ✅ |
| addPolicy | `detectInjection(String(v)).injected`（insured_name/product_name/insurance_category/special_agreement） | ✅ |
| addFact | **未检测** | ❌ H3 |
| deletePolicy | reason 字段未检测 | ⚠️ M7 |
| updatePolicy | data 字段未检测 | ⚠️ M7 |
| deleteMember | 未检测（仅 memberId/memberName） | ⚠️ L13 |
| deleteFact | 未检测 factId 格式 | ⚠️ L14 |
| queryFacts/queryMemberProfile | 未检测（查询类，影响小） | ✅ |

#### 8.4 敏感操作确认
- deleteMember/deletePolicy/deleteFact: `needsConfirm: true` ✅
- upsertMember 矛盾时: `confirmOnConflict: true` → 返回 409 ✅
- addFact 低置信度: `confidence<0.6` → 生成 CONFIRM 卡片 ✅

#### 8.5 批量操作数量限制
- writePoliciesBatch: `if (policies.length > 50) return { code: 400, msg: '单次最多写入 50 条保单' }` ✅
- queryFacts: limit(300) ✅
- queryMembers: limit(50) ✅
- queryMemberProfile: facts limit(100), policies limit(20) ✅
- loadActivePolicies: limit(100) ✅
- ⚠️ L15：对话路径无批量写入限制（AI 理论上可一次发起多个 addFact/addPolicy 并发，但 Promise.all 已限制为单轮工具调用量）

#### 安全与权限 - 问题清单
- **H3**（高）：addFact 工具未对 subjectName/objectValue/reasoning 做注入检测，恶意提示注入内容可能持久化到 facts 集合，被报告 AI 消费时形成持久化注入载体
- **M7**（中）：deletePolicy/updatePolicy 的 reason/data 字段未做注入检测
- **L13**（低）：deleteMember 未检测 memberId/memberName（db 参数化查询，注入风险低）
- **L14**（低）：deleteFact 未校验 factId 格式（注入风险低）
- **L15**（低）：对话路径无显式批量写入限制（依赖 AI 自律）

---

## 三、严重问题清单（按严重程度）

### 高（H）

#### H1 工具并行执行竞态
- **位置**：`tool-orchestration.js` `await Promise.all(dispatchPromises)`
- **问题**：所有工具调用并发执行，无顺序控制。"先删后加"等依赖顺序场景可能出错。如 deletePolicy+addPolicy 同轮调用，add 可能在 delete 之前执行，命中旧保单被去重 skipped
- **影响**：依赖顺序的复合操作数据不一致
- **建议**：按工具依赖关系串行化（如删除类先于写入类），或对同实体操作强制串行

#### H2 addFact versioned 并发 supersede 竞态
- **位置**：`fact-write.js` addFact versioned 分支
- **问题**：并发执行 addFact（同 subject+predicate，不同 objectValue）时，whereActive = { subject_id, predicate, status:active } 不区分 _id：
  - 场景 A：T1 supersede（旧→superseded）→ T1 add（new1）→ T2 supersede（new1→superseded，因 where 包含 new1）→ T2 add（new2），最终只剩 new2（new1 丢失）
  - 场景 B：T1 supersede → T2 supersede（旧已 superseded，0 条）→ T1 add（new1）→ T2 add（new2），最终 new1+new2 并存（应只保留最新）
- **影响**：事实数据不一致，报告 AI 消费错误数据
- **建议**：addFact 内部对同 subject+predicate 加锁（如 db 事务），或 supersede where 排除当前 add 的 _id（需先 add 再 supersede 反向）

#### H3 addFact 未做注入检测
- **位置**：`fact-write.js` addFact
- **问题**：subjectName/objectValue/reasoning 字段未调用 detectInjection。其他写工具（upsertMember/writePolicy/recordField/writeNote）均做了注入检测，addFact 缺失
- **影响**：AI 被提示注入产出恶意内容（如"忽略系统指令"）持久化到 facts 集合，被报告 AI 消费时形成持久化注入载体
- **建议**：addFact 中对 subjectName/objectValue/reasoning 调用 detectInjection，与 upsertMember/writePolicy 对齐

### 中（M）

#### M1 schema required 不完整
- **位置**：`tools.js` deletePolicy/deleteMember/updatePolicy/queryMemberProfile
- **问题**：required:[] 与后端实际必填字段不符。如 deletePolicy 后端要求 policyId/policy_number/product_name 至少一个
- **影响**：AI 产出参数全空的调用，被后端拒绝后才回流，浪费一轮 AI 调用
- **建议**：使用 `anyOf` 或在 description 中明示"至少传 X"

#### M2 buildSuggestions 覆盖不全
- **位置**：`suggestion-builder.js`
- **问题**：仅对 upsertMember（needsConfirm）/addFact（confidence<0.6）/删除类（needsConfirm+confirmType='delete'）生成 pending_confirms。其他工具返回 needsConfirm 但非 delete 类型时被遗漏
- **影响**：hasPending=false 走失败回流，本应走确认卡片路径的工具调用被误判为失败
- **建议**：buildSuggestions 增加 generic needsConfirm 分支，或在 dispatch 层统一标记

#### M3 _reflowWithResults 与 P2.5 失败回流代码重复
- **位置**：`tool-orchestration.js`
- **问题**：_reflowWithResults 函数与 P2.5 失败回流内联代码结构几乎相同（build toolResultMsgs → safeCallChat），维护成本高
- **影响**：修改一处易漏另一处
- **建议**：合并为单一 _reflow(results, mode) 函数，mode 区分成功/失败

#### M4 deleteMember 级联不完整
- **位置**：`member-write.js` deleteMember
- **问题**：仅 supersede 正向 facts（subject_id=mid）+ 反向关系边（predicate in 配偶/子女/父母，object_id=mid）。不 supersede "投保" 边（被删成员作为投保人），不处理被删成员作为被保人的保单
- **影响**：孤儿引用（保单投保人字段指向已删成员），数据不一致（保单仍 active 但画像中不可见）
- **建议**：扩展反向 supersede 谓词列表包含"投保"；考虑保单 member_id=mid 时的处理策略（保单保留但标记成员已删 / 级联软删保单）

#### M5 上下文无 token 长度控制
- **位置**：`v2-context.js`
- **问题**：无显式 token 限制，大家庭场景（多成员/多保单/多事实）markdown 可能超模型 token 上限
- **影响**：AI 调用失败或截断
- **建议**：v2-context 估算 markdown 长度，超阈值时压缩（如 compact 模式 / 截断 facts 列表）

#### M6 CtxCache 实为 FIFO 非 LRU
- **位置**：`ctx-cache.js`
- **问题**：get 命中时不更新 Map 顺序（不重新 set），仅 set 时推到末尾。LRU 语义应是 get 命中也更新顺序
- **影响**：高频 family 可能因 size 超限被淘汰，缓存命中率下降
- **建议**：get 命中时 delete + 重新 set，更新 Map 顺序

#### M7 deletePolicy/updatePolicy reason/data 字段未注入检测
- **位置**：`policy-write.js` deletePolicy（deleted_reason: reason）/updatePolicy（data 字段）
- **问题**：reason 直接存库，data 字段透传到 patch（白名单 POLICY_EDITABLE 但未检测内容）
- **影响**：恶意内容持久化，被读取展示时可能误导
- **建议**：对 reason/data 中的字符串字段调用 detectInjection

### 低（L）

- **L1**（低）：updateFinances required:[] 但后端要求至少一个标准字段（影响小）
- **L4**（低）：BASE_TOOLS queryMemberProfile 与 queryFacts 功能重叠，token 浪费
- **L5**（低）：INTENT_TOOLS 保单类关键词缺"年金险/教育金/防癌险/护理险"
- **L6**（低）：INTENT_TOOLS 事实类关键词缺"备注"
- **L7**（低）：INTENT_TOOLS 成员类关键词缺口语称谓
- **L8**（低）：postProcess 仅一次 function calling，AI 无自我修复能力（设计 trade-off，需文档明示）
- **L9**（低）：updatePolicy 多次相同 patch 不幂等，重复触发 addFact versioned supersede 链
- **L10**（低）：AI_LOCATOR_COLUMNS 未验证（policy-table.js 未读取）
- **L11**（低）：_dispatch 抛错时不单独写 operation_logs
- **L12**（低）：失败回流 phase2 超时时 cleanText 兜底可能不连贯
- **L13**（低）：deleteMember 未检测 memberId/memberName（db 参数化查询，注入风险低）
- **L14**（低）：deleteFact 未校验 factId 格式（注入风险低）
- **L15**（低）：对话路径无显式批量写入限制（依赖 AI 自律）

---

## 四、工具调用流程图（文字描述）

### 4.1 入口分发（conversationAI/index.js main）

```
event → 提取 familyId/mode/_reqId
       → wxContext.OPENID
       → 校验 familyId/openid
       → 按 mode 分发：
          ├─ getPrompt     → _handleGetPrompt
          ├─ generateText  → _handleGenerateText（降级路径，无工具）
          ├─ postProcess   → _handlePostProcess（关键路径）
          └─ record        → _handleRecord（前端 agentic 单通道收尾）
```

### 4.2 postProcess 主流程（conversationAI/index.js _handlePostProcess）

```
1. CONFIRM/KEEP/sug 拦截：
   ├─ 用户输入匹配 {CONFIRM:xxx}/{KEEP:xxx} → 走 _handleConfirm/_handleKeep
   └─ 用户输入匹配最近 assistant 消息的 suggestions → 走对应 CONFIRM/KEEP

2. 频控：checkRateLimit
   └─ 超限 → 写限流提示消息 → 返回

3. 输出审计：auditOutput(text)
   ├─ 检测禁止承诺（FORBIDDEN_CLAIMS）
   └─ PII 脱敏（desensitize）

4. 工具编排（委托 tool-orchestration.orchestrate）：
   ├─ 预构建 tool context → ctxCache
   └─ orchestrate({ familyId, openid, sid, userText, auditText, aText, history, intent,
                    dispatch, ctxCache, toolDefs, toolSummaries, buildToolSystemPrompt })

5. 清理标记：stripToolCardMarkers

6. 内容安全审计：checkContentSafe
   └─ 违规 → 覆写为"回复内容安全审核未通过"

7. 持久化消息：
   ├─ _writeMessage(user, cleanedUserText)
   └─ _writeMessage(assistant, cleanText, suggestions, pending_confirms)

8. 写 agent_logs：logAI（含 tools/metrics）
```

### 4.3 orchestrate 内部流程（tool-orchestration.js）

```
输入：familyId, openid, sid, userText, auditText, aText, history, intent, dispatch, ctxCache, ...

分支 A：intent 带 args（旧协议兼容）
  └─ _dispatchIntentTools：
     ├─ validateArgs（schema 校验）
     ├─ dispatch(toolName, { ...args, familyId }, openid)
     ├─ Promise.all 并发执行
     ├─ 成功时 ctxCache.invalidate
     ├─ buildSuggestions
     └─ 失败时 _reflowWithResults

分支 B：function calling 主链路（intent 仅 name 或为空）
  1. 取 ctxCache 上下文
  2. policyFactSplitter 规则预提取保障（coverageHint）
  3. filterToolDefs 按意图裁剪工具 schema
     ├─ BASE_TOOLS 常驻
     ├─ INTENT_TOOLS 关键词命中追加
     └─ 无命中 → 回退全量
  4. intentNames 预选工具 schema（v9.2，覆盖裁剪）
  5. 构建 toolMessages（system + history≤6 + user + intentHint）
  6. withRetry(safeCallChatWithTools, maxAttempts:3, exponential backoff, retryOn:429)

工具执行阶段：
  for each tc in phase1.toolCalls:
    ├─ 解析 args（JSON.parse 容错）
    ├─ validateArgs（schema 校验）→ 失败 → 结构化错误
    └─ dispatch(toolName, { ...args, familyId }, openid)
       └─ Promise.all 并发执行（H1 风险点）

结果处理阶段：
  ├─ buildSuggestions 生成 pending_confirms
  ├─ ctxCache.invalidate（若有成功）
  └─ cleanText 决策：
     ├─ hasPending → 保留 phase1 文本
     ├─ failedResults.length > 0 → P2.5 失败回流（safeCallChat 重生成）
     ├─ reflowable.length > 0 → _reflowWithResults（v9.3 成功回流）
     └─ 全部成功但无可回流工具 → 保留 aText
```

### 4.4 _dispatch 内部流程（conversationAI/index.js）

```
输入：tool, params, openid
  ├─ 解构 params → { familyId, ...args }
  ├─ 查 TOOL_DISPATCHERS[tool]
  │  └─ 未注册 → return { success: false, error: '未注册工具' }
  ├─ 校验 familyId（createFamily 除外）
  │  └─ 缺失 → return { success: false, error: '缺少 familyId' }
  ├─ needsConfirm 检查：
  │  ├─ 未 confirmed → return { code: 409, needsConfirm: true, ...pending(args) }
  │  └─ confirmed → 走 exec
  └─ dispatcher.exec({ familyId, args, params, openid })

exec 路由：
  ├─ upsertMember/updateFinances → 进程内 memberRepo
  ├─ addPolicy/addFact/updateFactConfidence/createFamily/updatePolicy
  │  deleteMember/deletePolicy/deleteFact → _callWrite（dataWrite 云函数）
  ├─ queryPolicies/queryMembers/queryFacts/queryMemberProfile → _callQuery（dataQuery 云函数）
  ├─ triggerAnalysis → _runReport（fireAndForget）
  └─ writeMessage → _callWrite（内部）
```

### 4.5 _callWrite/_callQuery/_runReport（cross-fn-call.js callSibling）

```
callSibling(cloud, fnName, payload, openid, opts):
  1. 节流检查（throttleMs + throttleState）
     └─ 命中节流 → return { code: 200, data: { skipped: true } }
  2. 注入 _authOpenid + traceId（_reqId）
  3. fireAndForget 模式：
     ├─ true → 不 await，后台 withRetry → return { code: 200, data: { triggered: true } }
     └─ false → await withRetry(cloud.callFunction)
  4. onSuccess 回调（如时间戳回写）
  5. 错误归一化：{ code: 500, msg: label + ' 调用失败' }
```

### 4.6 CONFIRM/KEEP 流程（confirm-handler.js）

```
_handleConfirm(familyId, openid, pendingId, sid, userText):
  1. 读取最近 assistant 消息（getLatestAssistantMsg）
  2. 委托 confirm-handler.handleConfirm
  3. 查找 pending_confirms 中的 pendingId
  4. 按 type 走策略表：
     ├─ fact_confirm → dispatch('updateFactConfidence', { factId, confidence:1, source:'agent_confirmed' })
     ├─ member_confirm → dispatch('upsertMember', { memberName, memberId, data: proposed, confirmed: true })
     └─ delete_confirm → dispatch(pc.toolName, { ...payload, confirmed: true })
  5. ctxCache.invalidate
  6. 写 user 消息 + assistant reply
  7. logAI（action: fact_confirm/member_confirm/delete_confirm）

_handleKeep: 仅写消息 + log，不调 dispatch
```

### 4.7 工具副作用流程（dataWrite）

#### addFact 副作用链
```
addFact(db, openid, event):
  1. 谓词归一化（normalizePredicate）
  2. 主体解析（subjectName → member_id）
  3. 策略判定（FACT_STRATEGIES[predicate] || 'dedup'）
     ├─ dedup：查同值是否存在 → 已存在 return skipped
     └─ versioned：supersede 同 subject+predicate+status:active（H2 风险点）
  4. silentAdd('facts', {...})
  5. triggerHooks（markFamilyMutated + advanceStage）
  6. 反向同步 _syncFactToMember（高置信度 fact → members 表）
```

#### writePolicy 副作用链
```
writePolicy(db, openid, event):
  1. 注入检测（insured_name/product_name/insurance_category/special_agreement）
  2. special_agreement 脱敏（desensitize）
  3. insured_name 解析 member_id（按姓名）
  4. 去重检查：
     ├─ policy_number 主键去重
     └─ product_name+insured_name+policyholder_name 二级去重
  5. silentAdd('policies', doc) 或命中重复 return skipped
  6. policyToFacts 拆分为三元组
     └─ Promise.all addFact（H2 风险点：并发 addFact）
  7. triggerHooks
```

#### deletePolicy 副作用链
```
deletePolicy(db, openid, event):
  1. locatePolicy 三级定位（policyId → policy_number → product_name+insured_name）
  2. 步骤 1：supersede facts（subject_type:policy, subject_id:pid）
  3. 步骤 2：supersede 保障/投保边（predicate in [拥有保障,公司提供保障,投保], object_id:pid）
  4. 步骤 3：软删保单（status:'deleted', deleted_reason）
  5. 步骤 4：addFact 备注（policy_decision）
  6. 步骤 5：清理关联现价表（policy_id 置空）
  注：顺序正确（先 facts 后 policies，避免幽灵保单）
```

#### deleteMember 副作用链
```
deleteMember(db, openid, event):
  1. 定位成员（memberId 优先，memberName 兜底）
  2. silentRemoveDoc('members', target._id)
  3. 正向 supersede facts（subject_type:member, subject_id:mid）
  4. 反向 supersede 关系边（predicate in [配偶,子女,父母], object_id:mid）
     ⚠️ M4：不 supersede "投保" 边
     ⚠️ M4：不处理被删成员作为被保人的保单
  5. triggerHooks
  6. 失败聚合返回 partial（S2-4 修复）
```

---

## 五、关键风险点总结

### 数据一致性风险
1. **H1 + H2 并发竞态**：tool-orchestration 并发 dispatch + addFact versioned supersede where 过宽 → 事实数据不一致
2. **M4 deleteMember 级联不完整**：孤儿引用 + 保单与画像数据不一致

### 安全风险
1. **H3 addFact 注入检测缺失**：持久化提示注入载体，被报告 AI 消费时形成二次注入
2. **M7 reason/data 字段未检测**：恶意内容持久化

### 性能风险
1. **M5 上下文无 token 控制**：大家庭场景可能超限
2. **M6 CtxCache FIFO 而非 LRU**：缓存命中率下降

### 可维护性风险
1. **M3 代码重复**：_reflowWithResults 与 P2.5 失败回流
2. **M1 schema required 不完整**：AI 调用浪费一轮

---

## 六、改进建议优先级

| 优先级 | 问题 | 建议 |
|--------|------|------|
| P0 | H1 工具并行竞态 | 按工具依赖关系串行化（删除类先于写入类） |
| P0 | H2 addFact versioned 并发竞态 | addFact 内部加锁或调整 supersede where 排除当前 _id |
| P0 | H3 addFact 注入检测缺失 | addFact 中对 subjectName/objectValue/reasoning 调用 detectInjection |
| P1 | M4 deleteMember 级联不完整 | 扩展反向 supersede 谓词包含"投保"；考虑保单处理策略 |
| P1 | M2 buildSuggestions 覆盖不全 | 增加 generic needsConfirm 分支 |
| P1 | M7 reason/data 注入检测 | 对 reason/data 字符串字段调用 detectInjection |
| P2 | M1 schema required 不完整 | 使用 anyOf 或 description 明示必填字段 |
| P2 | M5 上下文 token 控制 | v2-context 估算长度，超阈值压缩 |
| P2 | M6 CtxCache LRU 修复 | get 命中时 delete + set 更新顺序 |
| P3 | M3 代码重复 | 合并为单一 _reflow 函数 |
| P3 | L4-L7 关键词补充 | 扩充 INTENT_TOOLS 关键词 |

---

## 七、审计结论

### 整体评价
架构经过多轮审计优化（注释可见"架构审计第 10/12/13/14/15/16/17 轮"），已形成清晰的分层：
- **接缝层**：writeSeam/safeQuery/cross-fn-call/logSeam/message-read/policy-read 统一不变量
- **领域层**：fact-write/policy-write/member-write/entity-query 按领域拆分
- **编排层**：tool-orchestration 独立工具编排内核
- **契约层**：tools.js schema 单一事实源 + tool-summaries UI 文案单一事实源

### 主要优点
1. **_openid 注入不变量**：经 writeSeam/safeQuery 统一，跨家庭访问被有效阻止
2. **needsConfirm 确认机制**：删除类工具强制确认，避免误删
3. **P2.5 失败回流**：工具失败时 AI 可生成解释文本，用户体验优于模板错误
4. **CtxCache 多租户隔离**：key 带 openid 防跨租户污染
5. **S3-8 修复**：familyId 放在 ...args 之后防 AI 提示注入覆盖
6. **5.2b agent_confirmed 防覆盖**：用户确认的事实不被普通事实覆盖

### 主要风险
1. **并发竞态**（H1+H2）：tool-orchestration 并发 dispatch + addFact versioned supersede where 过宽，可能产生数据不一致
2. **注入检测不一致**（H3+M7）：addFact 与 reason/data 字段缺失注入检测，形成持久化注入载体
3. **级联不完整**（M4）：deleteMember 不处理"投保"边与被保人保单

### 建议优先处理
P0 级问题（H1/H2/H3）需立即修复，涉及数据一致性与安全。P1 级问题（M4/M2/M7）建议下个迭代处理。P2/P3 级问题可纳入技术债 backlog。

---

**审计完成**。报告已写入 `c:\Users\lyy\WeChatProjects\miniprogram-1\.trae\audit\ai-tool-orchestration.md`。
