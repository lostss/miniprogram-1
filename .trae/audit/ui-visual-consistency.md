# UI/UX 视觉规范与信息层级审计报告

**审计维度**：视觉规范与信息层级
**审计范围**：miniprogram 目录下 10 个 .wxss 文件
**审计日期**：2026-08-09
**审计方法**：逐文件人工审阅，对照 8 类检查清单评估

---

## 审计范围文件清单

| # | 文件 | 类型 |
|---|------|------|
| 1 | `app.wxss` | 全局样式 / Token 定义 |
| 2 | `pages/index/index.wxss` | 页面 - 首页 |
| 3 | `pages/clients/index.wxss` | 页面 - 客户列表 |
| 4 | `pages/report/index.wxss` | 页面 - 报告 |
| 5 | `components/chat-panel/index.wxss` | 组件 - 对话面板 |
| 6 | `components/ocr-flow/index.wxss` | 组件 - OCR 流程 |
| 7 | `components/edit-sheet/index.wxss` | 组件 - 编辑表单 |
| 8 | `components/client-card/index.wxss` | 组件 - 客户卡片 |
| 9 | `components/markdown-render/index.wxss` | 组件 - Markdown 渲染 |
| 10 | `components/report-markdown/index.wxss` | 组件 - 报告 Markdown |

---

## 全局 Token 体系总览（app.wxss 基线）

app.wxss 定义了完整的 Token 体系，作为各文件评估基线：

- **颜色**：`--bg-*`（4 档背景）、`--accent-*`（5 档强调色）、`--green/--amber/--red` + `-dim`/`-deep` 变体、`--ok-*`（3 档）、`--text-primary/secondary/tertiary/disabled`（4 档文本）、`--tone-mid/low/modified`（置信度底色）
- **字号**：`--fs-tiny(20rpx)` → `--fs-hero(52rpx)` 共 9 档
- **间距**：`--sp-1(4rpx)` → `--sp-10(56rpx)` 共 13 档（含 `--sp-3-5` 修复补丁）
- **圆角**：`--r-sm(8rpx)` → `--r-full(9999rpx)` 共 6 档
- **字重/行高/字距**：4 档字重、5 档行高、4 档字距
- **动画**：4 档时长 + 4 种缓动
- **阴影**：4 档（sm/md/lg/sheet）
- **层级**：`--z-base` → `--z-toast` + `--z-fullscreen`

---

## 逐文件审计

---

### 1. `app.wxss`（全局样式）

#### 1. CSS 变量一致性 — ⚠️ 部分覆盖
- ✅ Token 体系完整，覆盖颜色/字号/间距/圆角/阴影/动画/层级
- ✅ 注释明确记录了 Token 收敛历史（如 `--sp-3-5` 修复、`--ok` 系收敛、`--tone-*` 收敛、`--z-fullscreen` 纳入）
- ⚠️ 阴影硬编码 `rgba(60,50,30,0.04~0.08)`（行 106-109），虽是主题色衍生但未 token 化为 `--shadow-color`
- ⚠️ 遮罩硬编码 `rgba(26,26,46,0.35/0.6/0.4)`（行 116-119），已部分收敛为 `--overlay-*` token，但 token 值本身仍硬编码
- ⚠️ `tap-highlight-color: rgba(201,169,110,0.15)`（行 129）硬编码
- ❌ **无暗色模式**：无 `@media (prefers-color-scheme: dark)` 块，所有颜色为单一暖白主题，变量未分 light/dark

#### 2. 字号规范 — ✅ 已覆盖
- ✅ 9 档字号 token，层级清晰（tiny/caption/base/body/lg/xl/2xl/display/3xl/hero）
- ✅ 注释说明已消除 26/30 两档 2rpx 重复
- ✅ 最小字号 `--fs-tiny: 20rpx` = 10pt，略低于 11px 建议但属于辅助文字范畴

#### 3. 间距规范 — ✅ 已覆盖
- ✅ 13 档间距 token，4rpx 步进
- ✅ `--sp-3-5` 已补齐（注释说明原缺失导致 ocr-flow padding 失效）

#### 4. 圆角规范 — ✅ 已覆盖
- ✅ 6 档圆角 token（sm/md/lg/xl/2xl/full）

#### 5. 颜色语义 — ✅ 已覆盖
- ✅ 主色（accent）克制使用，语义色（green/amber/red/ok）统一
- ✅ 文本 4 档层级清晰
- ✅ 背景使用 `--bg-*` 而非硬编码白色
- ✅ 多处注释记录了对比度修复（#② 系列：accent 白字 2.24:1 不达标改深色文字）

