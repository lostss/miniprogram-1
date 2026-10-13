# 保小秘 流程审计报告（业务逻辑 · 穿行测试 · 用户 UX）

- **日期**：2026-09-18
- **审计对象**：当前工作区（未提交，基线 HEAD `fd5e23a`；文中行号对应当前工作区）
- **范围**：登录/首页、OCR 全链路、基础报告、深度分析、AI 对话、编辑保存、分享/客户版、客户管理共 8 条用户流程
- **方法**：
  1. 以 `docs/prd.md` / `CONTEXT.md` / `specs/*` 为业务意图基准，对前端页面/组件 → 云函数 handler → 共享模块 → 读回渲染做静态穿行；
  2. 对高风险分支写一次性 Node 探针复现（不落盘、不改业务代码）；
  3. 与 `docs/code-audit-2026-09-15.md`、`docs/ai-chat-audit-2026-09-17.md` 做增量对比。
- **性质**：只读审计。未修改任何业务代码；本报告为新增文档。

## 0. 验证锚点

| 锚点 | 原始结果 | 结论 |
|---|---|---|
| `node scripts/sync-shared.js --check` | `0 created, 0 updated, 141 unchanged, 0 pruned`；`Contract: ... 13 unchanged` | 主源/副本无漂移 |
| `npx jest --silent` | `Test Suites: 99 passed`；`Tests: 1096 passed` | 现有测试全绿（README 写的 98 suites / 1076 tests 已过时） |
| 探针 1（定性模式 tier） | 后端同数据 `tier=degraded`，前端 `_evalReadiness` 映射后 `tier=ok`，`MISMATCH=true` | 复现 P1-3 |
| 探针 2（OCR 归属过滤） | `searchFamilies` 命中家庭「李姐-转介绍」，经 `c.name===primaryHolder` 过滤后候选数 0 → 默认「新建家庭」 | 复现 P1-1 |
| 探针 3（已到期保单编辑） | 仅改受益人，`validate(policy, {status:到期终止, status_effective_date:空})` → `{ok:false,msg:请填写失效日期}` | 复现 P2-2 |
| 探针 4（部分写入） | `{written:2,total:3}` 走「保存成功」分支，未落库 1 份无任何披露 | 复现 P1-5 |

> 现有测试全绿但上述问题未被拦住：`tests/report-load.test.js` 的 fixture 直接构造 `getFamily` 返回值、缺了真实接口的 `family_income` 兼容字段；`tests/ocr-flow-click-matrix.test.js` 的 `onFailedBack` 用例只断言结果数组清空，未断言清理 `ocrBatch`。

---

## 1. 流程穿行总览

| # | 流程 | 旁路/关键路径 | 穿行结论 |
|---|---|---|---|
| F1 | 冷启动 → 静默登录 → 首页最近客户 | `app._silentLogin` 重试一次 → `listFamilies(limit:3)` → SWR 缓存 → 进入报告 | 主路径通；异常态/缓存清理齐全。401 搜索静默保持旧列表（低危） |
| F2 | OCR：选图 → 上传 → OCR+提取 → 确认卡 → 归属 → 角色 → 批量写 → 跳报告 | `ocrExtract` 合并链路 → `writePoliciesBatch` 五步 → `matchPoliciesToMembers` | 有 3 处断点：P1-1 归属匹配、P1-2 角色新增成员、P1-5 部分失败；另 P2-4 放弃不清理 |
| F3 | 基础报告：getFamily → buildReportView → 7 章/hero/缺口/附录 | `loadFamilyView + policies + cashValues` 并行 → `buildReportView` owner/shared 分支 | 章节、缺口、金额单位、分享视角主逻辑自洽；P1-3 定性披露接线断裂 |
| F4 | 深度分析：readiness → reportAI → 写 last_* → 渲染/自动刷新 | 前端 `_evalReadiness` + 后端 422/节流/CAS → `reportAI` | P1-3 前后端 tier 判定不一致；P2-1 待补全入口死路；P0-2（上轮）80s 超时风险仍在 |
| F5 | AI 对话：chat 单通道 → 工具 → 确认卡/撤销 → 持久化 → 报告联动 | `conversationAI` → `tool-orchestration` → `dataWrite/Query` | P2-5 删除类确认后报告不刷新；上轮 P1-B4 超时预算仍紧；suggestions 无 UI（文档漂移） |
| F6 | 编辑：成员/财务/保单 sheet → 保存 → 本地增量 → 后台校验 | `edit-form` → `saveFamilyPatch/savePolicyData` → `updateFamily/updatePolicy` | P1-4 业务失败当成功；P2-2 到期保单无法编辑 + status 回写；P2-7 并发软删风险 |
| F7 | 分享：owner 生成 token/预览 → 客户打开 token → 脱敏报告 | `shareFamily` → `getSharedFamily` → `buildReportView(view:shared)` | P2-3 客户版客户档案空 + 埋点丢 familyId；P2-6 token 竞态回退路径对客户不可用 |
| F8 | 客户管理：列表/搜索/新建/删除 | `listFamilies/searchFamilies` → `createFamily/deleteFamily` | 主路径通；成员删除后 policies 悬挂（上轮 P1-6 未闭环）；整组覆盖并发风险见 P2-7 |

