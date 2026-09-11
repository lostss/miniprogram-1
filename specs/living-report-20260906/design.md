# 活报告模型 2026-09-06 — 设计

锚定：`requirements.md`（S0/R1-R5）。本文含技术选型、数据/API 变更、风险与测试。凡标「🔓开放」处需用户确认后方可实现。

## 0. 现状关键事实（设计依据）

| # | 事实 | 位置 |
|---|---|---|
| F1 | reportAI 入口仅消费 `{familyId,_reqId}`，无来源参数；30s CAS（`analysis_lock_at`）+ `last_analysis_at` 节流；readiness BLOCK 先于节流（不烧 token 不占锁） | `reportAI/index.js:37,57-91,183-189` |
| F2 | conversationAI `triggerAnalysis` 已示范跨函数 fire-and-forget 调 reportAI | `conv/index.js:51-64`、`cross-fn-call.js` |
| F3 | 前端四个写完成感知点已齐备：OCR 批 saved / 编辑保存成功 / 对话 hasWrite→reportRefresh / 撤销→reportRefresh | `ocr-flow/index.js:700`、`report/index.js:563`、`chat-panel/index.js:193-201,363`、`undo-handler.js:102` |
| F4 | 前端所有"刷新"均为纯规则重算（`buildReportView`），无 AI 请求、不读 `insight_stale`；"自动介入"当前不存在 | `report-builder.js:22-46` |
| F5 | 客户分享路径纯读，不会误触发分析 | `dataQuery/share.js:71-115` |
| F6 | readiness 现把"家庭年收入缺失且无成员收入"当 BLOCK（后端 422），负债/支出仅 WARN | `readiness.js:59-63` |
| F7 | 规则缺口层已内置降级：寿险/意外依赖 `debt/income`，缺收入→`reliability:'blocked'`（无法计算 + 提示补全年收入），矩阵「待补」格；重疾/医疗等固定阈值恒 `estimated` | `thresholds.js:10-19`、`gap-engine.js:49-56,133-143` |
| F8 | AI 叙事已定性（禁金额/公式），金额由规则层承载；`last_summary` 无页面消费 | `reportAI/prompts.js:154` |
| F9 | 客户版（shared）跳过①家庭结构②家庭财务，隐藏⑦置信度、回本/交费节点，缺口仅 actionable、blocked 行不渲染 | `chapter-builder.js` shared 分支 |

## 1. D1 · 自动介入触发与节流（R2）

### 选型
| 方案 | 结论 |
|---|---|
| A. 后端 `writeSeam` 钩子内 fire-and-forget 调 reportAI | **否决**：侵入全部写路径云函数（10+ 副本都要改要部署）；写路径尾加跨函数调用不可靠（平台可能杀未完成异步）；失败无感知 |
| B. **前端四感知点收敛触发** + reportAI 云侧频率上限（选定） | 感知点已存在（F3），零新增写路径；reportAI 侧做防重入与频率决策，跨会话有效 |
| C. 进场兜底（选定）：owner 打开报告页时若 stale 且超窗 → 补算 | 防"用户批量操作后即离开，分析永不跑" |

### 机制（决策：不设自动频率/日上限，关键信息更新即触发）
- **触发**：report 页新增唯一入口 `_tryAutoAnalysis()`（调用 `reportAI {familyId, source:'auto'}`，不等待返回、`retries:0`、防重入 flag），挂四感知点：`onOcrFlowSaved`（saved，整批一次）、编辑保存成功、`onChatReportRefresh`（对话/撤销 hasWrite，chat-panel 已有 3s 前端防抖合并同批工具）。感知事件本身已是"关键信息更新"粒度（批级/保存级），触发频率天然稀疏。
- **reportAI 侧（`source:'auto'`）**：沿用现有 30s CAS/节流（`analysis_lock_at` + `last_analysis_at`，`REPORT_THROTTLE_MS=30s`）防并发与防连点——**不新增任何频率/日上限**；节流命中快速返回 `throttled:true`（不烧 token），`insight_stale` 保持 true 待下一触发或兜底。每次关键更新事件到达均可触发，是否实际执行由 30s 节流合并。
- `source:'manual'`（现 `generateReport`）语义不变，手动永远可立即触发。
- **进场兜底**：`onShow`/`onLoad`（owner）读 `family.insight_stale`；为 true 且距 `last_analysis_at` > 30s → 自动触发一次。
- **客户打开（isShared）**：不触发（F5 保持不变）；客户版时效标识见 D5。
- 参数：`reportAI` 入口消费 `{familyId, source, _reqId}`，`source` 缺省视为 manual（向后兼容）。