#### 6. 信息层级 — N/A
- 全局文件，无具体 UI 区块

#### 7. 可访问性 — ⚠️ 部分覆盖
- ✅ `@media (prefers-reduced-motion: reduce)` 已处理（行 244-258）
- ✅ 多处对比度修复注释（WCAG AA 达标）
- ❌ 无暗色模式支持（低视力/夜间场景缺失）
- N/A 点击区域（全局无具体控件）

#### 8. 响应式适配 — N/A
- 全局工具类 `.truncate` 提供了文本截断
- 全局 `env(safe-area-inset-*)` 已使用

---

### 2. `pages/index/index.wxss`（首页）

#### 1. CSS 变量一致性 — ⚠️ 部分覆盖
- ✅ 大量使用 token（`--bg-*`, `--sp-*`, `--fs-*`, `--r-*`, `--accent-*`, `--text-*`）
- ❌ `border:1rpx solid rgba(0,0,0,0.04)`（行 53）硬编码 rgba 边框，应使用 `--border`
- ❌ `box-shadow:0 8rpx 24rpx rgba(201,169,110,0.3)`（行 31）硬编码阴影，应使用 `--shadow-*` 或新增 token

#### 2. 字号规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--fs-*` token
- ❌ `letter-spacing:6rpx`（行 8）硬编码，应为 `--ls-wider(4rpx)` 或新增 token
- ❌ `letter-spacing:2rpx`（行 20, 23）硬编码，无对应 token（介于 `--ls-wide(1rpx)` 和 `--ls-wider(4rpx)` 之间）

#### 3. 间距规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--sp-*` token
- ❌ `padding-top:80rpx`（行 6, 11, 17）、`padding-top:100rpx`（行 22）、`margin-top:80rpx`（行 17）、`margin-bottom:28rpx`（行 21）硬编码大间距，无对应 token（`--sp-7=40rpx`, `--sp-8=48rpx` 之间缺 80rpx 档）
- ❌ `margin:-8rpx -16rpx 0 0`（行 40）硬编码负边距

#### 4. 圆角规范 — ✅ 已覆盖
- ✅ 使用 `--r-xl`, `--r-full` 等 token
- ❌ `border-radius:6rpx`（行 57-59 骨架屏）硬编码，应为 `--r-sm(8rpx)`

#### 5. 颜色语义 — ✅ 已覆盖
- ✅ 文本层级清晰（`--text-primary/secondary/tertiary/disabled`）
- ✅ 背景使用 `--bg-*` token
- ✅ 强调色克制（仅 FAB 渐变 + 上传框边框）

#### 6. 信息层级 — ✅ 已覆盖
- ✅ 品牌标题（`--fs-display` + 衬线体）→ 标语（`--fs-tiny`）层级清晰
- ✅ 卡片名称（`--fs-lg` + semi）→ 标签（`--fs-caption`）→ 时间（`--fs-caption`）层级合理
- ✅ 圆环百分比（`--fs-tiny` + semi + tabular-nums）作为视觉焦点

#### 7. 可访问性 — ⚠️ 部分覆盖
- ✅ FAB 96rpx×96rpx = 48pt，满足 ≥44px
- ❌ `.search-clear` 48rpx×48rpx = 24pt，**点击区域过小**（< 44px）
- ⚠️ 焦点状态仅 `.upload-box:active` 有反馈，无明显 focus ring
- ✅ 禁用态 `--text-disabled` 区分

#### 8. 响应式适配 — ⚠️ 部分覆盖
- ✅ `.card-name` 使用 `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`
- ⚠️ 骨架屏尺寸硬编码（`width:120rpx/60rpx/160rpx`），长文本场景可能不匹配
- ⚠️ `width:280rpx` 上传框固定宽度，窄屏可能偏小

---

### 3. `pages/clients/index.wxss`（客户列表）

#### 1. CSS 变量一致性 — ⚠️ 部分覆盖
- ✅ 主要使用 token
- ❌ `padding:0 64rpx 0 var(--sp-5)`（行 7）混合硬编码与 token

#### 2. 字号规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--fs-*` token
- ❌ `font-size:24rpx`（行 9）硬编码，应为 `--fs-caption(24rpx)`

#### 3. 间距规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--sp-*` token
- ❌ `padding-top:160rpx`（行 25）硬编码大间距

#### 4. 圆角规范 — ✅ 已覆盖
- ✅ 使用 `--r-xl`, `--r-full` token

#### 5. 颜色语义 — ✅ 已覆盖
- ✅ 文本层级使用 token
- ✅ 按钮对比度已修复（注释 #②）

