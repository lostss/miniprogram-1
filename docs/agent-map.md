# Agent 工作地图

> 目的：把"每轮先花 5~10 次 grep 找代码"变成"直接跳"。改代码前先在这里定位；
> 找不到再 `search_content`。维护原则：只写**已验证**的职责，不确定的标注 `?`，别猜。

## 一、每轮工作协议（2026-10-17 与用户约定）

1. **测试分级**：改单个文件 → 只跑相关 `npx jest tests/xxx.test.js`（≈5s）。
   **全量不手动跑** —— `pre-commit` 钩子已在提交时跑一遍（≈24s），手动跑是纯重复。
2. **内联脚本一律落文件**：`C:\Users\lyy\AppData\Local\Temp\*.js`，不用 `node -e`
   （Windows PowerShell 会吃掉转义，本仓已因此失败 3 次）。
3. **长文件不整读**：先 `search_content` 定位行号，再 `read_file(offset, limit)`。
4. **宽范围探索交 `code-explorer` 子代理**（过程不进主上下文）。
5. **README 部署记录 ≤5 行**（决策 + 守卫 + 测试数），细节写进 commit message。
6. **每轮 `git commit`（提交即本地留痕），`git push` 放宽到每 5 轮一次**（2026-10-17 用户确认）。
   远端滞后是预期的：本地提交已保证不丢工作；需要立即同步时用户会明说。

## 二、页面（只有 2 页，无 tabBar）

| 路径 | 职责 | 备注 |
|---|---|---|
| `miniprogram/pages/index/` | 客户列表 **= 小程序根页面**（2026-10-13 合并了 pages/clients） | 列表/搜索/建档弹窗(`.cf-*`)/`ocrFlow.checkResume()` 恢复提示/吸底新建按钮 |
| `miniprogram/pages/report/` | 客户详情 = 报告页 | 组装 checkup + report view + chapters；上传入口(`fab-upload`)/chat-panel/edit-sheet/成员管理 Sheet |

## 三、组件

| 组件 | 职责 |
|---|---|
| `client-card` | 列表卡片：家庭名 + 「N 天前更新」+ 已成交标记（无圆环，2026-10-17 移除） |
| `ocr-flow` | OCR 全流程（选图→上传→识别→结果弹窗→保存/匹配/角色卡→保存态）。**1000+ 行，改前先 grep** |
| `chat-panel` | 对话面板（`collapsed` 时完全渲染为空 → 底栏由 report 页的 `.fab-wrap` 承担） |
| `edit-sheet` | 统一编辑 sheet（view/edit 两态），报告页与 OCR 共用 |
| `report-markdown` | 章节渲染（TOC + custom blocks，`bind:policytape`/`tocnav` 等） |
| `markdown-render` | md 片段渲染 |

## 四、前端逻辑（`miniprogram/utils/`）

**报告相关（最常改）**
| 文件 | 职责 |
|---|---|
| `report-builder.js` | `buildReportView` —— 报告视图总入口（chapters/hero/summaryCards/risks/deep） |
| `report/chapter-builder.js` | 章节组装；`shared`（客户版）分支跳过成员/财务章、隐藏置信度 |
| `report/gap-engine.js` | `buildCoverageMatrix`（成员×险种矩阵）+ 缺口计算 |
| `report/gantt-builder.js` | 保障期间时间条（一年期只画当前保单年度 / 终身画到右端 / `止于N岁`） |
| `report/risk-alerts-builder.js` | TOP-N 风险预警（红黄绿 + `basis` 依据） |
| `report/timeline-builder.js` | 保障节点列表 |
| `report/data-normalizer.js` | family 原始数据 → 规范化（金额/日期/状态） |
| `checkup/organize.js` | **整理报告**视图：汇总卡/按成员/未归入/待完善/已覆盖险种（`_categoryList` 走 `canonCat`） |
| `coverage-summary.js` | 保障型保额按险种拆分（跨树契约：AI 摘要卡 / 整理汇总卡 / PDF 同源） |

**契约与判定（改这里要同步 `cloudfunctions/_shared/` 副本）**
| 文件 | 职责 |
|---|---|
| `thresholds.js` | 阈值 + `canonCat` 险种规范词（`医疗→医疗险`、`年金险→年金`） |
| `gap-core.js` | `evaluateCoverage` 等缺口核心 |
| `readiness.js` | 分析前置检查（ok / degraded / blocked） |
| `member-skeleton.js` | 骨架成员命名契约（`成员1/成员2…`，后端据此认领，**空名会失效**） |
| `policy-status.js` | 保单状态词表 |

