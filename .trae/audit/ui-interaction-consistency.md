# UI/UX 审计报告 — 交互一致性与手势冲突维度

> 审计对象：`miniprogram-1`（保小秘 微信小程序）
> 审计范围：pages/index、pages/clients、pages/report、components/chat-panel、components/ocr-flow、components/edit-sheet、components/client-card
> 审计时间：2026-08-09
> 审计方法：源码静态走查（.js / .wxml / .wxss / .json）

## 总览结论

整体交互骨架设计扎实——弹窗互斥在 report 页有显式状态清理、catchtouchmove 拦截覆盖率高、下拉刷新的双防线（onPullDownRefresh 检查 + 各遮罩 catchtouchmove）思路正确。但存在 **3 处严重问题**（OCR 弹窗的返回键未拦截、FAB 输入框键盘适配缺失、两套编辑表单校验/反馈不一致）和若干中低一致性缺口。详细分项评估如下。

---

## 1. Sheet / 弹窗互斥

### pages/index（首页）
- **多个 Sheet 互斥**：N/A。首页只有 ocr-flow 一个多阶段弹窗（match/roles/done/saved），无并发 Sheet。
- **嵌套层级**：✅ ocr-mask `z-index: --z-modal(300)`，ocr-sheet `z-index: --z-sheet-inner-top(311)`，遮罩与 sheet 嵌套顺序正确。
- **遮罩阻止底层交互**：✅ ocr-mask 仅 `catchtouchmove="onMaskTouchMove"`，作为 modal 不可点击外部关闭（设计合理，OCR 流程不应误关）。ocr-sheet-mask 同时 `bindtap=onSheetClose` + `catchtouchmove` ✅。
- **关闭清空状态**：⚠️ `onSheetClose`（ocr-flow index.js:576）仅 `setData({ 'ocrSheet.visible': false })`，未清空 `fields / policyIndex / title`。下次打开会被覆盖，无功能性风险，但状态残留。

### pages/clients（客户管理）
- 全部 N/A：该页无 Sheet，仅搜索框 + 列表。

### pages/report（报告页）
- **多个 Sheet 互斥**：✅ 互斥模式设计完整：
  - `_openMemberEdit`（report/index.js:122）打开 edit-sheet 时显式 `showMemberManage: false, memberManageList: []`
  - `onMemberManageAdd`（:136）同上
  - `onPolicyTap`（:429）打开 policy-sheet 时 `showMemberManage: false, memberManageList: []`
  - `onPolicySheetEdit`（:441）打开 edit-sheet 时 `showPolicySheet: false`
  - `onCloseEdit`（:394）一次性清空 `showEdit / showMemberManage / showPolicySheet`（注释"审计 Bug 1/2：仅保存路径有关闭，取消路径全漏"已修复）
- **嵌套层级**：⚠️ `policy-sheet-overlay` 与 `member-manage-overlay` 与 `edit-sheet.overlay` 均使用 `--z-sheet(200)` 同层级。虽然状态互斥保证了视觉上不会同时出现，但层级 token 没有按"上层 sheet > 下层 sheet"区分，未来若状态遗漏可能视觉错乱。建议为顶层 sheet 用 `--z-sheet-inner-top(311)`。
- **遮罩阻止底层交互**：✅ 三个 overlay 全部 `catchtap` + `catchtouchmove="onNoop"`。
- **关闭清空状态**：
  - `closeMemberManage` ✅ 清 memberManageList
  - `onPolicySheetClose` ✅ 清 currentPolicy/policyRows/policyCat
  - `onCloseEdit` ✅ 清三个 sheet 标志，但 **未清 editFields/editTitle/_editMode/_editMemberIdx**。下次打开会被 `Object.assign` 覆盖，但若新 buildEditConfig 失败可能显示旧字段，建议补清。
- **edit-sheet 与 OCR 弹窗互斥**：❌ 缺失。`onChapterEdit / onPolicyTap` 打开 edit-sheet / member-manage / policy-sheet 时未检查 `ocrFlow.data.ocrMask.visible`，OCR 处理中触发章节编辑会叠加。实际触发概率低（OCR 流程中通常不点击报告正文），但状态机不完整。

### components/chat-panel
- **遮罩阻止底层交互**：✅ `chat-overlay catchtap=onCollapse catchtouchmove=onNoop`，`chat-panel catchtouchmove=onNoop`。
- **关闭清空状态**：⚠️ `onCollapse`（chat-panel/index.js:115）仅 `collapsed: true`，**未清 `inputText`**。父级 report 页 FAB 栏 `fabText` 与组件 `inputText` 双向割裂：FAB 收起后下次展开仍残留上次输入（除非 `onFabSend` 成功已 setData 清空）。`messages` 保留是合理的（对话历史）。