#### 6. 信息层级 — ✅ 已覆盖
- ✅ 空状态标题（`--fs-lg` + semi）→ 副文本（`--fs-caption`）层级清晰
- ✅ 按钮（`--fs-base` + semi）作为行动焦点

#### 7. 可访问性 — ⚠️ 部分覆盖
- ❌ `.search-clear` 48rpx×48rpx = 24pt，**点击区域过小**
- ✅ `.empty-btn` 80rpx 高度 = 40pt，略低于 44px 但接近
- ⚠️ `.search-input:focus` 仅边框色变化，无明显 focus ring

#### 8. 响应式适配 — ⚠️ 部分覆盖
- ⚠️ `height:72rpx` 搜索输入框固定高度，长文本输入无滚动处理
- ✅ 卡片间距使用 token

---

### 4. `pages/report/index.wxss`（报告页）

#### 1. CSS 变量一致性 — ⚠️ 部分覆盖
- ✅ 大量使用 token，注释记录了多次审计修复
- ❌ `box-shadow:0 8rpx 24rpx rgba(201,169,110,0.3)`（行 105）硬编码阴影
- ⚠️ `top:20rpx; right:20rpx`（行 74, 91）硬编码定位（数值等于 `--sp-5` 但未用 token）

#### 2. 字号规范 — ✅ 已覆盖
- ✅ 全部使用 `--fs-*` token，标题/正文/辅助层级清晰

#### 3. 间距规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--sp-*` token
- ❌ `width:176rpx`（行 70, 33 cancel-btn）、`width:320rpx`（行 135）硬编码按钮宽度
- ❌ `width:64rpx; height:6rpx`（行 60, 81 grabber）硬编码
- ❌ `width:64rpx; height:64rpx`（行 74, 91 close btn）硬编码

#### 4. 圆角规范 — ✅ 已覆盖
- ✅ 使用 `--r-xl`, `--r-2xl`, `--r-lg`, `--r-full` token
- ❌ `border-radius:3rpx`（行 60, 81 grabber）硬编码

#### 5. 颜色语义 — ✅ 已覆盖
- ✅ 语义色统一（`--red` 警告、`--ok` 成功、`--accent-deep` 强调）
- ✅ 文本层级清晰
- ✅ 多处对比度修复（#② 系列）

#### 6. 信息层级 — ✅ 已覆盖
- ✅ Hero 卡片：标题（caption + bold + accent-deep）→ 警告文本（body + red/ok）→ 摘要（caption）层级分明
- ✅ 摘要卡数字（`--fs-2xl` + bold + serif + tabular-nums）突出
- ✅ 报告标题（`--fs-3xl` + bold + serif）作为页面焦点
- ✅ 关键数字使用 `font-variant-numeric:tabular-nums` 对齐

#### 7. 可访问性 — ⚠️ 部分覆盖
- ❌ `.ps-close` 64rpx×64rpx = 32pt，**点击区域过小**
- ❌ `.mm-close` 64rpx×64rpx = 32pt，**点击区域过小**
- ✅ 主操作按钮 88rpx 高度 = 44pt，满足要求
- ✅ 禁用态 `opacity:0.7` 区分
- ⚠️ `.fab-input-active` 仅 box-shadow 变化，无明显 focus ring

#### 8. 响应式适配 — ⚠️ 部分覆盖
- ✅ `.ps-row-val` 使用 `word-break:break-all`
- ✅ `.sc-cell` 使用 `flex-wrap:wrap` 适配数字
- ⚠️ `.summary-card-grid` 三列固定，窄屏 + 长数字可能溢出
- ✅ Sheet `max-height:85vh` + 内部滚动

---

### 5. `components/chat-panel/index.wxss`（对话面板）

#### 1. CSS 变量一致性 — ✅ 已覆盖
- ✅ 全面使用 token（颜色/字号/间距/圆角/动画）
- ⚠️ `border-left:3rpx solid var(--accent-muted)`（行 13）硬编码边框宽度

#### 2. 字号规范 — ✅ 已覆盖
- ✅ 全部使用 `--fs-*` token

#### 3. 间距规范 — ✅ 已覆盖
- ✅ 全部使用 `--sp-*` token

#### 4. 圆角规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--r-*` token
- ❌ `border-radius:18rpx 6rpx 18rpx 18rpx`（行 20 bubble）硬编码非对称圆角
- ❌ `border-radius:3rpx`（行 3 drag-bar）硬编码