**页面/写路径**
| 文件 | 职责 |
|---|---|
| `apiClient.js` | 云函数调用封装（`api('action', payload)`） |
| `domain-writes.js` | `savePolicyData` / `saveFamilyPatch`（唯一写路径） |
| `edit-form.js` | `buildEditConfig` / `validate` / `buildUpdateData`（编辑字段定义） |
| `family-actions.js` | 打开/删除家庭；`HOME_CACHE_KEY`（列表 SWR 缓存键） |
| `report-share.js` | 分享路径/token/标题/`reportMeta` |
| `facts-view.js` | 客户档案四档视图（关键属性/需留意/待核实/时间线） |
| `report-analysis.js` | 深度分析（AI 调用 + 可取消） |
| `member-echo.js` | 空态成员回显（"已建 N 位，姓名待补"） |
| 其余小工具 | `amount`/`calc-age`/`parse-expiry`/`cash-value-math`/`premium-trend`/`role-infer`/`md-*`/`custom-blocks`/`markers`/`pii-rules`/`injection-guard`/`track`/`session-store`/`history-store`/`errorHandler`/`callCloud`/`write-tools` |

## 五、云函数（`cloudfunctions/`）

| 目录 | 职责 |
|---|---|
| `_shared/` | 跨函数共享代码 —— **是同步副本**，改完必须 `node scripts/sync-shared.js`（pre-commit 会 `--check`） |
| `dataQuery/family-list.js` | `listFamilies` / `searchFamilies`（首页列表；投影字段见 `_projectFamilyList`） |
| `dataQuery/share.js` | 客户版脱敏 |
| `dataWrite/` | 保单/成员/家庭写入 |
| `reportAI/` | 报告 AI：`prompts.js`（写作约束）/ `index.js`（调用+预算）/ `parse-ai-json.js`（三级容错） |
| `ocrService/` | OCR + 条款提取。提取后有两道"事实校验"（`_shared/ocr-core.js`）：`applyNumericEvidence`（金额必须在 OCR 文本里出现）+ `applyEvidenceCheck`（AI 的 `field_evidence` 引用必须逐字存在、且值在引用内），任一失败把字段置信度压到 0.5 → 进待核对 |
| `reportPdf/` | 导出 PDF |
| `conversationAI/` | 对话 |
| `login/` `cleanup/` | 登录 / 清理 |

脚本：`scripts/sync-shared.js`（`--check` 校验漂移）、`scripts/hooks/pre-commit`（sync --check + 全量 jest）。

## 六、常见任务 → 从哪下手

- 改章节内容/顺序 → `utils/report/chapter-builder.js`
- 改矩阵/缺口/保额 → `report/gap-engine.js` + `gap-core.js`（阈值在 `thresholds.js`）
- 改首页列表卡 → `components/client-card/*` + `pages/index/*`
- 改建档流程 → `pages/index/index.js` 的 `onCreateFamily`/`createModal` 系列 + wxml `.cf-*`
- 改 OCR 结果弹窗 → `components/ocr-flow/*`
- 改报告空态 → `pages/report/index.wxml` 的 `.empty-report`（**注意它在 AI 折叠块内**）
- 改 AI 输出/prompt → `cloudfunctions/reportAI/prompts.js` + `parse-ai-json.js`
- 加守卫测试 → `tests/`，参考 `report-layout.test.js`（嵌套计数）与 `home-list.test.js`（剥注释）

## 七、坑位清单（都已实际踩过）

1. **`.page-view` 有常驻 transform** → `position:fixed` 的后代（OCR 遮罩、吸底按钮、弹窗）**必须放 `.page` 之外**，否则定位错乱。
2. **结构/文案断言前必须剥注释**：本仓习惯在注释里写"X 已移除（原 Y）"，直接扫原文会被注释命中（踩过 3 次）。
3. **PowerShell + `node -e`** 转义失效 → 脚本落文件。
4. **`_shared` 是同步源，其余全是副本**（2026-10-17 亲测）：`coverage-summary` 这类契约文件，
   必须改 `cloudfunctions/_shared/` 下的源，然后 `node scripts/sync-shared.js`。
   **改 `miniprogram/utils/` 里的副本会被 sync 反向覆盖**（我改完 → 跑 sync → 改动消失、测试变红）。
   判据：`sync-shared --check` 报 `[update] miniprogram/utils/xxx.js` 就说明那份是产物。
5. **WXSS 语法错误 = 整页白屏，且 jest 看不见**（2026-10-17 真机踩过）：
   给一行 CSS 追加属性时若原行末已有分号 → `;;` → 编译器报 `unexpected token ';'`。
   守卫：`tests/wxss-syntax.test.js`（双分号 / 块首分号 / 花括号平衡）。
   改 wxss 后**必须**跑它 —— 单测全绿 + lint 全绿 + pre-commit 全过，用户打开仍是白屏。
6. **同一组数字的标签与算法必须同口径**（2026-10-17 真机踩过）：
   卡片标签写「长期给付 · 寿险/重疾」，算法却用「保障型 − 一年期」→ 显示 300 万，
   而险种明细 寿险100+重疾210=**310** 万，差 10 万（一张一年期重疾保单）。
   规则：**按险种分的两组，就必须按险种算**（医疗/意外 → 额度；寿险/重疾 → 给付），
   并断言 `A + B === 总数`，否则两个口径会在真机上互相打脸。
7. **`wx:elif` 链必须紧邻**：中间夹一个独立 `wx:if` 会把链断掉（踩过）。
6. **`_fmt` 类相对时间**：`≥1 天直接返回 M/D` 会丢掉"多久没动"，改前想清楚语义。
