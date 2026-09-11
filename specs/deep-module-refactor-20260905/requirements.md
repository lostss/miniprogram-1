# 深模块重构 2026-09-05 — 需求

范围：架构审查报告全部 6 候选（含修正后的真实落点）。用户已确认全做。

## 候选 1 · report 弹层打开样板收敛（已修正：无 member/policy-sheet 组件）
- 背景：`pages/report/index.js` 9 处弹层打开点，8 处开 edit-sheet，互斥前缀 `showMemberManage:false, memberManageList:[]` 5 处原样重复，关闭清理另有 `onCloseEdit` 一处。
- 目标：打开 edit-sheet 的互斥 setData 收敛为页面内单一私有方法 `_openEditSheet(cfg, sheetMode)`；成员管理面板打开保留原状。
- 非目标：不新增组件、不抽新 utils 文件、不改 WXML。

## 候选 2 · 组件内业务下沉 utils 纯模块（Strong）
- markdown：`components/markdown-render/index.js` 的 `parseMarkdown`/`parseInlineStyles`/`_parseBold`/`_splitRow` 是零组件状态依赖的纯函数（现 0 单测）→ 下沉 `utils/md-parse.js`，组件变薄（observer/节流/降级保留）。
- ocr-flow 角色推断：`components/ocr-flow/index.js` `_runRoleStage`/`_applyRoleState` 中的关系推断规则（出生年龄差→子女/父母/配偶、本人/配偶占用互斥、冲突标记）→ 下沉 `utils/role-infer.js` 纯函数。
- 检查 `components/report-markdown/index.js` 是否含解析器副本，若有则一并收敛共用（消除渲染分叉源）。
- 新增 `tests/md-parse.test.js`、`tests/role-infer.test.js`。

## 候选 3 · sync-shared 依赖闭包守护（含失实修正）
- 事实修正：sync-shared 已有 `--check`（守文件漂移）；ai-client 副本 4 份非 3 份。
- 真炸点：`reportAI` 的 ai-client.js `require('axios')` 但 `reportAI/package.json` 未声明 → DeepSeek 直连运行时缺包。
- 目标：sync-shared 新增"闭包第三方依赖"推导与校验（函数根 js + 闭包 _shared 内 require 的非相对非内置包 ⊆ package.json dependencies），并入 `--check`（缺=error，版本漂移=warn）。
- reportAI 补 `axios`；含 ai-client 函数统一 axios 版本对齐。
- 非目标：ws 死依赖清理（声明未用无害，删需动 5 函数部署，YAGNI）。

## 候选 4 · 成员写入收敛（修正：「三套实现」失实，upsertMember 单源码）
- 事实：upsertMember 只有一份源码（memberRepo，7 副本系 sync 生成）；dataWrite `handlers.js:32` 薄包装；conversationAI 进程内直调同源。
- 真实重复：字段白名单文本 3+ 份（memberRepo._MEMBER_FIELDS / member-write ALLOWED_MEMBER_FIELDS 同集 / family-write._syncMembers 内联 / member-dimensions 中文维度——维度表是另一语义，不合并）。
- 目标：updateMember 白名单引用 memberRepo._MEMBER_FIELDS 单源；family-write._syncMembers 若可零行为收敛则复用；不扩大守卫面（OCR silentAdd 写固定结构化字段、无自由文本输入面，YAGNI）。
- 非目标：不改写调用拓扑（conversationAI 进程内直调保留，性能决策）。

## 候选 5 · API 写范式外泄收敛（数字修正：DIRECT_FN 34 项非 44）
- 事实：三横切（requestId/写保护/错误上报）集中在 apiClient.js，质量好；callCloud 纯超时重试。
- 真实问题：三种写入参数形状（field/value vs data vs updateData）外泄给调用方；字符串 action 无静态检查。
- 目标：新增 `utils/domain-writes.js` 领域写薄层（saveMemberField/savePolicyData/saveFamilyPatch/writePoliciesBatch），内部归一形状；高频调用方（ocr-flow/report 页/ocr-flow.js）迁移。
- 非目标：不改 apiClient 核心横切、不引入 TS/schema 表（纯 JS 项目 YAGNI）。

## 候选 6 · 活死链与死包（含失实修正）
- 事实修正：`_shortCatName` 是活的（report-builder 内部被 buildHero 调用），不动。
- 决策依据（新证据）：conversationAI ctx 版本 = `families.updated_at`（index.js:148 注释+ L323），外部写库经 writeSeam 统一 bump families.updated_at → 前端写库后 ctx 自动条件重建 → `invalidatePrompt` 空实现是正确设计而非缺陷，report 页调用是残留。
- 目标：删 `report/index.js` `_invalidateChatPrompt` + 两调用点（L576/L703）；删 `chat-panel/index.js` 空实现 `invalidatePrompt`（保留 onNoop 真实用途）；删 `miniprogram_npm/@cloudbase/agent-ui-miniprogram` 死包（52KB 零引用）。

## 验收准则（EARS）
- When 执行 `node scripts/sync-shared.js --check`，then 在闭包内 _shared 引用未声明第三方依赖时以非零退出。
- When `reportAI` 部署，then 其 package.json 含 axios 声明且运行 DeepSeek 直连不报缺包。
- When `npx jest` 运行，then 新增 md-parse/role-infer/domain-writes 测试全过且既有测试零回归。
- When 小程序端加载 markdown-render 渲染含表格/代码块/任务列表文本，then 输出与原解析器逐字节一致（组件瘦身后的行为等价）。
- When 报告页打开任一编辑弹层，then 行为与重构前一致（互斥清底/标题/sheetMode 不变）。
- When 全仓搜索 invalidatePrompt/agent-ui-miniprogram，then 零命中。