### components/ocr-flow
- **OCR 主弹窗与编辑 sheet 嵌套**：✅ ocr-mask `z-index: --z-modal(300)`，ocr-sheet-mask `z-index: --z-sheet-inner(310)`，编辑 sheet 浮于结果卡之上，层级正确。
- **遮罩拦截**：✅ 主 mask `catchtouchmove`，sheet-mask `bindtap + catchtouchmove`。
- **关闭清空状态**：⚠️ `onSheetClose` 未清 fields（见上文）。

### components/edit-sheet
- **遮罩拦截**：✅ `overlay catchtap=onClose catchtouchmove=onNoop`，`sheet catchtap=onNoop`（注释明确指出"原缺失导致点击表单字段/picker 栏即关闭"已修复）。
- **关闭确认**：✅ `onClose` 检查 `modified` 字段，dirty 时弹 `wx.showModal` 二次确认（R-M7 修复）。

### components/client-card
- 全部 N/A：纯展示 + 事件派发组件，无 Sheet。

---

## 2. 手势冲突

### pages/index
- **下拉刷新与 Sheet 遮罩**：N/A。`index.json` 未配置 `enablePullDownRefresh`，首页无下拉刷新（首页用 60s TTL 缓存 + 错误态重试按钮，设计上规避了下拉手势）。
- **chat-panel 展开阻止下拉**：N/A（首页未引入 chat-panel）。
- **scroll-view 滚动冒泡**：N/A（首页无 scroll-view，整页跟随原生滚动）。
- **长按/滑动与点击冲突**：✅ `client-card` 用 `catchtap` + `catchlongpress` 显式阻止原生 tap 冒泡（注释明确说明原 `bindtap` 导致页面 onClientTap 被调用两次）。
- **catchtouchmove 使用**：N/A（首页无 modal）。

### pages/clients
- **下拉刷新**：✅ `enablePullDownRefresh: true`，`onPullDownRefresh` 调用 `_fetch()` 并在 finally 中 `stopPullDownRefresh`（F-M6 修复）。该页无 Sheet，无冲突。
- **长按与点击冲突**：✅ 同首页，依赖 client-card 的 `catchtap/catchlongpress`。
- **搜索框 input 与列表滚动**：✅ 搜索栏 `position: sticky; top: 0`，滚动时固定顶部，无冲突。

### pages/report
- **下拉刷新被 Sheet 遮罩拦截**：✅ **双防线设计**：
  1. JS 层（report/index.js:277-287）`onPullDownRefresh` 检查 `ocrMask.visible / ocrSheet.visible / showEdit / showPolicySheet / showMemberManage / chat-panel.collapsed`，任一为真即 `wx.stopPullDownRefresh()` 空转。
  2. 各遮罩 `catchtouchmove="onNoop"` 拦截触摸拖动穿透（report/index.js:275 注释："真机上页面原生下拉手势可能绕过 JS catchtouchmove，此处拦截是第二道防线"）。
- **chat-panel 展开时阻止页面下拉刷新**：✅ 同上检查 `panel && !panel.data.collapsed`（F-M1 修复）。
- **scroll-view 内滚动冒泡**：✅ `.content`（scroll-view scroll-y）在 flex 容器内 `flex:1; min-height:0`，原生滚动不冒泡。`.mm-list / .ps-body` 内嵌 scroll-view 高度确定（`flex:1; height:0; min-height:0`），不会冒泡到外层 overlay。
- **长按/滑动与点击冲突**：✅ 成员管理项 `.mm-item catchtap=onMemberManageEdit`，子元素 `.mm-del catchtap=onMemberManageDelete` —— 内层 catchtap 阻止冒泡到外层（注释明确）。
- **catchtouchmove 使用**：✅ 全部 sheet overlay 与 chat-panel 都正确使用。

### components/chat-panel
- **scroll-view 滚动**：✅ `msg-list` scroll-view `enhanced bounces="{{false}}"`，配合 `scroll-into-view` 锚点定位。
- **下拉刷新历史**：✅ 内置 `refresher-enabled` + `bindrefresherrefresh=onPullRefresh`，与页面下拉刷新隔离（组件内自管）。
- **catchtouchmove**：✅ overlay + panel 双层拦截。

