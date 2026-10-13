---
description: 项目开发路由（CloudBase 通用规则见对应 skill，不在本文件复述）
globs: *
alwaysApply: false
inclusion: onDemand
---

# 项目路由（保小秘 / miniprogram-1）

## 权威源

- 术语 / 数据模型 / 架构：`CONTEXT.md`；验收标准与实施状态：`docs/prd.md`
- 云函数 AI 与部署规范：`.codebuddy/rules/cloud-rules/RULE.mdc`
- 工程纪律 / 命名 / 数据红线 / 弹出层规范：`.codebuddy/rules/project-rules/RULE.mdc`
- 共享模块：`cloudfunctions/_shared/` 是唯一主源 → `node scripts/sync-shared.js` 下发副本；跨树契约见 `sync-shared.js` 的 `CONTRACT_FILES`（勿直接改 `miniprogram/utils/` 下的契约副本）

## 场景 → 技能

| 场景 | 技能 |
|------|------|
| 云函数（dataQuery / dataWrite / conversationAI / reportAI / ocrService / cleanup / reportPdf / login） | `cloud-functions` |
| AI 调用（云函数 Node SDK / 小程序 wx.cloud.extend.AI） | `ai-model-nodejs` / `ai-model-wechat` |
| 小程序页面与组件、预览发布 | `miniprogram-development`；视觉设计 `ui-design` |
| NoSQL 集合读写（families / members / finances / policies / facts） | `no-sql-wx-mp-sdk` |
| 微信登录 / openid | `auth-wechat` |
| 交付前自检 | `quality-gate` |

## 硬约束（勿重复探索）

- 改 `cloudfunctions/` 后部署对应函数，并核对 Env / Timeout（详见 cloud-rules 的部署节）
- 禁 `any`；查询必须含 `_openid`；金额 DB 存「元」；成员用 `member_id` 作 join key
- 检索加 `headLimit` + `outputMode`；**勿对 `cloudfunctions/` 根做目录列举**（含各函数 `node_modules`，约 4 万个文件）
- 优先复用既有接缝：写入走 `writeSeam`、金额换算走 `amount.js`、缺口算法走 `_shared/gap-core.js`
- **已决口径不得重开**（2026-09-27 新增）：涉及下列主题的**改动或提议**前，先读锚点原文，再在 `README.md`「最近部署记录」搜同主题关键词确认是否已有产品决策 —— **已决项不得重开；要改必须先明确推翻并写明理由**：
  - 删除语义 / 关联键（软删只清 facts，`policies.member_id` **保留原值**）→ `docs/data-model-v2.md`「删除规则」
  - 保额口径（医疗险报销年限额**计入**总保额、**不按**报销型/给付型拆分；该提醒的是**期限**而非类型）→ 同文档「保额口径」
  - 保单状态 / 续保（写入一律 `active`、读取永不重算；一年期默认续保 + 文中提醒）→ `_shared/policy-status.js` + README `D3` 行
  - 收入槽归一（`月薪` **不**归入「个人年收入」槽；月语义入年槽会少报约 12×，且**不做** ×12 换算）→ `_shared/fact-vocab.js` 的 `AXIS_DEFS` 注释 + `docs/data-model-v2.md` 同义词表脚注（2026-09-28 推翻旧表后新增）
  - 起因：这几类已被重复开题多次（删除语义 2 次、保额口径 3 次），每次都源于"只读代码、不读已成文决策" —— 决策写在 `docs/` 与 README 里，而护栏埋在文档内部，不读文档的人永远看不到。
- 通用 CloudBase 平台知识（数据库开通、部署通道、规则目录策略等）按需查对应 skill，本文件不复述