#### 5. 颜色语义 — ✅ 已覆盖
- ✅ AI 消息（主文字色 + 左边框）vs 用户气泡（accent 背景 + 深色文字）区分清晰
- ✅ 错误消息独立视觉（`--red` + `--red-dim`）
- ✅ 对比度已修复（#②）

#### 6. 信息层级 — ✅ 已覆盖
- ✅ 标题（body + semi + serif）→ 副标题（tiny）层级清晰
- ✅ 消息时间（tiny + disabled）弱化
- ✅ 建议词（caption + accent-deep）作为辅助焦点

#### 7. 可访问性 — ✅ 已覆盖
- ✅ `.thinking-row` `min-height:44rpx` 满足点击区域
- ✅ 错误消息有独立视觉区分
- ⚠️ `.retry-btn` padding 较小，点击区域可能不足 44px

#### 8. 响应式适配 — ✅ 已覆盖
- ✅ `.bubble` `max-width:82%` + `word-break:break-word`
- ✅ `.msg-inner` 底部留白适配输入栏

---

### 6. `components/ocr-flow/index.wxss`（OCR 流程）

#### 1. CSS 变量一致性 — ❌ 缺失严重
- ❌ `background:#FFFFFF`（行 109 input）硬编码白色，应使用 `--bg-card`
- ❌ `border:2rpx solid #c9c2b6`（行 50 radio）硬编码颜色，应使用 `--border` 或 `--text-disabled`
- ❌ `box-shadow:0 -4rpx 24rpx rgba(0,0,0,0.12)`（行 96）和 `rgba(0,0,0,0)`（行 95）硬编码阴影
- ⚠️ 多处 fallback 颜色 `var(--red-dim, #ebd8d2)`（行 18）、`var(--green-dim, #e8eddf)`（行 19）、`var(--ok-deep, #1a7f4f)`（行 43）等——这些 token 已在 app.wxss 定义，fallback 冗余但无害
- ⚠️ `background:var(--bg-error-soft, #fef2f2)`（行 30）fallback 指向未定义 token `--bg-error-soft`

#### 2. 字号规范 — ✅ 已覆盖
- ✅ 全部使用 `--fs-*` token

#### 3. 间距规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--sp-*` token（含修复的 `--sp-3-5`）
- ❌ `width:100rpx`（行 82 role-name）、`width:72rpx; height:72rpx`（行 31 thumb）、`width:36rpx; height:36rpx`（行 50 radio）硬编码尺寸
- ❌ `height:80rpx`（行 109 input）、`height:88rpx`（行 59, 62, 115, 118 按钮）硬编码

#### 4. 圆角规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--r-*` token
- ❌ `border-radius:3rpx`（行 8, 9 progress bar）硬编码

#### 5. 颜色语义 — ⚠️ 部分覆盖
- ✅ 语义色使用 token（`--red`, `--amber-deep`, `--ok-*`）
- ✅ badge 体系收敛为 `--ok-*` / `--amber-*` / `--accent-*`
- ❌ `#FFFFFF`、`#c9c2b6` 硬编码违反主题

#### 6. 信息层级 — ✅ 已覆盖
- ✅ 阶段标题（caption + tertiary）→ 进度条 → 待处理卡片层级清晰
- ✅ 三组列表（成功/待复核/失败）用左边框色区分
- ✅ badge 体系（ok/warn/cash）弱化辅助信息

#### 7. 可访问性 — ⚠️ 部分覆盖
- ❌ `.ocr-sheet-close` 56rpx×56rpx = 28pt，**点击区域过小**
- ✅ 主操作按钮 88rpx = 44pt
- ✅ `.proc-retry-btn.is-busy` `opacity:0.6` 禁用态区分
- ⚠️ `.match-radio` 36rpx = 18pt，但整张 match-card 可点击

#### 8. 响应式适配 — ⚠️ 部分覆盖
- ✅ `.proc-name` 使用 `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`
- ✅ `.match-members` 使用 ellipsis
- ⚠️ `.ocr-card` `max-width:640rpx` 固定，窄屏可能偏小
- ⚠️ `.proc-list` `max-height:56vh` 固定

---

### 7. `components/edit-sheet/index.wxss`（编辑表单）

#### 1. CSS 变量一致性 — ✅ 已覆盖
- ✅ 全面使用 token
- ⚠️ `margin:-16rpx -16rpx 0 0`（行 8）硬编码负边距

#### 2. 字号规范 — ✅ 已覆盖
- ✅ 全部使用 `--fs-*` token

#### 3. 间距规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--sp-*` token
- ❌ `width:176rpx`（行 33 cancel-btn）硬编码
- ❌ `width:88rpx; height:88rpx`（行 8 close）、`height:88rpx`（行 14, 32, 33）硬编码

