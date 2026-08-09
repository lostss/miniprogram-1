# UI/UX 状态完整性审计报告

**审计维度**：加载态 / 错误态 / 空态 / 反馈时机 / 异常场景引导
**审计范围**：3 个页面 + 6 个组件
**审计日期**：2026-08-09
**项目路径**：`c:\Users\lyy\WeChatProjects\miniprogram-1\miniprogram`

---

## 一、按页面/组件分组评估

### 1. pages/index（首页 - 客户列表）

**文件**：`miniprogram/pages/index/index.js` + `index.wxml`

| 检查项 | 评估 | 说明 |
|---|---|---|
| **加载态** | ✅ 已覆盖 | 60s TTL 缓存 + 静默刷新策略完善：无缓存显示骨架屏（`sk-client-card` 含 shimmer），有缓存先渲染避免闪白 |
| **长操作进度反馈** | N/A | 首页无 >3s 长操作 |
| **loading 文案友好度** | ✅ 已覆盖 | 不使用模糊文案，直接以骨架屏承载；上传阶段由 ocr-flow 接管 |
| **多步 loading 阶段切换** | N/A | 无多步 loading |
| **网络错误提示+重试** | ✅ 已覆盖 | `loadError` 状态 + "客户列表加载失败 / 点击重试" 按钮（R-M5 修复，不再伪装成空数据引导） |
| **404 引导** | N/A | 首页列表无 404 场景 |
| **401 引导** | ⚠️ 部分覆盖 | `listFamilies` 失败统一进 `loadError`，无 401 自动重新登录流程（依赖全局初始化） |
| **错误类型区分** | ⚠️ 部分覆盖 | 仅"加载失败"，未区分网络/权限/服务异常 |
| **死胡同错误** | ✅ 已覆盖 | 重试按钮存在，不再伪装空态 |
| **空态引导** | ✅ 已覆盖 | `recentClients.length === 0 && !loadError` 显示 3 步引导（拍照→AI 识别→生成报告） |
| **空态 CTA** | ✅ 已覆盖 | "点击上传保单" 上传框 + FAB 按钮 |
| **按钮防连点** | ⚠️ 部分覆盖 | `onUploadTap` 直接委托给 ocr-flow，由组件内 `_ocrBusy` 守卫；首页本身无防抖 |
| **表单提交防重复** | N/A | 无表单 |
| **长操作可取消** | N/A | 无 |
| **toast 反馈** | ✅ 已覆盖 | 删除成功后刷新；客户异常时 `wx.showToast` |
| **流式打字机效果** | N/A | 首页无流式输出 |
| **OCR 失败手动录入** | N/A | 委托给 ocr-flow |
| **数据加载失败重试** | ✅ 已覆盖 | `onRetryLoad(true)` 绕过 60s TTL 强制刷新 |

**总结**：首页状态完整度高，错误态/空态分流清晰；唯一缺口是错误未细分类型。

---

### 2. pages/clients（客户管理）

**文件**：`miniprogram/pages/clients/index.js` + `index.wxml`

| 检查项 | 评估 | 说明 |
|---|---|---|
| **加载态** | ⚠️ 部分覆盖 | 仅 `loading-pulse` 单个圆点动画，无骨架屏；与首页体验不一致 |
| **长操作进度反馈** | N/A | 列表加载 |
| **loading 文案友好度** | ⚠️ 部分覆盖 | 无文案，仅动画 |
| **多步 loading 阶段** | N/A | 无 |
| **网络错误提示+重试** | ✅ 已覆盖 | `loadError` 状态 + toast + 错误态卡片含"重新加载"按钮（R-M5 修复区分错误态与真空态） |
| **404 引导** | N/A | 列表无 404 |
| **401 引导** | ⚠️ 部分覆盖 | 统一进 `loadError`，无 401 单独处理 |
| **错误类型区分** | ❌ 缺失 | 全部显示"加载失败 / 请检查网络后重试"，无网络/业务/权限区分 |
| **死胡同错误** | ✅ 已覆盖 | 重试按钮 + 下拉刷新（F-M6 修复 enablePullDownRefresh） |
| **空态引导** | ✅ 已覆盖 | 三种空态分流：搜索无结果 / 加载失败 / 无客户档案 |
| **空态 CTA** | ✅ 已覆盖 | "去首页上传"按钮引导 |
| **按钮防连点** | ✅ 已覆盖 | 搜索 debounce 300ms + 请求 seq 追踪（F-S1 修复旧请求覆盖问题） |
| **表单提交防重复** | N/A | 无 |
| **长操作可取消** | N/A | 无 |
| **toast 反馈** | ✅ 已覆盖 | 加载失败 toast |
| **流式打字机** | N/A | 无 |
| **OCR 失败手动录入** | N/A | 此页未涉及 OCR |
| **数据加载失败重试** | ✅ 已覆盖 | 下拉刷新 + 错误态按钮 |