---
## 2. 缺陷清单

### P1-1 OCR 归属匹配过滤掉「成员名命中」的候选 → 常见场景被强制新建重复家庭

- **置信度**：确定（探针复现）｜**类型**：真实缺陷｜**影响面**：OCR 核心流程 / 客户数据一致性
- **现象**：给已有客户上传配偶/父母为孩子投保的保单时，或客户档案是「李姐-转介绍」这类自定义名时，「选择归属家庭」里找不到目标家庭，默认只能「新建家庭」，同一家庭被拆成多份档案。
- **因果链**：
  1. `cloudfunctions/dataQuery/family-list.js:44-53`：`searchFamilies` 是双路匹配（`family_name` **或成员 `name`**），`_projectFamilyList` 再把 `name` 投影成 `family_name`（:118-119）。
  2. `miniprogram/components/ocr-flow/index.js:486-488`：primaryHolder 取本批保单的 `policyholder_name || insured_name`（配偶投保时=配偶）。
  3. `miniprogram/components/ocr-flow/index.js:508`：`cands = families.filter(c => c.name === primaryHolder)`，只保留家庭名恰好等于本批投保人的候选，成员名命中的家庭被丢弃；匹配页也没有搜索已有客户入口。
  4. 唯一兜底是 `session.getMatchCache(primaryHolder)`（5 分钟 TTL，`session-store.js`），跨会话/换投保人即失效。
- **建议**：候选改为「成员名命中 + 家庭名命中」并给出匹配依据（成员 张三 所在家庭）；提供搜索/全量选择入口，避免只能新建。

### P1-2 角色确认承诺新增的投保人/受益人成员不会创建，且失败静默

- **置信度**：确定｜**类型**：真实缺陷｜**影响面**：家庭成员主数据 / 报告缺口分析
- **现象**：已有家庭上传新保单时，角色卡会列出投保人、被保人、受益人并让用户确认添加；若该人不是被保人（如配偶作为投保人、孩子作为受益人），用户确认后成员并不会被创建，界面也不报错，角色选择被静默丢弃。
- **因果链**：
  1. `miniprogram/components/ocr-flow/index.js:552-561` 汇总 `bloodNames`（primaryHolder + 被保人 + 非身故受益人）；:586-588 对家庭中不存在的人标 `isNew:true`；:612-613 返回 `newRoles`。
  2. `cloudfunctions/_shared/member-matcher.js:35-48`：只在 `name === p.insured_name` 时把名字加入 `unmatchedNames`；:58-81 只对 `unmatchedNames` 创建成员。投保人/受益人最多参与已有成员匹配，永远不会被新建（受益人还要额外带 `beneficiary_birth_date` 才进 names）。
  3. `miniprogram/components/ocr-flow/index.js:455-465`：写库成功后按姓名回查 `fam.members`，找不到就不调用 `saveMemberField`，也没有 else 提示；与 `if (!fam)` 分支的 toast 形成对照。