#### 4. 圆角规范 — ✅ 已覆盖
- ✅ 使用 `--r-md`, `--r-lg`, `--r-2xl`, `--r-sm` token

#### 5. 颜色语义 — ✅ 已覆盖
- ✅ 语义色统一（`--red` 错误、`--amber-deep` 警告 badge）
- ✅ 置信度底色收敛为 `--tone-*` token（V-M1 修复）
- ✅ 对比度修复（#②）

#### 6. 信息层级 — ✅ 已覆盖
- ✅ 标题（lg + semi + serif）→ 表单标签（caption + tertiary）→ 输入值（body + primary）层级清晰
- ✅ 必填标记（`--red` + semi）突出
- ✅ 错误信息（caption + red + red-dim 背景）视觉区分

#### 7. 可访问性 — ✅ 已覆盖
- ✅ `.sheet-close` 88rpx×88rpx = 44pt，满足要求
- ✅ 按钮 88rpx 高度满足要求
- ✅ `.form-input:focus` 有边框 + 背景变化反馈
- ✅ `.save-btn[disabled]` `opacity:0.7` 区分
- ✅ `.form-row.has-error` 明确的错误状态视觉

#### 8. 响应式适配 — ✅ 已覆盖
- ✅ Sheet `max-height:85vh` + 内部滚动（`height:0; min-height:0` flex 技巧）
- ✅ `.form-input` `width:100%; box-sizing:border-box`

---

### 8. `components/client-card/index.wxss`（客户卡片）

#### 1. CSS 变量一致性 — ⚠️ 部分覆盖
- ✅ 主要颜色/字号使用 token
- ❌ `border:1rpx solid rgba(0,0,0,0.04)`（行 5）硬编码 rgba 边框，应使用 `--border`
- ⚠️ `width:4rpx`（行 11 装饰条）、`width:80rpx; height:80rpx`（行 23-24 ring）、`width:64rpx; height:64rpx`（行 25 ring-hole）硬编码尺寸

#### 2. 字号规范 — ✅ 已覆盖
- ✅ 使用 `--fs-lg`, `--fs-caption`, `--fs-tiny` token

#### 3. 间距规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--sp-*` token
- ❌ `padding:2rpx var(--sp-3)`（行 19）混合硬编码与 token

#### 4. 圆角规范 — ✅ 已覆盖
- ✅ 使用 `--r-xl`, `--r-full`, `--r-sm` token

#### 5. 颜色语义 — ✅ 已覆盖
- ✅ 卡片名称（primary）→ 标签（accent-deep + accent-dim）→ 时间（secondary）层级清晰
- ✅ 圆环百分比（primary + semi）作为视觉焦点

#### 6. 信息层级 — ✅ 已覆盖
- ✅ 名称（lg + semi）作为主焦点
- ✅ 标签 badge 弱化（caption + accent-dim 背景）
- ✅ 时间进一步弱化（caption + secondary）
- ✅ 圆环提供进度视觉化

#### 7. 可访问性 — ✅ 已覆盖
- ✅ 整卡可点击，满足区域要求
- ✅ `.card:active` `transform:scale(0.98)` 点击反馈
- ⚠️ 无明显 focus 状态（卡片通常无 focus，可接受）

#### 8. 响应式适配 — ✅ 已覆盖
- ✅ `.card-name` `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`
- ✅ `.card-body` `flex:1; min-width:0` 防溢出
- ⚠️ 圆环固定 80rpx，长百分比文本可能溢出（如 "100%"）

---

### 9. `components/markdown-render/index.wxss`（Markdown 渲染）

#### 1. CSS 变量一致性 — ❌ 缺失严重
- ❌ `font-family:'SF Mono', Monaco, 'Cascadia Code', monospace`（行 92）硬编码，应使用 `--font-mono`
- ❌ `background:rgba(0, 0, 0, 0)`（行 518）和 `rgba(0, 0, 0, 0.4)`（行 527）硬编码遮罩色，应使用 `--overlay-*` token
- ❌ `border:1rpx solid rgba(0,0,0,0.04)`（行 201, 213）硬编码 rgba 边框
- ❌ `border:2rpx solid #FFF`（行 496 task-check 勾选）硬编码白色
- ❌ SVG data URI 中硬编码颜色 `%23666666`、`%238A8A8A`、`%23C9A96E`（行 166, 171, 176, 356, 573, 635），无法随主题切换
- ⚠️ `transition:background 0.15s ease`（行 216）、`transform 0.15s ease`（行 347）、`background 0.3s ease`（行 523）硬编码时长与缓动，应使用 `--dur-*` / `--ease-*`

