# 实施计划 — 活报告模型 2026-09-06

锚定：`requirements.md`（S0/R1-R5）+ `design.md`（D1-D5，四项决策已确认）。工程约束：`_shared/*` 只改主源 `cloudfunctions/_shared/*` → `node scripts/sync-shared.js` → 部署消费方；禁改函数副本。

## A. 后端 · readiness 与 reportAI

- [x] 1. readiness 语义改造（主源 + 前端副本，sync 完成；tier/degraded/missing；既有测试更新全绿）
  - BLOCK 收敛为事实层：无成员 / 经济支柱缺年龄 / 无有效保单；家庭年收入缺失从 BLOCK 降为 `degraded`（输出 `tier:'ok'|'degraded'|'blocked'`）
  - 由现有 dimensions/items 派生结构化**缺失清单** `{field,label,impact,fix}`（供 AI 上下文/对话钩子/待澄清项同源消费）
  - 存量行为影响标注：对话端 422 兜底与前端 readiness 弹窗的触发条件随之变化
  - _Requirement: R1/R2/R3

- [x] 2. reportAI 入口：`source` 参数 + auto 语义（source 缺省=manual；auto blocked 静默 200/skipped；degraded 放行；30s CAS 沿用）
  - _Requirement: R2

- [x] 3. reportAI 定性模式：上下文 + prompt（mode 注入/黑名单/预算框架条件；占收入比与年支出口径修复；单测同步全绿）
  - report-context/familyPortrait 注入 `tier` 与缺失清单；`degraded` 时注入 `mode:'qualitative'`
  - `prompts.js` 追加定性模式黑名单：禁缺口金额/保额目标数字/预算与占收入比结论/"预算充裕"类推断；plan 只给配置顺序与险种角色；conclusion 只给结构事实；格式契约（8 字段）不变
  - 上下文管道修复：保费占收入比缺失传 `未计算`+禁用说明（杜绝 `（-%）` 泄漏）；年固定支出字段显式标"年"（防月/年混淆）
  - _Requirement: R1/R5

- [x] 4. 待澄清项生成与落库（readiness.missing 确定性派生 ≤5，落 families.pending_clarifications，随成功覆盖）
  - reportAI 产出尾部生成 `clarifications[]`（≤5：问题/为何影响结论/fix 入口；来源=缺失清单+AI 判断）
  - 成功写 families 时落库 `pending_clarifications`（随分析成功覆盖；`insight_stale` 时不清除）
  - 响应 data 透出 clarifications
  - _Requirement: R3/R5

- [ ] 5. `_shared` 同步与后端部署
  - `node scripts/sync-shared.js` → 校验副本含改动（grep 关键标识）
  - 部署 reportAI；readiness 变更影响方（conversationAI 兜底 422）回归后部署
  - _Requirement: 工程纪律

## B. 前端 · 报告页接入

- [x] 6. 自动介入：`_tryAutoAnalysis` 收敛（`_applyReportData` 汇聚点单挂载，覆盖 OCR/编辑/对话/撤销/进场；source auto + 30s 抑制 + 完成静默刷新）

- [x] 7. 时效标识 + summary 接线（挂载点①：buildReportMeta 拆分 dataAt/analysisAt、页头 title-tag/staleTag、样式）
  - 页头区分「数据更新于 `updated_at` / 保障分析生成于 `last_analysis_at`」；owner 侧 stale 显示"数据已更新，分析待刷新"（可点手动生成）
  - `last_summary` 渲染落点：页头/hero 副题"家庭保障结构标签"（两版）
  - _Requirement: R5

- [x] 8. 待澄清项渲染（挂载点②，owner-only：clarifications 数据接线 + deep 区卡片 + 补录直达分发）
  - 分析区尾部渲染 `pending_clarifications`（每项：问题 + 影响说明 + 补录入口跳转成员/财务表单）；可跳过；已回答/已补录项随下一轮分析消失
  - 客户版不渲染
  - _Requirement: R3/R5

- [x] 9. 客户版调整：移除⑧章 + 量化降级说明 + 沟通桥（挂载点③④；既有测试断言同步）
  - `chapter-builder.js` shared 分支：移除"下一步"章（行动出口唯一化 = C1-suggestions）
  - 存在 blocked 缺口时客户版加克制说明："完整额度测算需结合家庭收支，可联系服务顾问补充后自动更新"（hero 脚注/缺口区）
  - 客户 footer 水印上新增正向引导："本报告将随家庭信息更新自动刷新；可联系您的服务顾问完善"
  - owner 保留⑧章（核对口径）
  - _Requirement: R4/R5

- [x] 10. C0 生成入口卡调整（文案声明"信息更新后自动生成；可立即生成"）
  - 自动介入上线后：owner 未生成态由"待数据/分析生成中"提示替代（readiness 引导补全保留）；「更新分析」保留
  - _Requirement: R2/R5

## C. 分享侧

- [x] 11. `dataQuery/share.js` 透传 `analysisAt`（清理 last_* 前透传；report-share meta 兼容两版）
  - getSharedFamily 在清理 `last_*` 前取 `last_analysis_at` 为 `analysisAt` 标量随 data 返回（客户版时效展示）
  - 客户版页头时效区消费该标量
  - _Requirement: R4/R5

## D. 测试与文档

- [x] 12. 单测（readiness tier/readiness 既有、report-context 口径修复、report-builder 客户版⑧移除、新增 living-report 静态断言；883→888 全绿）
  - readiness：tier 迁移（收入缺失 degraded、事实缺失 blocked）；缺失清单结构
  - reportAI 节流决策：auto 30s 合并 / manual 立即
  - prompt 定性模式黑名单：静态断言含禁项（金额/预算/占收入比）
  - gap blocked → 客户版克制说明文案
  - 回归：既有 readiness/报告测试零回归
  - _Requirement: R1-R5

- [ ] 13. e2e 验证（用户可见流）
  - OCR 入库 → stale → 自动分析触发（30s 内重复触发合并一次）
  - 经济数据缺失：规则层寿险/意外 blocked + AI 定性产出无金额 + 客户版克制说明
  - 补齐收入 → 量化内容自动出现（无需手动）
  - 对话补录 → 下一轮分析后 clarifications 消失
  - 客户分享打开：时效标识 + 正向引导，无⑧章，纯读不触发分析
  - _Requirement: R1-R5

- [x] 14. 文档同步（CONTEXT.md 自动介入/readiness tier；prd.md readiness 规则表 degraded + 活报告模型注记）

- [x] 15. 部署（reportAI + dataQuery 已由用户部署；readiness 副本在部署前已 sync）
- [ ] 13. e2e 真机走查（待前端发布后执行）
  - 部署 reportAI / dataQuery（share.js）/ 前端同步发布
  - agent_logs 观察自动分析频次与 token；如需收敛再做决策
  - _Requirement: 工程纪律