### components/ocr-flow
- **scroll-view 冒泡**：✅ `.proc-list` 和 `.ocr-sheet-body` 均为内部 scroll-view，高度确定，不冒泡。
- **catchtouchmove**：✅ 主 mask 与 sheet-mask 都用 `catchtouchmove="onMaskTouchMove"`（注释明确："无拦截时 mask 上下拉会触发 report 页下拉刷新重载报告"）。
- **列表项点击反馈**：⚠️ `.proc-card`（识别成功/待核对）使用 `bindtap=onEditCard` 而**非 `catchtap`**，子元素无 catchtap 阻止冒泡。虽然外层是 scroll-view 不影响功能，但与 `.proc-card--err` 用 `catchtap=onProcPreview` 风格不一致。建议统一。

### components/edit-sheet
- **scroll-view 冒泡**：✅ `.sheet-body` scroll-view `flex:1; height:0; min-height:0`。
- **catchtouchmove**：✅ overlay `catchtouchmove=onNoop`，sheet 自身 `catchtap=onNoop`（注意：sheet 自身未 catchtouchmove，依赖外层 overlay 拦截，但 scroll-view 内部滚动由原生处理不影响）。

### components/client-card
- **长按/滑动与点击**：✅ `catchtap=onTap catchlongpress=onLongPress`，触发事件主动 triggerEvent 不受 catch 影响。注释说明完整。

---

## 3. 返回键拦截

### pages/index
- **onBackPress**：❌ **未实现**。首页有 ocr-flow 多阶段弹窗（match/roles/done/saved/failed），但 `Page` 未定义 `onBackPress`。OCR 流程中按返回键会直接退出页面而非关闭弹窗。
  - **风险**：用户在 OCR 识别中误按返回，进度丢失。`ocr-flow` 的 `detached` 钩子仅在 `phase==='saved'` 时兜底 emit saved，其他 phase（upload/recognize/done/match/roles/saving/failed）的进度靠 `wx.setStorageSync('ocrBatch')` 持久化，下次进首页 `checkResume` 才能恢复。流程虽不致命，但与用户预期不符。
  - **建议**：补 `onBackPress`，检查 `ocrFlow.data.ocrMask.visible`，true 则关闭弹窗（`ocrFlow.onProcDiscardAll` 或直接 `flow.hide()`）并 return true。

### pages/clients
- N/A：无 Sheet/弹窗，返回键直接退出页面符合预期。

### pages/report
- **onBackPress**（report/index.js:33-40）：
  ```
  if (showEdit) → onCloseEdit → return true
  if (showPolicySheet) → onPolicySheetClose → return true
  if (showMemberManage) → closeMemberManage → return true
  chat-panel.tryCollapse() → return true
  else → return false
  ```
- **覆盖度**：⚠️ **未覆盖 OCR 弹窗**！report 页也嵌入了 `<ocr-flow id="ocrFlow" />`（report/index.wxml:148），OCR 处理中按返回键会直接退出页面，跳过 `onCloseEdit/onPolicySheetClose` 等链路。
  - **风险**：用户在报告页点 FAB 上传按钮 → OCR 流程中按返回 → 直接退回首页，OCR 进度靠 `checkResume` 恢复（首页 onShow 会调）。但若用户在 `saving` 阶段按返回，可能丢失正在写入的保单数据。
  - **建议**：在 `onBackPress` 顶部加 `const ocr = this.selectComponent('#ocrFlow'); if (ocr && (ocr.data.ocrMask.visible || ocr.data.ocrSheet.visible)) { ... 关闭并 return true }`。
- **多层 Sheet 按层级关闭**：✅ 顺序设计合理（edit-sheet 顶层 → policy-sheet → member-manage → chat-panel），符合用户心智模型。

### components/chat-panel
- **供父级调用的 tryCollapse**：✅ 设计优秀，返回 boolean 让父级 `onBackPress` 决策。

### components/ocr-flow / edit-sheet / client-card
- N/A：组件无法定义 onBackPress，依赖宿主页拦截。

---

## 4. FAB（浮动操作按钮）交互

### pages/index FAB（单按钮）
- **FAB 展开阻止页面滚动**：N/A。首页 FAB 是单按钮（无展开态），不涉及滚动拦截。
- **FAB 与 OCR 弹窗互斥**：✅ FAB `z-index: --z-panel(100)`，OCR mask `z-index: --z-modal(300)`，OCR 弹窗会盖住 FAB。且 `fab--show` 仅在 `!ocrBusy` 时显示（index.wxml:70）。
- **FAB 显示条件**：✅ `recentClients.length > 0 && !ocrBusy` 才显示，空态走引导上传 box。