- **建议**：后端把本批保单涉及且家庭不存在的人（投保人/受益人）一并建档（role 可空），或写入前由前端显式创建；前端回查失败必须提示而不是静默跳过。补「新保单投保人不在成员表 → 角色确认后成员存在」的回归测试。

### P1-3 定性模式常驻披露失效：前端把收入缺失映射成 0，与后端 degraded 判定不一致

- **置信度**：确定（探针 1 复现）｜**类型**：真实缺陷（2026-09-18 新功能的接线缺陷）｜**影响面**：报告可信度/合规披露
- **现象**：家庭年收入未填写时，`reportAI` 以后端 `degraded` 生成定性模式报告（不含缺口金额/回本年限），但报告页头新增的「本报告为定性分析…」披露卡片不会出现，用户无从解释为什么整份报告没有金额。
- **因果链**：
  1. `miniprogram/pages/report/index.js:289-302`：`const income = fin.income != null ? fin.income : family.family_income`，再把 `annual_income:income` 传给 readiness。
  2. `cloudfunctions/dataQuery/family-detail.js:43-48`：真实 `getFamily` 会补 `family.family_income = fs.income || 0`，而 `fs.income` 在无 finances 文档时为 `null`，前端拿到的是 **0**。
  3. `cloudfunctions/_shared/readiness.js:75-78`：`hasFamilyIncome = fin.annual_income != null || fin.income != null`，0 也算已填。
  4. `miniprogram/pages/report/index.js:465`：`qualitativeMode = _evalReadiness(c).tier===degraded && !!view.deep` → 恒为 false。
  5. 探针实测：同一份数据后端 `tier=degraded`、前端 `tier=ok`。
- **建议**：前端映射保留缺失语义（如 `fin.income != null ? fin.income : (family.family_income > 0 ? family.family_income : null)`，或直接把 finance 原始字段传给 readiness）；补「真实 getFamily 形状（`family_income=0` + `financial_snapshot.income=null`）→ qualitativeMode=true」的测试。显式收入 0 与缺失 0 的语义需与后端统一。
### P1-4 编辑保存的业务失败被当成功：不检查 ok:false，本地照常生效并提示「小秘记下了」

- **置信度**：确定｜**类型**：真实缺陷｜**影响面**：成员/财务/保单编辑
- **现象**：例如家庭已在其他设备删除、成员列表被清空、保单标识失效等情况，`updateFamily/updatePolicy` 返回 400/404/500，页面仍弹「小秘记下了」，本地立即重算，随后后台静默刷新再退回旧值——用户以为保存成功，实际未落库。
- **因果链**：
  1. `miniprogram/pages/report/index.js:882-890`：`await savePolicyData(...)` / `await saveFamilyPatch(...)` 均未读返回值，紧接着 `_applyLocalUpdate` + `_applyReportData` + 成功 toast。
  2. `miniprogram/utils/apiClient.js:98-107`：业务失败被归一化为 `{ok:false, code,msg,data}` 并 resolve（只有网络/函数异常才 reject）。
  3. `miniprogram/pages/report/index.js:898`：后台 `_refreshReportSequence` 失败只 `console.error`，不提示。
- **建议**：`const r = await ...; if (!r || !r.ok) { errorHandler.handle(...); return }` 后再做本地增量；补「updatePolicy 返回 404 → 不弹成功、不本地生效」的页面测试。对照：同页 `_changePolicyStatus`（:1016）、`onMemberManageDelete`（:397）都检查了 `r.ok`。

### P1-5 OCR 批量写入部分失败静默：只处理 written=0，2/3 成功即报「保存成功」