**总结**：搜索逻辑防抖优秀；loading 体验与首页不一致，错误类型未细分。

---

### 3. pages/report（报告页 - 最复杂）

**文件**：`miniprogram/pages/report/index.js` + `index.wxml`

| 检查项 | 评估 | 说明 |
|---|---|---|
| **加载态** | ✅ 已覆盖 | 多块骨架屏（标题/摘要/卡片）+ 3 条 loading 文案轮播（`_loadingTexts` 每 2.5s 切换） |
| **长操作进度反馈** | ✅ 已覆盖 | 深度分析 60s 操作每 5s 更新已用秒数：`AI 分析中 Xs`（R-M1 修复） |
| **loading 文案友好度** | ✅ 已覆盖 | "小秘正在认真看保单..."、"整理报告..."、"加载报告..." 等具体动作描述 |
| **多步 loading 阶段** | ✅ 已覆盖 | loading → loadError → content 三阶段切换 |
| **网络错误提示+重试** | ✅ 已覆盖 | 错误态含"重新加载" + "返回首页"双按钮（R-S1 修复原空白死胡同） |
| **404 引导** | ✅ 已覆盖 | 404 弹窗"客户不存在 / 该客户档案已被删除或不存在"+ 强制返回首页（R-S2 移除"留在本页"死胡同选项） |
| **401 引导** | ✅ 已覆盖 | 401 弹窗"登录异常 / 请退出小程序重新进入"+ 留在本页选项 + 自动重试 3 次 |
| **错误类型区分** | ✅ 已覆盖 | 401/404/其他 三种分流（modalTitle 按 code 区分，R-S1 修复标题语义冲突） |
| **死胡同错误** | ✅ 已覆盖 | 所有错误路径均含操作出口 |
| **空态引导** | ✅ 已覆盖 | `!hasPolicy` 显示"暂无保单 / 点击下方金色按钮上传保单"引导卡（UC4 修复，替代零值红色告警） |
| **空态 CTA** | ✅ 已覆盖 | FAB 上传按钮 |
| **按钮防连点** | ✅ 已覆盖 | `editSaving` / `_analysisBusy` / `_refreshingReport` 三重 flag 守卫 |
| **表单提交防重复** | ✅ 已覆盖 | `editSaving` 标记 + 按钮禁用 |
| **长操作可取消** | ❌ 缺失 | **深度分析 60s 期间无取消入口**；OCR 进行中也无取消（仅在结果阶段可全部放弃） |
| **toast 反馈** | ✅ 已覆盖 | "小秘记下了"、"已删除"、"分析完成"、"已是最新分析"、"刷新失败" 等场景化文案 |
| **流式打字机** | N/A | 报告页本身不流式（由 chat-panel 接管） |
| **OCR 失败手动录入** | ✅ 已覆盖 | 由 ocr-flow 接管，本页 `onOcrFlowSaved` 刷新报告 |
| **数据加载失败重试** | ✅ 已覆盖 | `onRetryReport` + 下拉刷新 `onRefreshReport` |

**总结**：报告页状态完整度最高，401/404/错误三态分流完善；最大缺口是 60s 深度分析无法取消。

---

### 4. components/chat-panel（AI 对话面板）

**文件**：`miniprogram/components/chat-panel/index.js` + `index.wxml`

