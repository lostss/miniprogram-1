# Implementation Plan — 深模块重构 2026-09-05

- [x] 1. 候选6：删 report/index.js `_invalidateChatPrompt` 及 L576/L703 调用；删 chat-panel `invalidatePrompt`；删 agent-ui-miniprogram 死包目录；搜索验证零残留
- [x] 2. 候选2a：抽 `utils/md-parse.js`；薄化 markdown-render；核 report-markdown 副本并收敛；加 `tests/md-parse.test.js`
- [x] 3. 候选2b：抽 `utils/role-infer.js`；ocr-flow `_runRoleStage`/`_applyRoleState` 调模块；加 `tests/role-infer.test.js`
- [x] 4. 候选1：report 页新增 `_openEditSheet`，8 处打开点替换（含 sheetMode 差异）
- [x] 5. 候选5：`utils/domain-writes.js`；迁移 ocr-flow/report/ocr-flow.js 写调用；加 `tests/domain-writes.test.js`
- [x] 6. 候选3：sync-shared 依赖闭包校验并入 --check；reportAI 补 axios；conversationAI axios 对齐
- [x] 7. 候选4：member-write 白名单引用 `_MEMBER_FIELDS`；family-write 收敛白名单遍历（age/income 数字归一保留）
- [x] 8. 全量验证：`npx jest`(883 通过) + eslint（新增零错；既有 prefer-template 未动）+ `node scripts/sync-shared.js --check` 通过
- [x] 9. 部署：dataWrite + reportAI 已 updateFunctionCode（isWaitInstall）→ Status=Active、CodeResult=success；reportAI CodeSize +617KB（axios 已装）；env 原本为空无丢失