- **置信度**：确定（探针 4 复现）｜**类型**：真实缺陷｜**影响面**：OCR 数据完整性
- **现象**：一批 3 份保单，其中 1 份缺被保人/字段校验失败时，后端返回 200 + `written:2,total:3`；前端只判断 `written===0`，于是显示「保存成功 2 份」，未落库的第 3 份既无提示也无法重试；`_showSaved` 随后清空本地批次，数据彻底丢失。
- **因果链**：
  1. `cloudfunctions/dataWrite/policy-write.js:296`：`written: results.filter(r => r.ok).length`，逐条失败写入 `logOperation`（:198-203）但整体仍 200；`tests/writePoliciesBatch.test.js:104` 正是把这个契约固化下来。
  2. `miniprogram/components/ocr-flow/index.js:441-447`：仅 `writtenN===0` 走失败态；`writtenN>0` 时 :470 直接用 written 作为 savedCount。
  3. `miniprogram/components/ocr-flow/index.js:741-746`：`_showSaved` 立即 `_clearBatch()`，失败项无法恢复。
- **建议**：`written < total - dedupSkipped` 时进入部分失败态：展示「已保存 X/共 Y，失败列表 + 重试」，重试只提交失败项；批次保留到全部成功/用户显式放弃。

### P2-1 「去补全」指向的表单缺字段：职业/健康/性别/年保费预算无输入项，且 readiness 计数与清单不一致

- **置信度**：确定（探针 3 附带验证字段集）｜**类型**：真实缺陷｜**影响面**：readiness / 报告待澄清项 UX
- **现象**：报告「完善信息可深化分析」列出「张三缺职业」「张三缺健康信息」「年度保费预算未填写」，点 [去补全] 后分别打开成员/财务编辑 Sheet，但 Sheet 里根本没有这些字段，任务无法完成；readiness 弹层还会出现「N 个建议」但可操作行数少于 N。
- **因果链**：
  1. `cloudfunctions/_shared/readiness.js:61-71`：gender/occupation/health 都 push 进 `missing`，`fix.mode=member`；:93-96 年保费预算 push 进 `missing`，`fix.mode=financials`。
  2. `miniprogram/pages/report/index.wxml:156-160`：`clarifications` 逐条渲染 [去补全]，`onClarifyFix` 按 mode 打开对应 Sheet。
  3. `miniprogram/utils/edit-form.js:33-44` 成员字段仅 `name,birth_date,age,income,role`；:45-58 财务字段仅 `income,debt`（探针输出一致）。
  4. readiness 的 `dimensions` 只把 age 放进 memberItems（:53-58），gender 甚至不在弹层清单里，只体现在 warnings 计数 → 「建议 N」与实际行数不一致。
- **建议**：成员 Sheet 增 `gender（picklist）/occupation/health`，财务 Sheet 增 `annual_premium_budget`；或把 readiness 的 fix 映射到可填报入口。同时让 dimensions 的 items 与 warnings 计数同源。
### P2-2 到期/系统态保单无法正常编辑；仅状态变化才下发 status 的防线因调用方传 null 失效

- **置信度**：确定（探针 3 复现）｜**类型**：真实缺陷｜**影响面**：保单编辑
- **现象**：
  - 系统自动判定的 `expired` 保单（到期终止）只改受益人也会被「请填写失效日期」挡住，而该状态本无 `status_effective_date`；用户被迫填一个与本次编辑无关的日期。
  - `cancelled`（退保）与 `surrendered`（退保）共用同一 label；`buildUpdateData` 设计为仅在状态实际变化时下发，但调用方传 `family=null`，导致每次保存都下发 picker 当前映射值，`cancelled` 可能被静默改写为 `surrendered`。
- **因果链**：
  1. `miniprogram/utils/edit-form.js:80-83` status 字段值来自 `POLICY_STATUS_VALUE_TO_LABEL[p.status]`；:183-185 只要 `vals.status !== 有效` 就强制要求 `status_effective_date`。
  2. `cloudfunctions/_shared/policy-status.js:106-117`：无 status/unknown 才推断，且**不写回 DB**，`expired` 是读取期内存状态，DB 通常没有失效日期。
  3. `miniprogram/pages/report/index.js:882`：`buildUpdateData(policy, vals, null, id)`；`miniprogram/utils/edit-form.js:250-256` 因 `origPolicy` 恒 undefined，`nextStatus` 每次都被写入 `data.status`。