| 检查项 | 评估 | 说明 |
|---|---|---|
| **加载态** | ✅ 已覆盖 | `thinking` 三点动画 + 流式文本追加渲染 |
| **长操作进度反馈** | ⚠️ 部分覆盖 | 仅 thinking dots，无耗时显示；流式过程中无进度提示 |
| **loading 文案** | ⚠️ 部分覆盖 | 仅"小秘思考中"暗示，无具体动作描述 |
| **多步 loading 阶段** | ✅ 已覆盖 | thinking → 流式追加 → 后处理 record（_postProcessing 锁） |
| **网络错误提示+重试** | ✅ 已覆盖 | 错误消息内嵌 `isError: true` + "重试"按钮（onRetrySend 复用 retryText） |
| **404 引导** | N/A | 对话无 404 |
| **401 引导** | ⚠️ 部分覆盖 | 401 进 errorHandler 通用提示，未引导重新登录 |
| **错误类型区分** | ✅ 已覆盖 | `errorHandler.getErrorInfo(e)` 按 code 区分；F-S3 修复空消息残留 |
| **死胡同错误** | ✅ 已覆盖 | 错误消息附重试按钮 |
| **空态引导** | ✅ 已覆盖 | 空态显示 3 个引导 chip："查看当前家庭的保障情况"等 |
| **空态 CTA** | ✅ 已覆盖 | chip 点击即作为预设问题发送（onEmptyHintTap） |
| **按钮防连点** | ⚠️ 部分覆盖 | **发送按钮仅 CSS `is-disabled` 视觉禁用，仍可点击**；onSend 内有 `thinking/_postProcessing` 守卫拦截，但用户感知差 |
| **表单提交防重复** | ✅ 已覆盖 | thinking + _postProcessing 双锁 |
| **长操作可取消** | ❌ 缺失 | **AI 流式输出无法中止**；用户发出长问题后必须等待完整回复 |
| **toast 反馈** | ✅ 已覆盖 | "内容包含敏感指令，已拦截"、"没有更多了"、"链接已复制" |
| **流式打字机效果** | ✅ 已覆盖 | chat-source.send 增量回流 + markdown-render 80ms 节流渲染 |
| **AI 失败重试** | ✅ 已覆盖 | F-S5 修复 _postProcessing 期间禁重试，避免错误消息被移除后 onSend 被守卫拦截 |
| **权限不足引导** | ⚠️ 部分覆盖 | errorHandler 通用提示，无 403 单独引导 |

**总结**：对话流式与错误重试链路完善；两个核心缺口——发送按钮未真正禁用、AI 输出不可中止。

---

### 5. components/ocr-flow（OCR 识别流程）

**文件**：`miniprogram/components/ocr-flow/index.js` + `index.wxml`

| 检查项 | 评估 | 说明 |
|---|---|---|
| **加载态** | ✅ 已覆盖 | 5 阶段 phase 流转（upload/recognize/recognize-stream/done/saving/saved/failed/match/roles） |
| **长操作进度反馈** | ✅ 已覆盖 | 每秒更新 `elapsed`；上传阶段进度条 `uploaded/total`；识别流式阶段不定式动画（UC3 修复避免"卡住"误导） |
| **loading 文案友好度** | ✅ 已覆盖 | "正在上传 X/Y"、"正在处理 N 份保单"、"正在保存保单信息 · 请勿离开当前页面" |
| **多步 loading 阶段** | ✅ 已覆盖 | 阶段切换清晰；stream slots 实时显示每图状态（pending/ok/error） |
| **网络错误提示+重试** | ✅ 已覆盖 | OCR 异常进 `_procErrors` 列表，逐项重试 / 全部重试双出口 |
| **404 引导** | N/A | OCR 无 404 |
| **401 引导** | ⚠️ 部分覆盖 | 文件 fileId 失效回退本地重传；但 openid 未拿到时仅沿用 'anon' 前缀（归属校验会 403） |
| **错误类型区分** | ⚠️ 部分覆盖 | OCR 错误统一文案"识别失败"；区分 fileId 失效（file_gone）回退本地，但用户感知不到 |
| **死胡同错误** | ✅ 已覆盖 | not_policy 错误原 modal 拦截有卡死 bug 已修复（B方案统一进列表）+ 手动录入 + 预览 + 重试 |
| **空态引导** | ⚠️ 部分覆盖 | 全部失败时进入错误组列表；无保单无现价时 _doSave 直接关闭（无显式提示） |
| **空态 CTA** | N/A | 由错误组承担 |
| **按钮防连点** | ✅ 已覆盖 | `_ocrBusy` / `_saving` / `confirming` / `procBusy` 四重 flag 守卫 + 按钮 disabled |
| **表单提交防重复** | ✅ 已覆盖 | _saving 锁防 onFailedRetry 连点（审计 #8） |
| **长操作可取消** | ❌ 缺失 | **OCR 上传/识别期间无取消按钮**；仅 `onProcDiscardAll` 在结果阶段可用 |
| **toast 反馈** | ✅ 已覆盖 | "全部重试成功"、"已放弃本次结果"、"角色信息待同步"、"图片已过期" |
| **流式打字机** | N/A | 非文本流式 |
| **OCR 失败手动录入** | ✅ 已覆盖 | "手动录入"按钮 + 编辑 sheet 字段校验（A-S1/A-S2/A-S3） |
| **AI 失败重试** | N/A | 非 AI |
| **权限不足引导** | ⚠️ 部分覆盖 | openid 缺失沿用 'anon'，归属校验 403 时仅 toast "重试失败" |
| **数据加载失败重试** | ✅ 已覆盖 | onProcRetryOne / onProcRetryAll + 跨会话 checkResume 恢复 + 12h 过期清理 |