#### 2. 字号规范 — ✅ 已覆盖
- ✅ 全部使用 `--fs-*` token，标题 6 级层级清晰

#### 3. 间距规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--sp-*` token
- ❌ `padding:... 28rpx ...`（行 558, 674, 707, 722）硬编码 28rpx（等于 `--fs-body` 但用作 padding，未 token 化）
- ❌ `width:140rpx`（行 252）、`width:120rpx`（行 296）、`min-width:120rpx; max-width:400rpx`（行 672, 705）硬编码
- ❌ `margin-top:14rpx`（行 437）、`margin-top:6rpx`（行 480）、`top:4rpx; left:8rpx`（行 491-492）硬编码

#### 4. 圆角规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--r-*` token
- ❌ `border-radius:4rpx`（行 478 task-check）硬编码，非标准值

#### 5. 颜色语义 — ⚠️ 部分覆盖
- ✅ 文本层级使用 token
- ✅ 引用块使用 `--accent-*` 系列
- ❌ SVG 图标硬编码灰色，不随主题/语义变化
- ⚠️ `--accent` 用于链接和引用边框，语义略宽泛

#### 6. 信息层级 — ✅ 已覆盖
- ✅ 标题 6 级（3xl → body）层级分明
- ✅ 表格表头（semi）vs 单元格（normal）区分
- ✅ 键值对卡片：key（tertiary）vs value（primary）对比清晰
- ✅ 序号列表用衬线体 + accent-deep 突出

#### 7. 可访问性 — ❌ 缺失严重
- ❌ `.table-action-btn` 56rpx×56rpx = 28pt，**点击区域过小**
- ❌ `.table-fullscreen-close` 56rpx×56rpx = 28pt，**点击区域过小**
- ❌ `.task-check` 32rpx×32rpx = 16pt，**点击区域严重过小**
- ❌ `.quote-copy-icon` 24rpx = 12pt，**点击区域过小**
- ⚠️ `.code-copy` padding 较小，点击区域可能不足
- ✅ 表格奇偶行背景区分（可读性）

#### 8. 响应式适配 — ✅ 已覆盖
- ✅ `.md-table` `overflow-x:auto` 横向滚动
- ✅ `.table-body-cell` `word-break:break-word; overflow-wrap:break-word`
- ✅ `.kv-value` `word-break:break-word`
- ✅ 全屏表格模式适配窄屏
- ⚠️ `.table-fullscreen-cell` `min-width:120rpx; max-width:400rpx` 固定范围

---

### 10. `components/report-markdown/index.wxss`（报告 Markdown）

#### 1. CSS 变量一致性 — ⚠️ 部分覆盖
- ❌ `--missing-bg:#FFF0F0; --covered-bg:#F0FFF0`（行 2）**局部定义 CSS 变量**，应提升为全局 token（与 `--ok-dim` / `--red-dim` 语义重复）
- ⚠️ 多处 fallback `var(--green, #6B8E6B)`（行 70）、`var(--ok-deep, #1a7f4f)`（行 43）等——token 已定义，fallback 冗余
- ⚠️ `width:4rpx`（行 15 border-left）、`width:180rpx; height:180rpx`（行 20 gauge）、`width:84rpx/96rpx`（行 57-58）硬编码尺寸
- ⚠️ `left:13rpx`（行 39）、`margin-left:-34rpx`（行 41）、`margin-left:-16rpx`（行 48）硬编码定位

#### 2. 字号规范 — ✅ 已覆盖
- ✅ 全部使用 `--fs-*` token

#### 3. 间距规范 — ⚠️ 部分覆盖
- ✅ 多数使用 `--sp-*` token
- ❌ `min-height:56rpx`（行 64）、`min-height:96rpx`（行 32）硬编码
- ❌ `width:2rpx`（行 39 timeline 轴线）硬编码

#### 4. 圆角规范 — ✅ 已覆盖
- ✅ 使用 `--r-md`, `--r-lg`, `--r-sm` token

#### 5. 颜色语义 — ⚠️ 部分覆盖
- ✅ 语义色统一（`--red` 缺失/紧急、`--ok` 覆盖、`--amber` 部分覆盖、`--accent-deep` 强调）
- ❌ `#FFF0F0`、`#F0FFF0` 硬编码语义色，与 `--red-dim`、`--ok-dim` 重复且不一致
- ⚠️ `.tl-red/.tl-green/.tl-yellow`（行 42-44）使用 `--red/--green/--amber`，与 `--ok` 系并存可能混淆