- **建议**：validate 只在「原状态为有效/unknown 且目标为终止类」时要求日期；调用方传 `this._family` 让 `origPolicy` 比较生效；长期应给 `expired/cancelled` 与手动态建立 label→value 唯一反查。

### P2-3 客户版（shared）两类断线：客户档案恒不显示；shared 埋点全部丢 familyId

- **置信度**：确定｜**类型**：真实缺陷 / 未接线｜**影响面**：客户视角、产品指标
- **现象**：设计上客户版应渲染「客户档案」（只保留已确认客观信息、无线索/时间线），实际永远没有这张卡片；`product_report_open` / `product_report_feedback` 在客户版的 `familyId` 恒为空，无法按客户归因触达与反馈。
- **因果链**：
  1. `miniprogram/pages/report/index.js:90-99`：shared 分支设置 `isShared/_clientToken` 后调 `_loadSharedReport`，全流程没有 `setData({familyId})`。
  2. `miniprogram/pages/report/index.js:237-244`：`_loadFacts` 第一行 `if (!cid) return` → shared 直接短路；`report/index.wxml:175` 注释却写「owner 与客户版都渲染」。
  3. `cloudfunctions/dataQuery/share.js:83-104`：`getSharedFamily` 返回 family/policies/cashValues，**不含 facts**；即使补 familyId，`queryFacts`（`entity-query.js:44-50`）按客户 openid 过滤也取不到 owner 的 facts。
  4. `miniprogram/pages/report/index.js:500`：`track(report_open, {view, familyId: this.data.familyId || 空})` → shared 恒空；反馈同理。
- **建议**：`getSharedFamily` 增加按 `buildFactsView(shared:true)` 规则裁剪并脱敏后的 facts 字段，前端 shared 分支写入 familyId（用响应 `_id`）后再 `_loadFacts`；埋点 familyId 随之恢复。补「shared 响应含 facts → 客户档案卡出现且无 lead/时间线」的测试。

### P2-4 失败态「放弃全部」不清理本地 ocrBatch，且可能已建档却声称「不保存任何内容」

- **置信度**：确定｜**类型**：真实缺陷｜**影响面**：OCR 恢复/用户信任
- **现象**：保存失败后点「放弃全部」，结果数组清空、遮罩关闭，但 `wx.getStorageSync(ocrBatch)` 仍在；下次进入首页/报告页 `checkResume` 再次弹「检测到未完成的保单处理…是否继续？」，用户刚放弃的批次又回来了。若失败发生在归属/角色阶段之后，家庭文档和成员其实已经写入，「不保存任何内容」与事实不符。
- **因果链**：
  1. `miniprogram/components/ocr-flow/index.js:717-722` `onFailedBack` 只清 `_procPolicies/_procCash/_procErrors`，**没有** `_clearBatch()`；对照成功（:726-731）、done 放弃（:333-340）、移除最后一项（:361-366）都会清。
  2. `miniprogram/components/ocr-flow/index.js:107-113` `_persistBatch` 在每次识别/编辑后写 `ocrBatch`；:86-100 `checkResume` 据此弹恢复框。
  3. `_doSave` 的归属/角色阶段在写保单**之前**执行：`ocr-flow/index.js:411-431`（新建家庭 `createFamily`、角色字段写回）可能已落库，失败只发生在 `confirmWritePolicies`（:437）。
- **建议**：`onFailedBack` 补 `_clearBatch()` 与 `triggerEvent(discarded)`；文案区分「仅识别结果未保存」与「已建档案需在客户列表查看」，或失败时回滚本次新建的家庭（至少明确告知）。
### P2-5 对话删除类工具确认成功后不触发报告刷新