**总结**：状态机最复杂的组件，5 阶段 + 多 flag 防重入设计扎实；最大缺口是进行中无取消，最小化错误类型区分。

---

### 6. components/edit-sheet（编辑表单）

**文件**：`miniprogram/components/edit-sheet/index.js` + `index.wxml`

| 检查项 | 评估 | 说明 |
|---|---|---|
| **加载态** | ✅ 已覆盖 | `saving` 状态：按钮显示"保存中..." + `is-loading` 样式 |
| **长操作进度反馈** | N/A | 表单提交 |
| **loading 文案** | ✅ 已覆盖 | "保存中..." |
| **多步 loading 阶段** | N/A | 无 |
| **网络错误提示+重试** | ⚠️ 部分覆盖 | 网络错误委托父组件 errorHandler.handle；本组件不感知错误细节，仅通过 saving=false 反馈 |
| **404/401 引导** | N/A | 委托父组件 |
| **错误类型区分** | ⚠️ 部分覆盖 | 字段级 error 显示但无错误码区分；网络错误统一 toast |
| **死胡同错误** | ✅ 已覆盖 | 字段错误行内显示，保存按钮可重试 |
| **空态引导** | N/A | 表单组件 |
| **空态 CTA** | N/A | 无 |
| **按钮防连点** | ✅ 已覆盖 | `saving` flag + 按钮 `disabled="{{saving}}"` |
| **表单提交防重复** | ✅ 已覆盖 | onSave 内 if(saving) return |
| **长操作可取消** | ⚠️ 部分覆盖 | 保存中取消按钮也 disabled；用户无法中止进行中的保存 |
| **toast 反馈** | ✅ 已覆盖 | 校验失败 toast；保存成功由父组件 showToast |
| **流式打字机** | N/A | 无 |
| **数据加载失败重试** | N/A | 由父组件接管 |
| **异常场景引导** | ✅ 已覆盖 | R-M7 修复：dirty 字段关闭时弹"放弃修改？"确认 modal；输入即清错（_applyValue） |

**总结**：表单交互细节到位；网络错误反馈链路依赖父组件，本组件无独立错误兜底。

---

### 7. components/client-card（客户卡片）

**文件**：`miniprogram/components/client-card/index.js` + `index.wxml`

| 检查项 | 评估 | 说明 |
|---|---|---|
| **加载态** | N/A | 渲染组件 |
| **长操作进度反馈** | N/A | 无 |
| **loading 文案** | N/A | 无 |
| **多步 loading 阶段** | N/A | 无 |
| **网络错误** | N/A | 无网络 |
| **404/401 引导** | N/A | 无 |
| **错误类型区分** | N/A | 无 |
| **死胡同错误** | N/A | 无 |
| **空态引导** | ✅ 已覆盖 | `completeness === 0` 时隐藏圆环（避免显示 0% 负向反馈） |
| **空态 CTA** | N/A | 卡片非主入口 |
| **按钮防连点** | ✅ 已覆盖 | 长按触发振动反馈（wx.vibrateShort medium） |
| **表单提交防重复** | N/A | 无 |
| **长操作可取消** | N/A | 无 |
| **toast 反馈** | N/A | 委托父组件 |
| **流式打字机** | N/A | 无 |
| **异常场景引导** | ✅ 已覆盖 | onTap 直读 client._id（不依赖 observers 缓存），避免 _id undefined 导致 URL "familyId=undefined" 404 |