### pages/report FAB 栏（吸底输入栏）
- **FAB 展开阻止页面滚动**：✅ FAB 栏在 page flex 流底部（`page{height:100vh; display:flex; flex-direction:column; overflow:hidden}` + `.content{flex:1}`），不属于 fixed 定位，不会遮挡 scroll-view 内容。
- **FAB 输入框聚焦键盘遮挡**：❌ **缺失配置**。`.fab-real-input`（report/index.wxml:93）未配置 `adjust-position` 和 `cursor-spacing`。
  - **风险**：FAB 栏本身在 page flex 底部，键盘弹起时 viewport 缩小，FAB 栏会自然上移贴近键盘上方。但 input 默认 `adjust-position: true` 会再额外上推，可能导致 FAB 栏被推到屏幕中部，遮挡消息列表。
  - **建议**：设 `adjust-position="{{false}}"` 让 FAB 栏跟随 page flex 自然上移，或在 chat-panel 展开态时显式调整。
- **FAB 收起时清空输入**：⚠️ 部分覆盖。
  - `onFabSend` 成功后 `setData({ fabText: '' })`（report/index.js:470）✅
  - 但 `onCollapse`（chat-panel）未清 inputText，FAB 收起（chat-panel 折叠）后 `fabText` 未同步清空 ⚠️
  - `tryCollapse`（被 onBackPress 调用）同样未清空 ⚠️
- **FAB 与其他 Sheet 互斥**：✅ FAB 栏 `z-index: 110` < `--z-sheet(200)`，sheet 打开时 FAB 被遮罩盖住，无法操作。注释明确："110 < --z-sheet:200，保单/成员 Sheet 打开时仍正常压住 FAB 栏"。
- **FAB 与 chat-panel 关系**：✅ FAB 栏 110 > chat-panel 100，FAB 始终在 chat-panel 上方，输入框可点击。注释："面板展开时输入栏须浮于遮罩(--z-overlay:90)/面板(--z-panel:100)之上，否则被遮罩盖住导致'输入区域消失'"。
- **FAB 发送禁用条件**：✅ `.fab-send.is-disabled` 在 `!fabText` 时显示禁用样式。但 `bindtap=onFabSend` 未在 disabled 时拦截 ⚠️（实际 onSend 内部 `if (!text ...) return false` 拦截，无功能问题）。

---

## 5. 表单交互一致性

### components/edit-sheet（member / financials / policy 模式）
- **必填字段标注**：✅ `<text wx:if="{{item.required}}" class="req">*</text>`（edit-sheet/index.wxml:13），红色星号显式标注。
- **输入校验时机**：✅ **失焦实时校验**（`onFieldBlur` → `_validateField`）+ **保存时全量校验**（`onSave` → `_validateAll`）双时机。
- **错误提示位置**：✅ 输入框下方 `.form-error`（红色背景 + role="alert"），失焦时显示。
- **提交按钮禁用条件**：✅ `disabled="{{saving}}"`，保存中禁用，按钮文案 `保存中...`。
- **长表单分组**：❌ edit-sheet 自身无分组（fields 平铺）。member 模式 5 字段、financials 3 字段尚可；policy 模式 12 字段平铺略长但可接受。
- **放弃修改确认**：✅ `onClose` 检查 `modified` → `wx.showModal` 二次确认（R-M7 修复）。
- **数值字段键盘**：✅ `type: 'number'`（edit-form.js 中 financials/member/policy 数值字段）。
- **日期选择**：✅ `type: 'date'` → 原生 picker mode="date"（edit-sheet/index.wxml:22）。

### components/ocr-flow 编辑 sheet（OCR 编辑/手动录入）
- **必填字段标注**：❌ **未标注**。`_validateSheet` 强制 `product_name` 必填（ocr-flow/index.js:599），但 wxml 中 `<text class="ocr-sheet-label">` 无星号标识。用户无法预知必填项。
- **输入校验时机**：⚠️ **仅提交时校验**（`onSheetConfirm` → `_validateSheet`），无失焦实时校验。
- **错误提示位置**：❌ `wx.showToast` 顶部（ocr-flow/index.js:606），与 edit-sheet 输入框下错误提示**不一致**。
- **提交按钮禁用条件**：⚠️ 无显式 disabled。`onSheetConfirm` 走校验拦截，但用户连点会重复触发 `_procRefresh / _persistBatch`（虽然结果幂等）。
- **数值字段键盘**：✅ `SHEET_NUMERIC_KEYS` 列表字段 `type: 'digit'`（A-S1 修复）。
- **日期选择**：❌ `effective_date` 字段 `type: 'text'`（ocr-flow/index.js:727，`SHEET_NUMERIC_KEYS.indexOf(k) !== -1 ? 'digit' : 'text'`），用户需手输 YYYY-MM-DD，无原生 date picker。与 edit-sheet 不一致。
- **置信度底色**：✅ `tone: low/mid/modified`（设计稿 v4 完整实现）。
- **清空字段纠错**：✅ A-M9 修复（清空 = 删除错误识别值）。