#### 6. 信息层级 — ✅ 已覆盖
- ✅ 章节标题（display 数字 + xl 标题 + serif）→ h2（body + bold + 左边框）层级分明
- ✅ 仪表盘数值（display + bold + serif + accent-deep）作为核心焦点
- ✅ 矩阵状态色（ok/partial/missing/hold/blocked/na/total）语义清晰
- ✅ 紧急行动项（red 左边框 + bold）视觉突出
- ✅ 时间轴节点用颜色区分紧急程度

#### 7. 可访问性 — ⚠️ 部分覆盖
- ✅ `.fold-arrow` `min-height:44rpx` 满足点击区域
- ⚠️ `.pano-status` `min-height:56rpx` = 28pt，但通常不可单独点击
- ⚠️ 矩阵单元格颜色对比度需验证（如 `--accent-dim` 背景上的 `--text-secondary` 文字）
- ✅ 表头对比度已修复（#② 金色表头改深色文字）

#### 8. 响应式适配 — ✅ 已覆盖
- ✅ `.pano-wrap` `overflow-x:auto` 横向滚动（V-S6 修复）
- ✅ `.md-root` `word-break:break-word; overflow-wrap:break-word`
- ✅ `.ft-nodes` `flex-wrap:wrap` 自适应排列
- ✅ `.fin-grid` flex 布局适配

---

## 严重问题清单（按严重程度排序）

### 🔴 严重（影响可访问性 / 主题一致性）

| # | 问题 | 文件 | 行号 | 风险 |
|---|------|------|------|------|
| S1 | **全局无暗色模式** | `app.wxss` | - | 所有页面仅暖白主题，无 `@media (prefers-color-scheme: dark)`，夜间/低视力场景缺失，所有 token 未分 light/dark |
| S2 | **多处点击区域 < 44px** | 多文件 | 见下表 | 违反 iOS HIG / WCAG 2.5.5，误触率高 |
| S3 | **硬编码白色 `#FFFFFF`** | `ocr-flow/index.wxss` | 109 | OCR 编辑输入框背景不随主题切换 |
| S4 | **硬编码颜色 `#c9c2b6`** | `ocr-flow/index.wxss` | 50 | 匹配弹窗 radio 边框颜色脱离 token 体系 |
| S5 | **局部定义语义 CSS 变量** | `report-markdown/index.wxss` | 2 | `--missing-bg:#FFF0F0; --covered-bg:#F0FFF0` 与全局 `--red-dim`/`--ok-dim` 语义重复且色值不一致 |
| S6 | **SVG 图标硬编码颜色** | `markdown-render/index.wxss` | 166,171,176,356,573,635 | data URI 中 `%23666666` 等颜色无法随主题/状态切换 |

**点击区域不达标明细（S2）：**

| 控件 | 文件 | 尺寸 | 实际 pt | 标准 |
|------|------|------|---------|------|
| `.search-clear` | index/clients | 48rpx | 24pt | ❌ |
| `.ps-close` | report | 64rpx | 32pt | ❌ |
| `.mm-close` | report | 64rpx | 32pt | ❌ |
| `.ocr-sheet-close` | ocr-flow | 56rpx | 28pt | ❌ |
| `.table-action-btn` | markdown-render | 56rpx | 28pt | ❌ |
| `.table-fullscreen-close` | markdown-render | 56rpx | 28pt | ❌ |
| `.task-check` | markdown-render | 32rpx | 16pt | ❌ 严重 |
| `.quote-copy-icon` | markdown-render | 24rpx | 12pt | ❌ 严重 |

### 🟠 中等（影响规范一致性 / 可维护性）