**总结**：纯展示组件，状态完整；404 防护设计周到（直读属性 + 父级空 _id 拦截 toast）。

---

### 8. components/markdown-render（Markdown 渲染）

**文件**：`miniprogram/components/markdown-render/index.js` + `index.wxml`

| 检查项 | 评估 | 说明 |
|---|---|---|
| **加载态** | ⚠️ 部分覆盖 | 流式场景 80ms 节流避免卡顿；但首次解析无 loading 占位 |
| **长操作进度反馈** | N/A | 渲染组件 |
| **loading 文案** | N/A | 无 |
| **多步 loading 阶段** | N/A | 无 |
| **网络错误** | N/A | 无网络 |
| **404/401 引导** | N/A | 无 |
| **错误类型区分** | ❌ 缺失 | **`parseMarkdown` 无 try/catch**；畸形 markdown（如不闭合代码块、不完整表格）可能抛错导致整组件崩溃 |
| **死胡同错误** | ⚠️ 部分覆盖 | 复制失败 toast "复制失败" 存在；但解析失败无 fallback |
| **空态引导** | ✅ 已覆盖 | 空 content → nodes=[] 不渲染任何内容（不崩溃） |
| **空态 CTA** | N/A | 无 |
| **按钮防连点** | ✅ 已覆盖 | 复制按钮通过 wx.setClipboardData 异步回调 |
| **表单提交防重复** | N/A | 无 |
| **长操作可取消** | N/A | 无 |
| **toast 反馈** | ✅ 已覆盖 | "已复制"、"表格已复制"、"话术已复制"、"复制失败" |
| **流式打字机** | ✅ 已覆盖 | content observer + 80ms 节流 setData |
| **异常场景引导** | ⚠️ 部分覆盖 | 表格全屏查看支持横向滚动；代码块复制；但解析失败无降级渲染 |

**总结**：流式渲染优化良好；解析异常未防御是潜在崩溃点。

---

### 9. components/report-markdown（报告 Markdown 渲染）

**文件**：`miniprogram/components/report-markdown/index.js` + `index.wxml`

| 检查项 | 评估 | 说明 |
|---|---|---|
| **加载态** | N/A | 渲染组件 |
| **长操作进度反馈** | N/A | 无 |
| **loading 文案** | N/A | 无 |
| **多步 loading 阶段** | N/A | 无 |
| **网络错误** | N/A | 无网络 |
| **404/401 引导** | N/A | 无 |
| **错误类型区分** | ⚠️ 部分覆盖 | `onLinkTap` wx.setClipboardData 无 fail 回调；复制失败无提示 |
| **死胡同错误** | N/A | 无 |
| **空态引导** | ❌ 缺失 | **chapters 数组为空时整组件渲染为空，无任何引导**（虽然父页面有 hasPolicy 兜底，但 report-markdown 自身无空态） |
| **空态 CTA** | N/A | 无 |
| **按钮防连点** | ✅ 已覆盖 | toggleChapter 折叠/展开 |
| **表单提交防重复** | N/A | 无 |
| **长操作可取消** | N/A | 无 |
| **toast 反馈** | ⚠️ 部分覆盖 | 链接复制仅 success 回调 toast，无 fail 处理 |
| **流式打字机** | N/A | 静态渲染 |
| **异常场景引导** | ⚠️ 部分覆盖 | 章节折叠状态保留（prev[c.key]）；customBlocks 经 normalizeBlock 补齐字段防 undefined |

**总结**：渲染逻辑稳健；空 chapters 与复制失败两处缺口需补强。

---

## 二、严重问题清单（按严重程度排序）

### 🔴 严重（P0）

#### S1. OCR 进行中无法取消
- **位置**：`components/ocr-flow/index.js` `_startOCR` + `index.wxml`
- **问题**：上传 9 张图后，OCR 识别 30-60s 期间用户无任何取消入口；只能等结束或杀进程
- **影响**：用户误传错图后只能干等，体验崩塌
- **修复建议**：phase=upload/recognize-stream 时显示"取消"按钮，触发后清理已上传 fileId + 关闭 mask