### 两套编辑表单一致性对比

| 维度 | edit-sheet | ocr-flow 内置 sheet | 一致性 |
|------|-----------|---------------------|--------|
| 必填星号 | ✅ | ❌ | ❌ 不一致 |
| 失焦校验 | ✅ | ❌ | ❌ 不一致 |
| 错误提示位置 | 输入框下 | 顶部 toast | ❌ 不一致 |
| 提交禁用 | ✅ disabled | ❌ 无 | ❌ 不一致 |
| 数值键盘 | type:'number' | type:'digit' | ✅ 一致 |
| 日期选择 | 原生 date picker | 文本输入 | ❌ 不一致 |
| 字段分组 | 平铺 | 分组（GROUPS） | ⚠️ 各有取舍 |

**严重问题**：同一应用内两套保单编辑表单（report 页 [核对]入口走 edit-sheet、OCR 流程走 ocr-sheet）交互模式割裂，用户认知负担高。

---

## 6. 列表交互一致性

### 列表项点击反馈
- **client-card**：✅ `.card:active { transform: scale(0.98) }` + `.pressable` 全局类。
- **ocr-flow proc-card（成功/待核对）**：⚠️ **无 :active 反馈**。`.proc-card` 未加 `pressable` 类，wxss 无 `:active` 定义。点击编辑入口缺乏视觉反馈。
- **ocr-flow proc-card--err**：⚠️ 同上无 :active，但 `.proc-retry-btn` 等子按钮有 `.pressable`。
- **chat-panel sug-chip / msg-empty-chip**：✅ `pressable` 类。
- **report 页 hint-chip**：✅ `pressable` + `:active` 背景。
- **report 页 mm-item**：✅ `pressable` 类。

### 滑动操作（删除）确认
- **删除家庭**（family-actions.js）：✅ `showActionSheet` → `showModal` 二次确认，红色 confirmColor。
- **删除成员**（report/index.js:145）：✅ `showModal` 二次确认。
- **全部放弃 OCR**（ocr-flow/index.js:265）：✅ `showModal` 确认。
- **删除角色占用替换**（ocr-flow/index.js:526）：✅ `showModal` 确认。

### 长按操作反馈
- **client-card.onLongPress**：✅ `wx.vibrateShort({ type: 'medium' })` 震动反馈，再 triggerEvent。
- **OCR 错误卡长按**：N/A（无长按设计）。
- **chat-panel 消息长按**：N/A（无长按设计）。

### 列表为空交互
- **pages/index 空态**：✅ 上传引导 box + onboard-steps（3 步说明）+ empty-hint（"支持 JPG / PNG · 一次最多 9 张"）。错误态有重试按钮（R-M5 修复）。
- **pages/clients 空态**：✅ 三态分流：
  - 搜索无结果：`未找到"{keyword}"` + `换个关键词试试`
  - 加载失败：`加载失败` + `请检查网络后重试` + `重新加载` 按钮
  - 无客户：`尚无客户档案` + `拍照上传保单，自动创建客户` + `去首页上传` 按钮
- **report 页无保单空态**：✅ `empty-report` 卡（UC4 修复），引导上传替代零值红色告警。
- **chat-panel 空态**：✅ `msg-empty`（无消息时显示引导 chip 列表）。
- **OCR proc-list 空态**：⚠️ 未明确处理。理论上 procSuccess/procReview/procError 三组同时为空时（如全部识别成功后又被清空？）界面无引导。实际业务路径不易触发，但缺乏兜底。

---

## 7. 键盘适配

### 输入框聚焦键盘遮挡
- **chat-panel 输入框**：N/A。chat-panel 自身无输入框（输入框在 report 页 FAB 栏，chat-panel 只接收 onInput 事件）。
- **FAB 输入框（report 页）**：❌ `.fab-real-input`（report/index.wxml:93）未配置 `adjust-position` / `cursor-spacing`。
  - **风险**：默认 `adjust-position: true` 会上推整个 page，但 page 是 `height:100vh; overflow:hidden` flex 容器，上推可能导致 FAB 栏与键盘重叠或留白。
  - **建议**：测试真机表现，必要时设 `adjust-position="{{false}}"` + chat-panel 展开时让 FAB 栏 absolute 贴近键盘。
- **edit-sheet 输入框**：⚠️ `<input class="form-input" ... bindblur="onFieldBlur">`（edit-sheet/index.wxml:29）未配置 `adjust-position` / `cursor-spacing`。
  - **风险**：sheet 是 `position:absolute; bottom:0; max-height:85vh`，键盘弹起时 sheet 不会自动上移，底部字段（如保存按钮上方的字段）可能被键盘遮挡。
  - **建议**：补 `adjust-position="{{true}}" cursor-spacing="20"`，或监听 focus/blur 动态调整 sheet 位置。