### 成本与观察
- 决策：暂不限制自动次数，关键信息更新即触发（30s CAS 仅防并发/连点）。成本风险由 `agent_logs` 全量审计承载；上线后按月核查单家庭自动频次与 token，若失控再收敛（预留决策点）。

## 2. D2 · readiness 语义改造 + 缺失清单单源（R1/R2/R3/R5-②）

### 语义变化
- **BLOCK 收敛为事实层缺失**：无成员 / 经济支柱缺年龄 / 无有效保单（现状这三类本就事实缺失）。→ 后端 422 仅在此时返回（自动路径也静默跳过，页面由 readiness 展示引导）。
- **财务缺失（家庭年收入缺失且无成员收入）从 BLOCK 降为 `degraded` 档**：非阻断。自动路径放行并产出**定性分析**（D3）；手动路径放行（画像确认仍弹，WARN 不再含收入项）。负债/支出缺失维持 WARN。
- readiness 输出新增：`tier: 'ok'|'degraded'|'blocked'` + **缺失清单**（结构化：`{field, label, impact, fix}`，从现有 dimensions/items 派生）。

### 缺失清单单源链路（R3/R5-② 核心）
`readiness.js`（同步副本随 sync-shared 到前端与各函数）为**唯一事实源** → 三个消费者同源派生：
1. **reportAI 上下文**：`familyPortrait`/report-context 注入 missingFields + tier → prompt 决定定性模式与可追问项候选；
2. **对话钩子**（已实现，`prompts.js` 结尾引导）读同一上下文待补清单，选最影响结论一项；
3. **报告侧待澄清项**（R5 挂载点②）：reportAI 在产出后从缺失清单 + AI 判断生成 `clarifications[]`（≤5 项，每项：问题/为何影响结论/修复入口 type），随响应返回并**落库 `families.pending_clarifications`**（新增 DB 字段，R3 待办状态需跨会话持久；随分析成功覆盖、stale 时不清理）。前端 owner 报告页在分析区尾部渲染（可跳过/已回答项消失——回答经对话或表单补录后 readiness 重算，下一轮分析自然移除）。
- 客户版**不渲染**待澄清项（客户不面对 AI 追问，R4）。

## 3. D3 · 量化降级与定性模式（R1/R5-④）

### 规则层（已具备，F7）
寿险/意外缺收入 → blocked「无法计算」，矩阵「待补」。无需新逻辑。缺口章/矩阵不变。

### 补齐客户版解释（挂载点④）
客户版现 blocked 行直接不渲染（F9），客户困惑"为什么没金额"。补：当报告存在 blocked 缺口时，hero 脚注/缺口区一行**克制中性说明**："完整额度测算需结合家庭收支，可联系服务顾问补充后自动更新"（与 R4 措辞一致，不示弱不泄公式）。

### AI 定性模式（R2 自动放行 degraded 的前提）
- reportAI 上下文：`tier==='degraded'` 时注入 `mode:'qualitative'` + 缺失项清单 → prompt 追加黑名单：**禁止产出**缺口金额、保额目标数字、保费预算/占收入比结论、"预算充裕"类推断；plan 只给配置顺序与险种角色（不含额度）；conclusion 只给结构事实。
- **上下文管道修复**（顺带修抽查缺陷）：保费占收入比缺失时上下文传明确占位 `未计算` 并说明禁用（杜绝 `（-%）` 照抄泄漏）；年固定支出字段显式标注"年"，防月/年口径混淆。
- 定性模式产出仍满足 report-fields 8 字段契约（内容受约束，结构不变）→ 前端渲染无需分支。

