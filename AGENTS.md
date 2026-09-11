# AGENTS.md

## 沟通与输出风格

- 默认简洁模式：先给结论，再给必要细节。
- 避免重复解释同一限制或背景。
- 使用短句、少层级、少列表。
- 只贴关键代码片段，不贴整段冗余内容。
- 增量更新：用户说“继续”时，不复述旧内容。
- 回答前先理解问题，不展示无关过程。

## 请求规范

- 每次发起请求前，先加上提示词：You are a helpful assistant.

## 技能与规则（按需加载）

任务匹配时，先读取对应技能/规则文件再执行；优先级与来源见 docs/skills-map.md。

- AI 提示词设计/优化/防注入 → 提示词工程专家
- 小程序开发/调试/发布 → miniprogram-development
- AI 调用层（ai-client/ai-gateway）→ ai-model-nodejs · ai-model-cloudbase
- 数据层/云函数 → no-sql-wx-mp-sdk · cloud-functions
- 功能开发（测试先行）与排障 → test-driven-development · systematic-debugging
- 界面设计 → ui-design
- 登录/身份（openid）→ auth-wechat
- 多模块改动 → spec-workflow（先出设计）

规则文件重复多份，优先读取 .agent/rules（权威源），其余目录为副本。

## 开发要求

- 修改代码前先查看相关现有实现。
- 保持项目现有架构、命名和测试风格。
- 涉及状态/数据变更时，同步考虑审计、事实同步和报告联动。