- **置信度**：确定｜**类型**：真实缺陷｜**影响面**：对话 ↔ 报告一致性
- **现象**：用户说「删除某张保单」并在确认卡点「确认」，小秘回复「已删除保单 X」，但当前报告页不刷新，保障汇总/缺口/附录仍显示这张保单，直到用户手动下拉。
- **因果链**：
  1. `miniprogram/components/chat-panel/index.js:231-235`：`hasWrite` 白名单是 `upsertMember/updateFinances/addPolicy/addFact/updatePolicy`，不含 `deletePolicy/deleteMember/deleteFact`。
  2. `cloudfunctions/conversationAI/confirm-handler.js:88-95`：确认执行后返回 `toolResults:[{tool: pc.toolName...}]`（删除时为 `deletePolicy` 等）。
  3. 因此 `hasWrite || hasReportRefresh` 为假，`_debouncedReportRefresh`（:237-238）不执行；报告页 `onChatReportRefresh`（:953）也就收不到事件。
- **建议**：白名单改为所有成功写操作或按 `success && tool` 的语义判定；补「删除确认后触发 reportRefresh」的测试。

### P2-6 分享 token 竞态/失败回退：客户可能打开一个只对 owner 有效的链接

- **置信度**：高（因果链完整，触发依赖点击时序）｜**类型**：真实缺陷｜**影响面**：分享转化
- **现象**：进入报告页后 `shareFamily` 异步预生成 token；若用户在 token 返回前点「转发报告给客户」（或 token 生成失败），`onShareAppMessage` 回退到 `?familyId=xxx` 旧路径。客户以自己的 openid 打开后，页面按 owner 模式调 `getFamily`，得到 404/401，看到「客户不存在 / 登录异常」，链接完全不可用。
- **因果链**：
  1. `miniprogram/pages/report/index.js:583-596`：`_applyReportData` 之后才 `await ensureShareToken`，token 就绪与否没有反映到分享按钮可用态。
  2. `miniprogram/pages/report/index.js:744-750`：`const token = this._clientToken || this._shareToken || 空; buildSharePath(token, familyId)`。
  3. `miniprogram/utils/report-share.js:24-28`：无 token 时返回 `/pages/report/index?familyId=...`，路径里没有 `share=1`/token；`report/index.js:90-98` 因此不会进入 shared 分支。
- **建议**：token 未就绪时禁用/拦截转发并给「正在准备分享…」反馈；或让 `onShareAppMessage` 支持异步返回配置（基础库支持时）并在 `shareFamily` 完成后启用；回退路径至少补 `share=1` 并展示「链接已失效」而不是 owner 404。

### P2-7（并发风险）成员编辑整组覆盖可能软删对话刚新增的成员

- **置信度**：高（代码因果链成立，触发依赖时序/多端）｜**类型**：真实风险｜**影响面**：成员数据丢失
- **现象**：用户打开成员编辑 Sheet 后，在对话里让小秘新增了一个成员；对话成功会延迟 3s 才触发报告刷新。若在刷新到达前保存成员编辑，编辑请求携带的是旧快照重建的 members 数组，后端会把这个新成员当成「已移除」软删。
- **因果链**：
  1. `miniprogram/utils/edit-form.js:264-281`：member/addMember 模式用 `family.members` 本地快照整组重建 `members`。
  2. `cloudfunctions/dataWrite/family-write.js:118-146`：`_syncMembers` 对「库中存在但不在 incoming 列表」的成员一律 `status:deleted` 软删。
  3. `miniprogram/components/chat-panel/index.js:406-410`：写操作后报告刷新固定 debounce 3s，窗口内本地快照可能已陈旧；多端并发同样触发。
- **建议**：成员编辑改为按 `member_id` 的字段级 patch（updateMember）而非整组覆盖；或 `_syncMembers` 增加版本/基线校验，incoming 缺员时先提示确认。属于上轮 last-writer-wins 模式的系统性问题。

---

## 3. 用户 UX 专项补充

