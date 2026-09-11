# 深模块重构 2026-09-05 — 设计

## 候选 1 · `_openEditSheet` 页面内收敛
report/index.js methods 中新增：
```js
_openEditSheet(cfg, sheetMode = 'edit') {
  // 弹窗互斥：edit-sheet 独占顶层，打开即清底层 member-manage（审计 Bug 1 语义单点化）
  this.setData(Object.assign({ showEdit: true, editTitle: cfg.title, sheetMode, showMemberManage: false, memberManageList: [] }, cfg))
}
```
替换 8 处打开点（L88/L119/L204/L210/L218(view)/L231/L246/L648）。L231 `_openMemberEdit` 保留壳（含成员查找）内部调 `_openEditSheet`。差异：原 L88/L119/L210 未显式清 member-manage，统一后一致（额外清空无副作用）。零行为回归风险：仅重组 setData 字面量。
关闭已集中 `onCloseEdit`（L620），不动。

## 候选 2a · `utils/md-parse.js`
迁移 4 个纯函数：`parseMarkdown(text)`（改内部 `this.parseInlineStyles`→`parseInlineStyles`、`this._parseBold`→`_parseBold`）、`parseInlineStyles`、`_parseBold`、`_splitRow`。导出 `{ parseMarkdown }`（其余模块内）。
组件 markdown-render/index.js：methods 删 parseMarkdown/parseInlineStyles/_parseBold + 模块级 _splitRow；`_flushParse` 改调 utils；保留 parseContent/_flushParse/copy*/expandTable/onLinkTap 等 wx 交互与节流降级。若 report-markdown 含解析副本 → 同样替换（先读证）。
测试：畸形输入（不闭合代码块/残缺表格/空单元格/嵌套列表/任务列表/链接与加粗混合）→ 断言 nodes 结构。

## 候选 2b · `utils/role-infer.js`
从 ocr-flow/index.js L521-601 提取纯函数：
```js
buildBirthMap(policies)      // name → policyholder/insured/beneficiary 出生日期
ageFromBirth(b)              // 计算年龄（NaN 传播）
occupiedRoles(members)       // {本人|配偶: {name, memberId}}
inferRoleFor(name, holderAge, birthMap, occupied)  // 子女/父母/配偶→占用跳过→'其他'
applyRoleConflicts(list, occupied)  // 冲突标注（原 _applyRoleState）
```
导出 `{ buildBirthMap, ageFromBirth, occupiedRoles, inferRoleFor, applyRoleConflicts }`。组件 `_runRoleStage` 中 birthMap 构建/occupied/_infer/_inferRole/_applyRoleState 改调模块；IO（createFamily/apiGetFamily/api updateMember/wx/showModal/Promise resolve）与 roleList 组装留在组件。`_applyRoleState` 保留薄壳（onRolePick 引用）内部调 applyRoleConflicts。
测试：年龄差边界（>18/< -18/±18 内/NaN）、占用跳过、冲突标注正确。

## 候选 3 · sync-shared 依赖闭包
sync-shared.js 新增：
- `thirdPartyDeps(fnDir)`：对函数根目录 .js 与闭包 _shared 文件（requiredShared 结果读权威源）正则收集 `require('pkg')` 中不以 `.` 开头且非 node 内置（fs/path/util/crypto/http/https/stream/url/zlib/os/child_process/events/querystring/string_decoder/timers/tty）的包名集合。
- `checkDeps(fnDir, deps)`：读 `fnDir/package.json`。缺声明 → 输出 `[missing]`；`--check` 时 exit 1。版本与"参考版本"（取同包其它声明中最高/权威值）不一致 → `[warn]` 不 exit。
- 顶部打印 mode 时显示 `deps: on/off`；`--no-deps` 可关。
package.json 修复：reportAI 补 `"axios": "^1.7.0"`；conversationAI axios `^1.6.0`→`^1.7.0`（对齐 ocrService）。

## 候选 4 · 白名单单源
- memberRepo 已导出 `_MEMBER_FIELDS`（=成员 8 字段）。member-write.js L13 require 增 `_MEMBER_FIELDS`，L91 删本地 `ALLOWED_MEMBER_FIELDS` 改用之（同集不同序，行为不变）。
- family-write.js `_syncMembers` 的字段 patch 若字段集 == `_MEMBER_FIELDS` 且可零行为收敛（读代码后确认；patch 含软删复活/空值语义则保留并注明）。
- 部署：sync-shared（若改 _shared）→ 部署 dataWrite（member-write/family-write 属 dataWrite 本体）。memberRepo 若仅加导出、逻辑零变化 → 副本同步后其它函数免部署（规则例外）。部署后 queryFunctions.getFunctionDetail 核对 env（记忆 13581811）。

## 候选 5 · `utils/domain-writes.js`
薄层封装（内部经 apiClient）：
```js
saveMemberField({familyId, memberId, field, value})
savePolicyData({familyId, policyId, data})          // 含 sheetMode 保存路径复用
saveFamilyPatch({familyId, updateData})             // updateFamily 整家/复合覆盖
writePoliciesBatch({familyId, policies, cashValues}) // 长超时 60s retries:0 语义保留
```
迁移调用方：ocr-flow/index.js 3 处 `api('updateMember',{...field/value})`；report/index.js L562 updatePolicy、L263/568 updateFamily（读上下文后迁移，L263 是删除成员后整家同步）；ocr-flow.js:303 writePoliciesBatch。apiClient 自身不动。测试 mock apiClient 断言参数形状。
不迁移的调用点（写消息/日志/状态类低频或专用）留在 apiClient 直调——收敛到"领域写"高频表单三类。

## 候选 6 · 删除
- report/index.js：删 `_invalidateChatPrompt`（L462-467）及 L576/L703 调用（onSaveEdit/`_changePolicyStatus` 成功后）。
- chat-panel/index.js：删 methods 中空实现 `invalidatePrompt`。
- 删目录 `miniprogram/miniprogram_npm/@cloudbase/agent-ui-miniprogram/`。
- 搜索验证零残留。

## 变更顺序（按风险递增）
1. 候选 6（纯删，前端，零部署）→ 2. 候选 2（新增 utils+测试+组件薄化）→ 3. 候选 1（report 页重组）→ 4. 候选 5（domain-writes + 调用迁移）→ 5. 候选 3（sync-shared + package.json）→ 6. 候选 4（dataWrite）+ 部署。
验证：每步 `npx jest` + eslint；云函数部署前 `node scripts/sync-shared.js`。