- **ocr-flow 编辑 sheet 输入框**：⚠️ 同上，`<input class="ocr-sheet-input" ... type="{{item.type}}">` 未配置。
- **pages/clients 搜索框**：⚠️ `<input class="search-input" ... bindinput="onSearch">` 未配置。但搜索栏 `position: sticky; top:0`，聚焦时输入框在屏幕顶部，键盘不遮挡，可接受。

### adjust-position 配置
- 全局未显式配置（默认 true）⚠️。所有 input 依赖默认行为，对 fixed/absolute bottom 定位的 sheet 不友好。

### cursor-spacing 合理性
- ❌ 全项目无 `cursor-spacing` 配置。建议对 sheet 内底部输入框补 `cursor-spacing="20"` 以上。

### 键盘弹起 FAB / 底部按钮上移
- **report 页 FAB 栏**：⚠️ FAB 栏在 page flex 流底部（非 fixed），键盘弹起时 page height 收缩，FAB 栏自然上移。但因 `page{height:100vh; overflow:hidden}`，行为依赖系统键盘模式（adjustResize / adjustPan），需真机测试。
- **edit-sheet 的 sheet-actions（保存/取消）**：❌ sheet `position:absolute; bottom:0`，键盘弹起时 **sheet-actions 会被键盘遮挡**，用户无法点击保存。这是**严重问题**。
- **ocr-sheet 的 ocr-sheet-actions**：❌ 同上，sheet-actions 会被键盘遮挡。
- **chat-panel msg-list**：✅ `padding-bottom: calc(var(--sp-6) + 88rpx + env(safe-area-inset-bottom))`，为底部留出空间。但 chat-panel 本身无输入框，键盘弹起由 FAB 触发，需验证 FAB 栏不被 msg-list 遮挡。

---

## 严重问题清单

### 🔴 S1. OCR 弹窗的返回键未拦截（report 页 + 首页）
- **位置**：
  - `pages/report/index.js:33-40` `onBackPress` 未检查 `ocrFlow.data.ocrMask.visible`
  - `pages/index/index.js`（无 `onBackPress` 定义）
- **风险**：OCR 流程中（upload/recognize/done/match/roles/saving/failed 任一阶段）按返回键直接退出页面。`saving` 阶段可能丢失正在写入的保单数据；其他阶段虽靠 `wx.setStorageSync('ocrBatch')` 持久化可恢复，但用户体验割裂。
- **修复建议**：
  - report 页 `onBackPress` 顶部加：
    ```js
    const ocr = this.selectComponent('#ocrFlow')
    if (ocr && (ocr.data.ocrMask.visible || ocr.data.ocrSheet.visible)) {
      // 先关 ocr-sheet 再关 ocr-mask
      if (ocr.data.ocrSheet.visible) { ocr.setData({ 'ocrSheet.visible': false }); return true }
      // ocr-mask 阶段性确认是否放弃
      ocr.onProcDiscardAll && ocr.onProcDiscardAll()  // 或直接 flow.hide()
      return true
    }
    ```
  - 首页补 `onBackPress`，逻辑同上。

### 🔴 S2. Sheet 内输入框键盘遮挡保存按钮
- **位置**：
  - `components/edit-sheet/index.wxml:29` input 未配置 `adjust-position/cursor-spacing`
  - `components/ocr-flow/index.wxml:176` input 同上
  - `.sheet` / `.ocr-sheet` 均 `position:absolute; bottom:0`，sheet-actions 在 sheet 底部
- **风险**：长表单（policy 模式 12 字段）编辑时，底部字段聚焦键盘弹起，sheet-actions（保存/取消按钮）被键盘完全遮挡，用户必须先失焦收起键盘才能保存。
- **修复建议**：
  - input 加 `adjust-position="{{true}}" cursor-spacing="20"`
  - 或 sheet-actions 改为 `position: sticky; bottom: 0` + 监听键盘高度动态 padding-bottom
  - 或 sheet 改为 `bottom: var(--keyboard-height)` 监听 `wx.onKeyboardHeightChange`

### 🔴 S3. FAB 输入框键盘适配缺失
- **位置**：`pages/report/index.wxml:93` `<input class="fab-real-input" ...>` 无 `adjust-position/cursor-spacing`
- **风险**：FAB 栏在 page flex 流底部（`page{height:100vh; overflow:hidden}`），默认 `adjust-position: true` 会再额外上推，可能导致 FAB 栏被推到屏幕中部遮挡消息列表，或与键盘产生空白。
- **修复建议**：测试真机表现，必要时设 `adjust-position="{{false}}"` 让 page flex 自然收缩贴键盘。