1. **「去补全」任务无法闭环**（见 P2-1）：报告 `pending_clarifications`、readiness 弹层两处入口都指向缺字段的表单，用户点进去只能取消，产生「系统让我补，但补不了」的挫败。
2. **确认卡失败后的「重试」是死按钮**（上轮 P2-5 未闭环）：`chat-panel/index.js:252` 对确认卡动作不写 `retryText`，而 `index.wxml` 对任何 `isError` 都渲染「重试」，点击后 `onRetrySend:395-396` 直接 return，无任何反馈。建议卡片动作失败时保留可重试的指令文本，或隐藏重试按钮。
3. **首页完整度圆环 OCR 后不更新**：`completeness_score` 只在 `updateFamily`（`family-write.js:161-174`）和 `reportAI`（`reportAI/index.js:222`）更新；OCR 批量写入只触发 `markMutated/advanceStage`。用户保存后点「返回首页」，卡片仍无进度圆环，直到打开报告/编辑一次。建议写入链路结束后触发一次轻量完整度重算。
4. **分享链接有效期不可见**：token 7 天有效，owner 端没有任何到期提示，客户过期后只看到「链接已失效」，代理人无法提前重发。
5. **长报告双时间戳**：页头「数据更新于 X」与深度分析区「保障分析生成于 Y」语义已区分，UX 成立；注意定性模式下两处同时出现时不要让用户以为报告已过期。

---

## 4. 与上一轮审计的差异

### 4.1 本轮新增（上轮报告未列）

| ID | 一句话 | 级别 |
|---|---|---|
| P1-1 | OCR 归属匹配过滤掉成员名命中候选，常见场景被迫新建重复家庭 | P1 |
| P1-2 | 角色确认的投保人/受益人成员不创建且静默跳过 | P1 |
| P1-3 | 定性模式披露前端恒不生效（缺失收入被映射为 0） | P1 |
| P1-4 | 编辑保存业务失败被当成功 | P1 |
| P1-5 | OCR 部分写入失败静默（written>0 即成功） | P1 |
| P2-1 | 待补全入口缺字段，任务死路 + readiness 计数不一致 | P2 |
| P2-2 | 到期保单编辑被失效日期卡死；status 恒下发可改写 cancelled | P2 |
| P2-3 | 客户版客户档案恒空 + shared 埋点丢 familyId | P2 |
| P2-4 | 失败态「放弃全部」不清 ocrBatch，且可能已建档 | P2 |
| P2-5 | 对话删除确认后不刷新报告 | P2 |
| P2-6 | 分享 token 竞态回退路径对客户不可用 | P2 |
| P2-7 | 成员整组覆盖可能软删并发新增成员 | P2（风险） |

### 4.2 仍存在的上轮项（本轮抽查/读码确认，未重复展开）

| 上轮 ID | 状态 | 说明 |
|---|---|---|
| P0-1 密钥历史泄漏 | 仍开放（用户决策暂缓） | 仅控制台轮换可解；`cloudbaserc.json` 已 gitignore 但历史/远端可达 |
| P0-2 reportAI 解析失败二次调用 40s×2 > 函数 60s | 仍存在 | `reportAI/index.js` 仍首轮失败后全额重试 |
| P1-B4 对话 60s 超时预算 | 部分修复 | user 消息已前置落库；(b)(c) 未做，phase1 最坏仍约 61.5s |
| P2 删除家庭不清 `chat_history_<familyId>` | 仍存在 | `family-actions.js:58` 只清 3 个 key，聊天 PII 本地残留 |
| P2 成员删除后 policies.member_id 悬挂 | 仍存在 | 报告页删除走 `saveFamilyPatch`（整组覆盖），连 `deleteMember` 的 facts 清理也绕过 |
| P2 reportPdf 孤儿文件 | 仍存在 | 每次生成新文件、无 TTL 清理 |
| P2 reportAI 锁无所有权校验 / 脏值并发路径 | 仍存在 | 迟到请求可删新锁 |
| P2 `linkCashValue` 未纳入写操作重试豁免 | 仍存在（幂等，低危） | `apiClient.js` 白名单只含 `conversationAI` |
| P2 policy-status 到期日当天即 expired / parse-expiry 月份溢出 | 仍存在 | 未在本轮范围动态验证 |
| P2 软删成员挂载保单、重名成员重挂取首个命中 | 仍存在 | 建议排期一并治理 |