## 4. D4 · 前端接入（R5 挂载点①②③④落位 + 治理）

| 项 | 落点 |
|---|---|
| `_tryAutoAnalysis` 收敛 | report 页 methods；防重入 flag；挂 OCR saved / 编辑保存成功 / chat reportRefresh（含撤销） |
| 时效标识（挂载点①） | 页头：`数据更新于 {updated_at}` / `保障分析生成于 {last_analysis_at}`；owner 侧 stale 时显示"数据已更新，分析待刷新"（可点=手动生成）；客户版 share 响应新增透传 `analysisAt` 标量（不删 last_* 前提下暴露生成时间，🔓：share.js 增加一标量字段） |
| `last_summary` 接线 | hero/页头副题：家庭保障结构标签（两版可显） |
| C0 生成入口卡 | 自动介入上线后，owner 未生成态由"分析生成中/待数据"提示替代（readiness 引导补全仍在）；「更新分析」按钮保留 |
| 行动出口 | **职责表（消除"行动被讲三遍"）**：B4 alerts=结论速览第一层；C1-suggestions=行动主叙事（含原因，两版一致）；**客户版移除⑧章**（决策），行动出口唯一化；owner 保留⑧（结构化快捷清单 + 核对口径） |
| 待澄清项（挂载点②） | owner：分析区尾部渲染 `pending_clarifications` |
| 沟通桥引导（挂载点③） | 客户版 footer 水印上新增一行：`本报告将随家庭信息更新自动刷新；可联系您的服务顾问完善` |
| 量化降级说明（挂载点④） | 见 D3 |

## 5. D5 · 数据/API 变更汇总

- `reportAI` 入口：消费 `source`（缺省 manual）。
- `families`：新增 `pending_clarifications`（数组，R3；已确认）。
- `dataQuery/share.js`：getSharedFamily 透传 `analysisAt`（`last_analysis_at` 标量）供客户版时效标识。
- 前端 `apiClient`：`generateReport`（manual）语义不变；自动触发直接 callFunction `reportAI`（source auto，不等）。
- **无新集合、无新组件**（复用 report-markdown / readiness 弹窗 / 对话）。

## 6. 风险与开放项

| 项 | 处置 |
|---|---|
| token 成本 | 已决策：暂不限额、关键更新即触发；agent_logs 全量审计，按月核查频次，失控再收敛 |
| readiness 语义变更回归面 | readiness 副本随 sync-shared 同步前端/conversationAI；对话兜底 422 逻辑与前端弹窗需回归（F6） |
| 定性模式输出质量 | 黑名单+上下文修复双保险；抽查验证 |
| 已确认决策 | pending_clarifications 落库 ✓ / share 透传 analysisAt ✓ / 客户版移除⑧章 ✓ / 不设自动日上限 ✓ |
| 客户版 stale 提示与更新可见性 | 分享实时渲染（R4），客户重开可见新内容；无新实体 |

## 7. 测试策略

- 单测（jest）：readiness 档位（tier/blocked→degraded 迁移）；reportAI 节流决策（auto 60s/manual 30s）；gap blocked 说明文案；prompt 定性模式黑名单（静态断言含禁项）。
- e2e：OCR 入库→stale→自动分析恰一次（60s 内多触发合并）；经济缺失→无金额产出 + 客户版克制说明；补齐收入→自动出现量化；对话补录→clarifications 消失。
- 前端组件：待澄清项渲染/跳过交互；时效标识双态；summary 角标。

## 8. 实施顺序建议

1. reportAI：source 参数 + auto 频率上限 + readiness tier（先改后端语义）
2. reportAI：定性模式 prompt + 上下文管道修复 + clarifications 返回
3. 前端：`_tryAutoAnalysis` 挂点 + 进场兜底 + 时效标识
4. 前端：挂载点②③④ + summary 接线 + C0 调整
5. share.js 透传 analysisAt；回归 readiness/对话
6. 上线观察（agent_logs 成本/频次），失控再收敛自动频次