### 🟡 M1. 两套编辑表单交互不一致
- **位置**：`components/edit-sheet` vs `components/ocr-flow` 内置 ocr-sheet
- **风险**：用户在 report 页 [核对] 走 edit-sheet（星号必填 + 失焦校验 + 输入框下错误 + date picker），在 OCR 流程走 ocr-sheet（无星号 + 仅提交校验 + toast 错误 + 文本日期）。同一应用内保单编辑两种交互模式，认知负担高。
- **修复建议**：统一为 edit-sheet 模式。ocr-flow 改为引用 edit-sheet 组件（已封装好校验/分组/置信度底色），传入 `mode: 'policy'` 复用 `buildEditConfig`。

### 🟡 M2. ocr-sheet 必填字段无视觉标注
- **位置**：`components/ocr-flow/index.wxml:175` `<text class="ocr-sheet-label">{{item.label}}` 无 `req` 星号
- **风险**：用户不知道产品名称必填，提交后才弹 toast 提示，体验突兀。
- **修复建议**：wxml 加 `<text wx:if="{{item.key === 'product_name'}}" class="req">*</text>`，或在 `_buildSheetFields` 给 product_name 加 `required: true` 字段并由 wxml 渲染星号。

### 🟡 M3. chat-panel / FAB 收起时未清空输入
- **位置**：
  - `components/chat-panel/index.js:115` `onCollapse` 仅 `collapsed: true`
  - `components/chat-panel/index.js:118` `tryCollapse` 同上
  - report 页 `fabText` 与组件 `inputText` 双向割裂
- **风险**：用户输入一段话后收起面板，下次展开仍残留上次输入。若上次是敏感内容（PII）则隐私风险。
- **修复建议**：`onCollapse` 中 `this.setData({ inputText: '' })`，并 triggerEvent 通知父级清 `fabText`。

### 🟡 M4. ocr-flow onSheetClose 未清空 fields
- **位置**：`components/ocr-flow/index.js:576` `onSheetClose` 仅 `setData({ 'ocrSheet.visible': false })`
- **风险**：状态残留。下次打开被覆盖，无功能问题，但若 `buildSheetFields` 异常可能显示旧字段。
- **修复建议**：补 `ocrSheet.fields: [], ocrSheet.policyIndex: -1, ocrSheet.title: ''`。

### 🟡 M5. edit-sheet / ocr-sheet 关闭未清 editFields/editTitle
- **位置**：
  - `pages/report/index.js:394` `onCloseEdit` 清三个 sheet 标志，未清 editFields/editTitle/_editMode
  - 同理 `onPolicySheetClose / closeMemberManage`
- **风险**：状态残留。若下次 `buildEditConfig` 失败或 mode 不匹配，可能显示旧字段配置。
- **修复建议**：`onCloseEdit` 补 `editFields: [], editTitle: '编辑', _editMode: ''`。

### 🟢 L1. proc-card 点击反馈不一致
- **位置**：`components/ocr-flow/index.wxml:30, 44` 用 `bindtap`，`:60` 用 `catchtap`
- **风险**：风格不统一，无功能影响。
- **修复建议**：统一为 `catchtap`。

### 🟢 L2. Sheet z-index token 同层级无区分
- **位置**：`pages/report/index.wxss:58, 79` policy-sheet-overlay 与 member-manage-overlay 均 `--z-sheet(200)`
- **风险**：状态互斥保证视觉不叠加，但 token 无层级语义，未来状态遗漏可能视觉错乱。
- **修复建议**：顶层 sheet 用 `--z-sheet-inner-top(311)`。

### 🟢 L3. OCR proc-list 空态未兜底
- **位置**：`components/ocr-flow/index.wxml:27-71` proc-list 无空态分支
- **风险**：理论路径不易触发，但缺乏兜底。
- **修复建议**：三组同时为空时显示"暂无识别结果"提示。

### 🟢 L4. FAB 发送按钮 disabled 时仍可点击
- **位置**：`pages/report/index.wxml:95` `.fab-send.is-disabled` 仅样式禁用，`bindtap=onFabSend` 未拦截
- **风险**：无功能问题（onSend 内部 `if (!text) return false` 拦截），但视觉与行为不一致。
- **修复建议**：补 `catchtap` 守卫或改为 `disabled` 属性。

---

## 检查项汇总矩阵