### 4.3 已闭环抽查（确认修复有效）

- `updatePolicy` 金额 NaN 兜底（上轮 P1-4）已补，代码与注释一致。
- OCR 纯现价表无家庭分支已 `flow.hide() + _emitBusy()`（上轮 P1-7）。
- history-store 缓存游标恢复 + SWR 竞态 `cursorAdvanced`（上轮 P1-8）已实现并有测试。
- 对话 P1-B1/B2/B3、P1-F1~F4（2026-09-17 审计）在当前代码中均已按报告修复。
- `sync-shared --check` 全绿；`_shared` 主源与 13 个跨树契约副本一致。

---

## 5. 未覆盖 / 存疑

- **真机行为**：`enableAlertBeforeUnload`、scroll-view refresher、`picker` 在低版本基础库的回落、分享 `onShareAppMessage` 异步返回支持情况，均只做代码级推定，未在真机验证。
- **线上数据状态**：未连云环境核对 `policies.status=expired` 存量是否普遍缺 `status_effective_date`、agents 历史 `_openid` 修复后的实际登录情况；P2-2 的触发面需线上抽样确认。
- **模糊成员匹配风险（线索）**：`member-matcher._tryMatch` 会对包含关系且唯一的名字做模糊匹配（张三丰 ↔ 张三）。目前只有单测覆盖纯函数，未评估 OCR 异名场景的误挂概率；建议加低置信匹配需人工确认。
- **对话重试重复落库（线索）**：`chat-panel.onRetrySend` 会先删本地错误轮再重发，但服务端 user 消息可能已前置落库（P1-B4 修复后），历史里可能出现两条相同提问；需要产品确认是否接受。
- **产品指标口径**：`report_share` 在分享面板取消时可能也算分子；`product_report_open` 每页面生命周期只报一次，7 日回访按页面实例统计，需与指标定义对齐。
- **产品条款主数据**：`products` 仍无应用侧消费端（PRD 已标 ⏳），本轮未纳入流程。

---

## 6. 建议优先级

1. **今天（小改动，收益最大）**
   - P1-3：修正 `_evalReadiness` 的收入缺失语义；用真实 getFamily 形状补测试。
   - P1-4：`onSaveEdit` 检查 `savePolicyData/saveFamilyPatch` 的 `ok`。
   - P1-5：`written < total - dedupSkipped` 走部分失败态；批次保留失败项。
   - P2-4：`onFailedBack` 补 `_clearBatch()`。
   - P2-5：对话写工具刷新白名单补 `delete*`。
2. **本周（核心流程）**
   - P1-1：归属候选改为成员名/家庭名双命中 + 可搜索全量客户。
   - P1-2：非被保人成员建档 + 角色回写失败可见。
   - P2-2：状态 validate 收敛到原有效→终止类；修复 `family=null` 调用。
   - P2-1：补齐编辑 Sheet 字段（gender/occupation/health/annual_premium_budget）。
3. **随后**
   - P2-3：shared 契约加 facts + familyId 接线；P2-6 分享按钮与 token 就绪联动；P2-7 成员写改字段级 patch。
   - 上轮开放风险：密钥轮换（用户决策）、reportAI 重试时限、phase1 超时预算、锁所有权、member_id 悬挂、reportPdf 清理、本地聊天缓存清理。
4. **机制建议**：把文档定义的用户流程固化成穿行测试清单（本报告第 1 节 8 条），例如在 `tests/walkthrough-e2e.test.js` 之外补产品级 UI 契约用例；报告类测试 fixture 一律经 `dataQuery` 真实响应形状构造，避免再出现 P1-3 这种「测试绿、线上死」的接线缺陷。

---

> 附：本轮探针均为一次性 `node -e` 执行，未新增/修改仓库文件；本报告为唯一落盘产物。