| # | 问题 | 文件 | 行号 | 风险 |
|---|------|------|------|------|
| M1 | **硬编码 `rgba(0,0,0,0.04)` 边框** | index, client-card, markdown-render | 53/5/201,213 | 多处卡片/表格边框使用硬编码 rgba，未使用 `--border` token |
| M2 | **硬编码阴影 `rgba(201,169,110,0.3)` / `rgba(0,0,0,0.12)`** | index, report, ocr-flow | 31/105/96 | FAB/按钮/sheet 阴影脱离 `--shadow-*` 体系 |
| M3 | **`font-family` 硬编码** | markdown-render | 92 | 代码块字体硬编码，未使用 `--font-mono` token |
| M4 | **硬编码 `rgba(0,0,0,0.4)` 遮罩** | markdown-render | 527 | 全屏表格遮罩未使用 `--overlay-*` token |
| M5 | **硬编码 `transition` 时长/缓动** | markdown-render | 216,347,523 | `0.15s ease` / `0.3s ease` 未使用 `--dur-*` / `--ease-*` token |
| M6 | **硬编码 `letter-spacing`** | index | 8,20,23 | `6rpx` / `2rpx` 无对应 token |
| M7 | **硬编码大间距（80rpx/100rpx/160rpx）** | index, clients | 6,11,17,22/25 | 间距体系缺 80rpx+ 档位，多处硬编码 |
| M8 | **硬编码按钮宽度（176rpx/320rpx）** | report, edit-sheet | 70,135/33 | 取消按钮宽度未 token 化 |
| M9 | **硬编码圆角 `3rpx` / `4rpx` / `6rpx`** | 多文件 | - | 非标准圆角值，未纳入 `--r-*` 体系 |
| M10 | **硬编码 `border-radius:18rpx 6rpx 18rpx 18rpx`** | chat-panel | 20 | 气泡非对称圆角硬编码 |
| M11 | **硬编码字号 `24rpx`** | clients | 9 | 应使用 `--fs-caption` |
| M12 | **fallback 指向未定义 token `--bg-error-soft`** | ocr-flow | 30 | `var(--bg-error-soft, #fef2f2)` 的 token 未在 app.wxss 定义 |

### 🟡 低（影响细节体验 / 一致性）

| # | 问题 | 文件 | 行号 | 风险 |
|---|------|------|------|------|
| L1 | **多处 `width/height` 硬编码（图标/圆环/缩略图）** | 多文件 | - | 80rpx/64rpx/56rpx/36rpx 等尺寸未 token 化 |
| L2 | **负边距硬编码** | index, edit-sheet | 40/8 | `-8rpx -16rpx` / `-16rpx -16rpx` 未 token 化 |
| L3 | **`top/right:20rpx` 硬编码定位** | report | 74,91 | 数值等于 `--sp-5` 但未用 token |
| L4 | **骨架屏尺寸硬编码** | index | 57-60 | `120rpx/60rpx/160rpx` 固定，长文本不匹配 |
| L5 | **fallback 冗余** | ocr-flow, report-markdown | - | 多处 `var(--ok, #4A9C6D)` fallback 指向已定义 token，冗余但无害 |
| L6 | **`--green` 与 `--ok` 系并存** | report-markdown | 43,70 | 时间轴用 `--green`，badge 用 `--ok`，语义重叠可能混淆 |
| L7 | **`.empty-btn` 80rpx 高度略低于 44px** | clients | 29 | 40pt，接近但不满足 HIG |

---

## 总结评估

### 整体优点
1. **Token 体系设计完整**：app.wxss 定义了覆盖颜色/字号/间距/圆角/阴影/动画/层级的完整 token 体系，且注释记录了多次审计修复历史（#② 对比度、V-M1 置信度收敛、V-S1/V-S2/V-S3 未定义 token 修复等）
2. **对比度意识强**：多处注释显示已系统性修复 accent 白字 2.24:1 不达标问题，改用深色主文字色（7.62:1）
3. **信息层级清晰**：各页面/组件均有明确视觉焦点（数字用 serif + bold + tabular-nums，标题用衬线体），次要信息通过颜色/字号弱化
4. **响应式基础良好**：关键文本容器普遍使用 `word-break` / `overflow-wrap`，表格支持横向滚动，Sheet 限高 + 内部滚动
5. **弹层叠加层级已治理**：z-index 纳入 token 体系，注释记录了 `--z-fullscreen` / `--overlay-inner` 收敛

### 主要风险
1. **暗色模式完全缺失**（S1）：当前为单一暖白主题，无夜间模式
2. **点击区域系统性不达标**（S2）：8 处控件 < 44px，集中在关闭按钮和 Markdown 组件内的小图标
3. **markdown-render 组件 token 化最弱**：硬编码字体/颜色/阴影/动画，SVG 图标颜色无法主题化
4. **语义色存在重复定义**（S5/L6）：`--missing-bg`/`--covered-bg` vs `--red-dim`/`--ok-dim`，`--green` vs `--ok` 系并存
5. **间距体系缺大档位**（M7）：80rpx/100rpx/160rpx 多处硬编码，建议补充 `--sp-11:64rpx` / `--sp-12:80rpx` / `--sp-14:112rpx` 档位

### 建议优先级
1. **P0**：修复点击区域（S2）→ 提升暗色模式（S1）→ 收敛硬编码颜色（S3/S4/S5/S6）
2. **P1**：收敛硬编码阴影/边框/字体/动画（M1-M5）→ 补充间距/圆角 token 档位（M7/M9）
3. **P2**：细节 token 化（L1-L7）