| 检查项 | index | clients | report | chat-panel | ocr-flow | edit-sheet | client-card |
|--------|-------|---------|--------|------------|----------|------------|-------------|
| Sheet 互斥 | N/A | N/A | ✅ | N/A | ✅ | N/A | N/A |
| Sheet 嵌套层级 | ✅ | N/A | ⚠️ L2 | ✅ | ✅ | ✅ | N/A |
| 遮罩阻止底层 | ✅ | N/A | ✅ | ✅ | ✅ | ✅ | N/A |
| 关闭清空状态 | ⚠️ M4 | N/A | ⚠️ M5 | ⚠️ M3 | ⚠️ M4 | ✅ | N/A |
| 下拉刷新与 Sheet 冲突 | N/A | ✅ | ✅ | ✅ | ✅ | N/A | N/A |
| chat-panel 阻止下拉 | N/A | N/A | ✅ | ✅ | N/A | N/A | N/A |
| scroll-view 冒泡 | N/A | N/A | ✅ | ✅ | ✅ | ✅ | N/A |
| 长按/滑动与点击冲突 | ✅ | ✅ | ✅ | N/A | ⚠️ L1 | N/A | ✅ |
| catchtouchmove 使用 | ✅ | N/A | ✅ | ✅ | ✅ | ✅ | N/A |
| 返回键拦截 | ❌ S1 | N/A | ❌ S1 | ✅ | N/A | N/A | N/A |
| FAB 展开阻止滚动 | ✅ | N/A | ✅ | N/A | N/A | N/A | N/A |
| FAB 键盘遮挡 | N/A | N/A | ❌ S3 | N/A | N/A | N/A | N/A |
| FAB 收起清空输入 | N/A | N/A | ⚠️ M3 | ⚠️ M3 | N/A | N/A | N/A |
| FAB 与 Sheet 互斥 | ✅ | N/A | ✅ | N/A | N/A | N/A | N/A |
| 必填字段标注 | N/A | N/A | ✅ | N/A | ❌ M2 | ✅ | N/A |
| 校验时机一致 | N/A | N/A | ✅ | N/A | ⚠️ M1 | ✅ | N/A |
| 错误提示位置一致 | N/A | N/A | ✅ | N/A | ❌ M1 | ✅ | N/A |
| 提交按钮禁用 | N/A | N/A | ✅ | N/A | ⚠️ M1 | ✅ | N/A |
| 长表单分组 | N/A | N/A | ⚠️ | N/A | ✅ | ⚠️ | N/A |
| 列表项点击反馈 | ✅ | ✅ | ✅ | ✅ | ⚠️ L1 | N/A | ✅ |
| 滑动/删除确认 | ✅ | ✅ | ✅ | N/A | ✅ | N/A | N/A |
| 长按反馈 | N/A | N/A | N/A | N/A | N/A | N/A | ✅ |
| 列表空态 | ✅ | ✅ | ✅ | ✅ | ⚠️ L3 | N/A | N/A |
| 键盘遮挡内容 | N/A | ⚠️ | N/A | N/A | ❌ S2 | ❌ S2 | N/A |
| adjust-position 配置 | N/A | ⚠️ | ❌ S3 | N/A | ❌ S2 | ❌ S2 | N/A |
| cursor-spacing 配置 | N/A | ❌ | ❌ S3 | N/A | ❌ S2 | ❌ S2 | N/A |
| 键盘弹起底部按钮上移 | N/A | N/A | ⚠️ | N/A | ❌ S2 | ❌ S2 | N/A |

---

## 总评

- **严重问题 3 项**：S1（OCR 返回键）、S2（Sheet 键盘遮挡）、S3（FAB 键盘适配）—— 影响功能可用性，建议优先修复。
- **中等问题 5 项**：M1-M5 —— 影响交互一致性与状态洁净度，建议迭代修复。
- **低级问题 4 项**：L1-L4 —— 打磨项，可批量处理。

**亮点**：
- report 页 `onPullDownRefresh` 的双防线设计（JS 检查 + catchtouchmove）思路成熟。
- report 页 `onBackPress` 对 edit-sheet / policy-sheet / member-manage / chat-panel 的层级关闭顺序合理。
- edit-sheet 的放弃修改二次确认（R-M7）与校验时机（失焦+提交）设计完善。
- client-card 用 `catchtap/catchlongpress` 显式阻止冒泡，注释说明完整。
- ocr-flow 的 catchtouchmove 注释明确指出真机穿透问题与修复思路。

**主要短板**：
- OCR 弹窗的返回键拦截在两个页面（index + report）都缺失。
- 三处输入框（FAB + edit-sheet + ocr-sheet）键盘适配未显式配置。
- 两套保单编辑表单交互割裂，未抽离为同一组件。
