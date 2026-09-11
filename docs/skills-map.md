# 技能与规则地图（skills-map）

> 本项目规则/技能共约 170 个 SKILL.md + 220 个 rule.md，但同一套 CloudBase 官方规则被复制到 8+ 个工具目录。
> 本文档是筛选后的权威清单：**高价值项按需加载，低相关项忽略**。
> AGENTS.md 已引用本文档；新会话按 AGENTS.md「技能与规则」小节 + 本文档执行。

## 加载规则

1. 任务匹配某技能描述时，先读取其 SKILL.md / rule.md（含 references 子文档）再动手。
2. **来源优先级**：.agent/rules（权威源）> .trae/skills > .claude/skills > .codebuddy/skills > rules/ > 其余副本目录。同套内容以权威源为准，避免副本漂移。
3. 会话运行时技能目录之外的技能不会自动执行，需按需读取项目文件。

## A 档：高价值，任务匹配即用

| 技能/规则 | 用途 | 权威源 |
|---|---|---|
| 提示词工程专家 | AI 提示词设计/优化/防注入（本项目 prompts.js 众多） | .trae/skills/提示词工程专家 |
| miniprogram-development | 小程序开发/调试/发布 | .agent/rules/miniprogram-development |
| ai-model-nodejs | Node 侧 AI 调用（@cloudbase/node-sdk，对应 ai-client） | .agent/rules/ai-model-nodejs |
| ai-model-cloudbase | CloudBase AI 模型调用总览（JS/Node/小程序） | .agent/rules/ai-model-cloudbase |
| test-driven-development / superpowers-tdd | 功能/修复测试先行（RED-GREEN-REFACTOR） | .trae/skills/test-driven-development |
| systematic-debugging / diagnose | 系统化排障（先复现→定位→再修） | .trae/skills/systematic-debugging |
| ui-design | 界面设计与评审 | .agent/rules/ui-design |

## B 档：场景性有用

| 技能/规则 | 何时用 | 权威源 |
|---|---|---|
| auth-wechat | 登录/身份/openid/unionid 相关 | .agent/rules/auth-wechat |
| no-sql-wx-mp-sdk | 小程序端文档库查询/聚合 | .agent/rules/no-sql-wx-mp-sdk |
| cloud-functions | 云函数运行时/部署/调试/事件函数 | .agent/rules/cloud-functions |
| spec-workflow / writing-plans | 多模块改动先出需求/设计/任务计划 | .agent/rules/spec-workflow |
| verification-before-completion | 收尾时先跑验证再宣称完成 | .trae/skills/verification-before-completion |
| ops-inspector | 云环境资源健康检查/诊断 | .agent/rules/ops-inspector（或 .trae 副本） |
| cloudbase-cli | 需要 tcb CLI 部署/管理资源时 | .agent/rules/cloudbase-cli |

## C 档：低相关，默认忽略

- relational-database-*（本项目用 NoSQL 文档库）
- cloudrun-development（未用 CloudRun）
- cloudbase-agent / cloudbase-agent-ts（未用 AG-UI 代理服务器）
- web-development / auth-web / auth-tool / cloud-storage-web / no-sql-web-sdk（Web SDK，本项目无 Web 端）
- skyline渲染引擎（未启用 Skyline，enableEngineNative=false）
- frontend-skill / Impeccable（React/Web 栈）
- TAPD / MCP管理器 / Agent Team Orchestration / darwin-skill / 其余元技能
- http-api / data-model-creation / cloudbase-wechat-integration（仅接入支付/OAuth/HTTP 直连时再看）

## 已知问题

- **重复严重**：同一套 CloudBase 规则在 .agent/rules、.claude/skills、.codebuddy/skills、.trae/skills、rules/、.windsurf/rules、.kiro/steering、.qoder/rules、.clinerules 各一份（各约 27-30 个）。后续可考虑统一权威源 + 软链/清理。