#### S2. AI 对话流式输出不可中止
- **位置**：`components/chat-panel/index.js` `onSend`
- **问题**：用户发出长问题后必须等待完整回复；thinking 期间无"停止生成"入口
- **影响**：误触长问题、AI 回复偏离主题时无法及时止损
- **修复建议**：thinking 时显示停止按钮，调用 chat-source 中断流式 + 保留已生成部分

#### S3. 深度分析 60s 不可取消
- **位置**：`pages/report/index.js` `onDeepAnalysis`
- **问题**：60s 长操作仅 `wx.showLoading` mask 锁屏，无取消入口；若 AI 卡死用户只能等 60s 超时
- **影响**：服务异常时用户被锁定无法操作
- **修复建议**：showLoading 改自定义 modal 含"取消"按钮，abort 当前 generateReport 请求

---

### 🟠 中等（P1）

#### M1. chat-panel 发送按钮未真正禁用
- **位置**：`pages/report/index.wxml` line 95
- **问题**：`<view class="fab-send pressable {{!fabText ? 'is-disabled' : ''}}" bindtap="onFabSend">` 仅 CSS 视觉禁用，仍可点击触发 onSend
- **影响**：虽然 onSend 内有 `thinking` 守卫拦截，但用户感知差（点了无反应）
- **修复建议**：onFabSend 内首行 `if (!this.data.fabText.trim()) return`（chat-panel 无 fabText 属性，应通过 panel.onSend 返回 false 时不反馈）

#### M2. chat-panel 历史加载失败无错误反馈
- **位置**：`components/chat-panel/index.js` `_loadHistory`
- **问题**：historyStore.load 失败时返回 0，仅显示"没有更多了"toast，无法区分"真的没有"与"加载失败"
- **影响**：网络抖动时用户误以为没历史
- **修复建议**：load 抛错时区分空 vs 错误，错误时显示"历史加载失败，下拉重试"

#### M3. markdown-render 解析无 try/catch
- **位置**：`components/markdown-render/index.js` `parseMarkdown`
- **问题**：方法内大量 split/match 操作无异常捕获；畸形 markdown 可能抛错导致整个 chat-panel 报告页崩溃
- **影响**：AI 输出格式异常时白屏
- **修复建议**：parseMarkdown 包 try/catch，失败时降级为纯文本 `<text>{{content}}</text>`

#### M4. report-markdown 空 chapters 无空态
- **位置**：`components/report-markdown/index.wxml`
- **问题**：chapters 为空时组件渲染为空，无任何提示
- **影响**：极端场景下（数据缺失）页面中部空白无引导
- **修复建议**：chapters.length === 0 时显示"报告内容生成中..."或错误兜底

#### M5. clients 页 loading 体验与首页不一致
- **位置**：`pages/clients/index.wxml` line 12
- **问题**：仅 `<view class="loading-pulse">` 单个圆点，无骨架屏；与首页 `sk-client-card` 风格不统一
- **影响**：跨页体验割裂
- **修复建议**：复用首页 sk-client-card 骨架屏样式

#### M6. ocr-flow 错误类型未细分
- **位置**：`components/ocr-flow/index.js` 错误处理
- **问题**：OCR 失败统一显示"识别失败"；区分不出"网络问题"vs"图片质量问题"vs"非保单"
- **影响**：用户不知该重试还是换图
- **修复建议**：error_code 映射到具体文案（如 not_policy → "未识别到保单，请确认图片"）

---

### 🟡 低（P2）

#### L1. 首页 onUploadTap 无防连点
- **位置**：`pages/index/index.js` `onUploadTap`
- **问题**：直接 selectComponent + chooseAndStart，无前端防抖
- **影响**：极端连点场景可能多次唤起 chooseMedia（虽然 ocr-flow 有 _ocrBusy 守卫）
- **修复建议**：可选——onUploadTap 内加 throttle 300ms

#### L2. report-markdown onLinkTap 复制失败无提示
- **位置**：`components/report-markdown/index.js` `onLinkTap`
- **问题**：`wx.setClipboardData` 仅 success 回调，无 fail 处理
- **影响**：剪贴板权限被拒时用户无感知
- **修复建议**：补 fail 回调 toast"复制失败"

#### L3. ocr-flow checkResume 在首页 onShow 自动弹模态
- **位置**：`pages/index/index.js` `onShow` → `ocrFlow.checkResume()`
- **问题**：用户每次进入首页都检查未完成批次，12h 内若有未完成直接弹"是否继续？"模态
- **影响**：干扰正常流程，用户可能已不关心上次未完成项
- **修复建议**：改为首页显示一个可忽略的"继续上次"小卡片，而非 modal 拦截

#### L4. ocr-flow openid 缺失时沿用 'anon' 前缀
- **位置**：`components/ocr-flow/index.js` line 127
- **问题**：openid 未拿到时 `_ownerPrefix = 'temp/anon'`，OCR 服务归属校验会 403
- **影响**：登录延迟场景下 OCR 永久失败，需用户重试
- **修复建议**：等待 openidPromise 完成后再上传（已有 await 但 catch 后沿用 anon）；catch 时改为提示"登录中，请稍后再试"

#### L5. client-card 长按删除依赖父级 confirmDeleteFamily
- **位置**：`components/client-card/index.js` `onLongPress`
- **问题**：组件本身仅 triggerEvent，确认 modal 在父级 family-actions.js
- **影响**：复用 client-card 时需重复实现删除逻辑
- **修复建议**：可接受现状（关注点分离）；或封装 confirmDeleteFamily 进 client-card 内部 trigger confirm

#### L6. chat-panel thinking 期间无耗时显示
- **位置**：`components/chat-panel/index.wxml` line 31-33
- **问题**：仅三点动画，无"已思考 Xs"反馈
- **影响**：AI 长时间思考时用户不知是否卡住
- **修复建议**：thinking 超过 5s 后显示"已思考 Xs"

#### L7. report 页 onSaveEdit catch 内未恢复 editSaving 完整状态
- **位置**：`pages/report/index.js` `onSaveEdit` line 357
- **问题**：catch 内 `this.setData({ editSaving: false })` 后调用 errorHandler.handle，但未关闭 showEdit
- **影响**：用户看到错误 toast 后表单仍开着（行为正确），但 saveBtn 已可重试
- **修复建议**：现状可接受；如需更明确，可在 catch 内根据 errorCode 决定是否关闭表单

---

## 三、整体评估

### 状态完整度评分

| 模块 | 加载态 | 错误态 | 空态 | 反馈时机 | 异常引导 | 综合 |
|---|---|---|---|---|---|---|
| pages/index | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **A** |
| pages/clients | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **B+** |
| pages/report | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **A+** |
| chat-panel | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | **A-** |
| ocr-flow | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **A** |
| edit-sheet | ⭐⭐⭐⭐ | ⭐⭐⭐ | N/A | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **A-** |
| client-card | N/A | N/A | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **A** |
| markdown-render | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | **B** |
| report-markdown | N/A | ⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | **B-** |

### 优势

1. **报告页 401/404/其他三态分流** 是全项目最佳实践，错误码精确映射 modalTitle 与文案
2. **OCR-flow 5 阶段 phase 状态机** 设计扎实，多 flag 防重入（_ocrBusy/_saving/confirming/procBusy）
3. **错误不再伪装空态**（R-M5 修复）已成全局策略，首页/clients 页均明确分流
4. **dirty 字段确认放弃**（R-M7）edit-sheet 交互细节到位
5. **流式渲染 80ms 节流** chat-panel 流畅度优化良好

### 系统性改进建议

1. **统一取消能力**：所有 >5s 的长操作（OCR/深度分析/AI 流式）均应提供取消入口
2. **统一错误类型区分**：所有 loadError 状态应至少区分 网络异常/服务异常/权限不足 三类
3. **统一 loading 体验**：clients 页与首页应共用骨架屏组件，避免体验割裂
4. **解析类组件加 try/catch**：markdown-render / report-markdown 需防御畸形输入
5. **真正的按钮禁用**：所有 `is-disabled` 视觉禁用必须配合 `bindtap` 内 return 守卫

---

**审计完成时间**：2026-08-09
**审计依据**：源码静态分析，未执行真机穿行测试
**审计人**：UI/UX 审计专家（Trae subagent）
