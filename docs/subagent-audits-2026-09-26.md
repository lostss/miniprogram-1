# dsh 子代理审计产出（2026-09-26 会话 session-fe7c74fa）

> 由 dsh 派出的 **5 个只读子代理**各自的最终报告，**原文收录**（我未改写）。
> 提取方式：`.codebuddy/skills/dsh-review/scripts/extract-session.js --subagents`
> 规模：约 550 行；级别标记计数 P1=11 / P2=47 / P3=46（含叙述性重复，**去重后见 README 复审条目**）。
> ⚠️ **第 5 份自带 CAVEAT**：审计期间工作区正被并发编辑（db-helpers 13:32 重写、family-write 也在改）→ 部分发现可能**已修或已过时**，需逐条复核。
> ⚠️ 第 4 份的 P0（callCloud 超时同步 reject）已被 dsh 在审计中途自行修复并加测试钉住，子代理独立观测到了同一件事（13:28 观测 → 13:31 修复）。

---

子代理回执 5 份（全文）

───────── 回执 1/5 ─────────
Agent 1c8d731f-0200-4aa6-ab1f-51ae0d16fd9c sent a message:  UI/UX audit complete — native WeChat mini program at C:\Users\lyy\WeChatProjects\miniprogram-1 (READ-ONLY: no repo file was created or modified; scratch scripts lived in $env:TEMP). 52 findings, 243 lines, 2×P1, 15×P2, rest P3. Files read in full: all 3 pages (index/report/clients), all 6 components (chat-panel, client-card, edit-sheet, markdown-render, ocr-flow, report-markdown) wxml+wxss+json+js, app.json/app.wxss/theme.json, plus the copy-bearing utils (report-builder, chapter-builder, data-normalizer, facts-view, edit-form, errorHandler, report-analysis, history-store, report-share, family-actions). Contrast ratios computed with a node script (WCAG relative luminance); the two P1s are: (1) with zero clients the 客户列表 page — and therefore 手动新建客户 — is unreachable because 「全部」 lives inside `wx:if="{{recentClients.length > 0 || loadingClients}}"` (pages/index/index.wxml:39-46 vs pages/clients/index.wxml:52); (2) the OCR hard-failure `wx.showModal` at components/ocr-flow/index.js:246 has `showCancel:false` and a single 重试 button that restarts the same failing path — a trap with no exit on iOS. Full report below.

---

# 保小秘 UX 审计（只读）— miniprogram-1

Stack: native WeChat mini program (WXML/WXSS/JS). Skill rules translated to mini-program primitives:
`hover-class` → the project uses `:active` + a global `.pressable` class instead (webview renderer, works);
`catchtap` = stop-bubbling tap; `wx.showModal`/`showActionSheet` = native dialogs; `env(safe-area-inset-*)` for notch;
`rpx` (750rpx = 375pt, so 88rpx = 44pt); `aria-label` is supported, `aria-role` is never used (see Consistency).
Contrast ratios computed with a scratch node script under `$env:TEMP` (no repo files touched).

## States

[severity: P1] `components/ocr-flow/index.js:246` — OCR hard-failure dialog is a single-button **retry loop with no exit**
- Evidence: `wx.showModal({ title: '识别失败', content: '遇到点问题，请重试', showCancel: false, confirmText: '重试', success: function() { if (!this._disposed) this._startOCR(tempFiles) }.bind(this) })`. `showCancel:false` + the only button re-entering the same code path. On a deterministic failure (403 ownership check, invalid image, OCR service down) every retry re-shows the same modal; the `ocr-mask` (`index.wxml:3`) stays visible underneath, and while it is visible `_applyBackGuard()` (`:138-147`) arms `wx.enableAlertBeforeUnload`. iOS users have no dismiss gesture and no second button → only killing the mini program escapes.
- Fix: add a second action (`cancelText:'先不处理'` → `setData(flow.hide())` + `_clearBatch()`), or forward to the error-list path used at `:238-243` (which already renders an error card with 手动录入/重试/移除 per-item exits).
- Confidence: high

[severity: P2] `components/chat-panel/index.js:122-125` + `index.js:100` — chat history load failure renders as a **fresh empty conversation**
- Evidence: `_loadHistory` returns `-1` on error (`if (r.error) return -1`), but `_expandPanel()` does `this._loadHistory().then(() => this._scrollAfterRender())` and ignores the return value. WXML `index.wxml:10` then shows `wx:if="{{!messages.length && !thinking}}"` → the onboarding empty state 「小秘可以帮你 / 试试这样问」. Only `onPullRefresh` (`:435`) surfaces `加载失败，请稍后重试`.
- Impact: agent opens chat for a client, sees the first-run empty state, concludes the conversation history was lost.
- Fix: in `_expandPanel`, check the resolved count; when `-1`, set a `historyError` flag and render "对话记录加载失败 · 重试" in place of `msg-empty`.
- Confidence: high

[severity: P2] `components/ocr-flow/index.wxss:3,30` — nested vertical scrollers in the OCR sheet
- Evidence: `.ocr-card { max-height:78vh; overflow-y:auto }` contains `.proc-list { max-height:56vh }` inside `<scroll-view scroll-y>` (`index.wxml:32`). Two nested vertical scroll regions: the inner list consumes the gesture until it hits its end, so with a 9-image batch users cannot tell whether the card or the list is scrolling, and the card's own scroll is the only route to the 放弃全部/确认 row.
- Fix: drop the outer `overflow-y:auto` for the `done` phase (let the inner list be the single scroller with `height:56vh`), or remove the inner max-height and let the card scroll.
- Confidence: medium

[severity: P3] `pages/report/index.js:591-611` — up to 3 sequential retries with no "retrying" indication
- Evidence: `_startLoading()` is only called for `retry === 0`; on 401 it retries 3×1200ms, other codes 2×800ms, while the skeleton + rotating `loadingText` (`:725`) keep cycling 「小秘正在看保单...」. A 401 chain can hold the skeleton past 30s with no change in message.
- Fix: append an attempt counter to `loadingText` (`第 2 次尝试…`) or show the error card immediately with a 重试 button.
- Confidence: high

[severity: P3] `pages/report/index.js:42,853,883` — `refreshing` is dead state
- Evidence: `refreshing: false` in `data`, set in `onRefreshReport` (`:853`) and reset (`:883`), but never referenced in `index.wxml`. During a non-silent refresh the only feedback is `wx.showLoading({title:'正在刷新报告...', mask:true})` (`:856`).
- Fix: delete the field, or bind it to a thin progress bar so silent refreshes from OCR/chat have a visible "报告更新中" affordance.
- Confidence: high

[severity: P3] `pages/index/index.js:62` / `pages/report/index.js:264-266` — silent partial-data failure for 客户档案
- Evidence: `_loadFacts` swallows errors (`console.error` only) and leaves `factsView` null → `index.wxml:177 wx:if="{{factsView}}"` hides the whole card. The card can be present on one refresh and gone on the next with no explanation.
- Fix: keep a `factsError` flag and render 「客户档案加载失败 · 重试」 inside the card shell.
- Confidence: medium

[severity: P3] `pages/report/index.js:509` vs `utils/report/chapter-builder.js:391` — "hasPolicy" counts soft-deleted policies
- Evidence: `hasPolicy: !!(c.policies && c.policies.length > 0)` while the appendix renders `policies.filter(p => p.status !== 'deleted')` and 保障汇总 uses `active` only. A family whose policies are all `deleted` skips the `暂无保单` empty state (`index.wxml:59`) and shows a summary card of zeros / an empty matrix instead.
- Fix: `hasPolicy = c.policies.some(p => p.status !== 'deleted')`.
- Confidence: medium

## Navigation & orientation

[severity: P1] `pages/index/index.wxml:39-46` — with zero clients the **客户列表 page (and 手动新建客户) is unreachable**
- Evidence: the only link to `/pages/clients/index` is `index.js:116 onViewAll`, bound to 「全部」 at `index.wxml:42`, which lives inside `<view class="clients-section" wx:if="{{recentClients.length > 0 || loadingClients}}">` (`:39`). With 0 clients the section is hidden and the empty state only offers 上传保单 (`:10-14`). 新建客户 lives only on that page: `clients/index.wxml:11` (`＋`, aria-label 新建客户) and `:52` (`手动新建客户`).
- Impact: exactly the scenario the feature was written for — `clients/index.js:85-87` comments 「第一次见面、还没拿到保单时无处建档」— is still unreachable for a brand-new user; they must upload a policy first.
- Fix: render the 全部/新建 entry regardless of list length (move the header out of the `wx:if`, or add 手动新建客户 to the index empty state).
- Confidence: high

[severity: P2] `pages/index/index.wxml:2` + `index.wxss:6` — `page-fixed { overflow:hidden }` makes the empty state unscrollable
- Evidence: `class="page page-view {{recentClients.length === 0 && !loadingClients && !ocrBusy ? 'page-fixed' : ''}}"` → `.page-fixed { overflow:hidden }`. The empty state stacks `padding-top:var(--sp-13)`(120rpx) + 200rpx upload box + 80rpx steps + 100rpx hint (`index.wxss:9,14,20,25`) ≈ 780rpx + text. Under large system font / small viewport it overflows with no way to scroll to the bottom.
- Fix: `overflow-y:auto` (or drop `page-fixed` and rely on the short content).
- Confidence: medium

[severity: P3] `pages/clients/index.js:83` — 「去首页上传」 uses a bare `wx.navigateBack()`
- Evidence: `onGoUpload() { wx.navigateBack() }` — no `fail` fallback (compare `report/index.js:695` which does `wx.navigateBack({ fail: () => wx.reLaunch(...) })`). If the page is ever the stack bottom (re-entry after a relaunch), the button does nothing.
- Fix: add `fail: () => wx.reLaunch({ url: '/pages/index/index' })`.
- Confidence: medium

[severity: P3] `pages/report/index.json:1-10` — report page has no `navigationBarTitleText`
- Evidence: the page inherits the app title 「保小秘」(app.json:11); the nav bar never says 报告 nor the client name, while `pages/index` and `pages/clients` both set titles. For a customer opening a shared report the nav bar gives no orientation.
- Fix: `wx.setNavigationBarTitle({ title: name + '保障报告' })` in `_applyReportData`.
- Confidence: medium

Positives worth recording: no tab bar is used, every page returns via the native back arrow, `scroll-view` + `scroll-top` TOC nav works (`report/index.js:274-280`), FAB bars are in normal flow (`report/index.wxss:194`) so scroll content is never hidden behind them, `pages/index` reserves `176rpx + safe` (`index.wxss:5`), and safe-area is applied on `.fab`, `.fab-wrap`, all bottom sheets, and the full-screen table header/footer.

## Touch targets & interaction

[severity: P2] `pages/report/index.wxss:113` — 客户档案 collapse header is the only entry point and is ~45rpx (≈22pt) tall
- Evidence: `.facts-head { display:flex; align-items:center; gap:var(--sp-3) }` — no padding, no min-height, no `::after` expansion; the tallest child is `.facts-title` at `--fs-lg` 36rpx (`:114`). `index.wxml:178` the whole header is the tap target (`bindtap="onToggleFacts"`).
- Fix: add `min-height:88rpx` (or the project's `::after` 88rpx expansion used at `:146`).
- Confidence: high

[severity: P2] `components/ocr-flow/index.wxss:111` — role picker chips (highest-frequency tap in OCR) are ~63rpx (≈31pt)
- Evidence: `.role-opt { padding:var(--sp-3) var(--sp-5); font-size:var(--fs-caption) }` → 12+12+~39 ≈ 63rpx, and the row packs 5 chips with `gap:var(--sp-2)` (8rpx) — under the 8pt spacing rule. The in-file comment claims 「48rpx→72rpx 高」, so the intended size is not actually reached. `index.wxml:171-175` are `bindtap` (not `catchtap`) inside a row with no other handler.
- Fix: `min-height:88rpx; padding:0 var(--sp-5)` on `.role-opt`.
- Confidence: high

[severity: P2] `components/report-markdown/index.wxss:176` — tappable policy-status pill is ~42rpx (≈21pt)
- Evidence: `.pc-status { font-size:var(--fs-tiny); padding:var(--sp-1) var(--sp-3) }` → 4+4+~33 ≈ 41rpx. `index.wxml:95` binds `catchtap="onStatusTap"` → `wx.showActionSheet` with 有效/失效/退保/理赔终止 (`pages/report/index.js:1025`). It sits inside a card that itself opens the policy detail (`:90`), so a missed tap silently opens the wrong surface.
- Fix: `::after` 88rpx vertical expansion as used by `.h1n-edit` (`:31`).
- Confidence: high

[severity: P2] `components/ocr-flow/index.wxss:9,34,50` — three OCR-stage actions are 40-55rpx tall
- Evidence: `.proc-cancel { padding:var(--sp-2) var(--sp-7) }` (取消并清理, `index.wxml:11`), `.proc-retry-all { padding:var(--sp-1) var(--sp-3) }` (全部重试, `:69`), `.proc-ignore-btn { padding:var(--sp-1-5) var(--sp-3) }` (移除这一张, `:81`) — none has a `::after` expansion, unlike `.proc-retry-btn` right next to them (`:55`).
- Fix: reuse the existing `::after { height:88rpx }` pattern.
- Confidence: high

[severity: P2] `components/report-markdown/index.wxss:11` — sticky TOC chips are ~55rpx (≈27pt) tall
- Evidence: `.toc-item { padding:var(--sp-2) var(--sp-4); font-size:var(--fs-caption) }` with `catchtap="onTocTap"` (`index.wxml:4`). Used to jump through a 10+ screen report; also horizontally scrollable, so a tap near a chip edge is the normal case.
- Fix: `min-height:72rpx; display:inline-flex; align-items:center` (or `::after` expansion).
- Confidence: high

[severity: P2] `components/chat-panel/index.wxss:39,67` — undo button and empty-state chips are ~55rpx
- Evidence: `.undo-btn { padding:var(--sp-2) var(--sp-5) }` (撤销 · 倒计时, `index.wxml:40`) and `.msg-empty-chip { padding:var(--sp-2) var(--sp-5) }` (`:13`). Undo is time-boxed (`fmtCountdown`) so a mis-tap costs the whole undo window.
- Fix: `min-height:88rpx` on both.
- Confidence: high

[severity: P2] `pages/index/index.wxss:31` — 点击重试 (the recovery path for a failed client list) is ~55rpx
- Evidence: `.load-error-retry { padding:var(--sp-2) var(--sp-5); font-size:var(--fs-caption) }`, `index.wxml:34`. It is the *only* recovery control on the home error state.
- Fix: `min-height:88rpx; display:inline-flex; align-items:center; justify-content:center`.
- Confidence: high

[severity: P2] `pages/report/index.wxml:335` + `index.wxss:204` — disabled FAB send is a `<view>`: colour-only, no disabled semantics, no feedback
- Evidence: `<view class="fab-send pressable {{(!fabText || chatBusy) ? 'is-disabled' : ''}}" bindtap="onFabSend" aria-label="发送消息">`; `.fab-send.is-disabled { background:var(--accent-muted) }` plus `.fab-arrow { color:var(--text-disabled) }`. Tapping while disabled runs `onFabSend` → `cp.onSend()` returns `false`/`undefined` and the code path only restores `fabText` (`index.js:1100-1107`) — no toast, no shake, no `disabled` attribute, and the aria-label still announces 发送消息 as actionable.
- Fix: add `aria-role="button"` + `aria-disabled="{{...}}"` (or switch to `<button disabled>`), and toast 「先输入内容」/「小秘正在回复」 on tap.
- Confidence: high

[severity: P3] `components/markdown-render/index.wxss:347,604` — 复制 controls are 48-63rpx
- Evidence: `.quote-copy { padding:var(--sp-3) var(--sp-4) }` (`index.wxml:97`), `.table-fullscreen-btn { padding:var(--sp-3) var(--sp-5) }` (`:165`). The table toolbar icons are fine (`.table-action-btn` 56+32=88rpx, `:147-157`).
- Fix: give both a `min-height:88rpx`.
- Confidence: medium

[severity: P3] `components/report-markdown/index.wxml:7` / `index.wxss:199` — chapter collapse header has no press feedback
- Evidence: `.fold-hd` has `catchtap="toggleChapter"` but no `:active` rule and no `pressable` class (all other tappables in this component pair `pressable` with an `:active` rule). The only feedback is the text swap 展开 ▾ → 收起 ▴.
- Fix: add `.fold-hd:active { opacity:0.85 }` (or `pressable`).
- Confidence: high

[severity: P3] `components/ocr-flow/index.wxss:50` and `components/markdown-render/index.wxss:408` — 移除这一张 / `.md-link` have no pressed state
- Evidence: `.proc-ignore-btn` defines no `:active` (its sibling `.proc-retry-btn:active` does, `:56`); `.md-link` is `bindtap`-able (`index.wxml:13`) but declares only colour + underline.
- Fix: add `:active { opacity:.6 }`.
- Confidence: medium

[severity: P3] Consistency note on press feedback: no `hover-class` is used anywhere in the 6 components/3 pages; all ~40 press states are `:active` (`app.wxss:296 .pressable:active`) plus per-class `:active` rules. This works under the default webview renderer (`style: "v2"`, no `renderer: skyline` in app.json) but every press state would silently disappear if the project ever opts into Skyline (where only `hover-class` is honoured).
- Fix: if Skyline is on the roadmap, migrate `.pressable:active` to `hover-class="pressable-hover"` centrally.
- Confidence: medium

Destructive-action protection is good and does not need changes: 删除家庭 = ActionSheet → Modal with `confirmColor:'#B85450'` and copy 「此操作不可恢复」 (`family-actions.js:33-43`); 删除成员 = red Modal (`report/index.js:405-409`); 放弃全部 (`ocr-flow/index.js:354-357`) and 移除该项 (`:381-384`) both confirm; state→失效/退保 requires a typed 失效日期 (`report/index.js:1034-1044`); edit-sheet warns on unsaved close (`edit-sheet/index.js:100-110`). Double-submit guards exist on save (`editSaving`), OCR save (`disabled` + `is-disabled`), PDF export (`_exportingPdf`), status change (`_changingStatus`), create-client (`_creating`), feedback (`feedbackGiven`).

## Contrast & typography

Computed with WCAG 2.x relative luminance. Light palette from `app.wxss:11-60`, dark from `:157-211`.

[severity: P2] `pages/report/index.wxss:93` (and 6 sibling sites) — `--text-tertiary #857256` on `--bg-root #F5F0EB` = **4.09:1** (fails 4.5:1)
- Evidence: `.report-disclaimer { font-size:var(--fs-tiny) /*24rpx=12px*/; color:var(--text-tertiary) }` on the page's `--bg-root`; same pair at `pages/index/index.wxss:11` (.brand-slogan 28rpx), `:26` (.empty-hint-text 28rpx), `:30` (.load-error-text 28rpx), `report/index.wxss:62` (.title-meta 24rpx), `report/index.wxss:219` (.load-error-sub 28rpx), and `app.wxss:290` (.num-lbl 24rpx, whose parent `.num-cell` sets `background:var(--bg-root)` at `app.wxss:287` / `report-markdown/index.wxss:144`). The same token on `--bg-surface #FBF8F3` is 4.37:1 — also failing (`.form-label` `edit-sheet/index.wxss:30`, `.mm-role` `pages/report/index.wxss:176`).
- Impact: the compliance disclaimer, the data-freshness timestamp, the unit labels under the three headline numbers, and the home error text all sit below AA for the 40+ audience this project explicitly targets (`app.wxss:67-73`).
- Fix: darken the token one step (e.g. `#6F5E45` on `#F5F0EB` ≈ 5.6:1) or stop using `--text-tertiary` on `--bg-root` surfaces.
- Confidence: high

[severity: P2] `components/report-markdown/index.wxss:182` — `.pc-status--expired`: `#B85450` on `#EBD8D2` = **3.46:1** at 24rpx
- Evidence: `.pc-status--expired { color: var(--red); background: var(--red-dim); }` and `.pc-status { font-size:var(--fs-tiny) }` (`:176`). "到期终止" is the one status an agent must not misread.
- Fix: `color: var(--red-deep)` (`#9E423D` on `#EBD8D2` = 4.63:1).
- Confidence: high

[severity: P2] `components/edit-sheet/index.wxss:47` — inline field error `#B85450` on `#EBD8D2` = **3.46:1** at 28rpx
- Evidence: `.form-error { font-size:var(--fs-caption); color:var(--red); background:var(--red-dim) }`, rendered by `index.wxml:39` (`role="alert"`).
- Fix: `color: var(--red-deep)`.
- Confidence: high

[severity: P2] `components/ocr-flow/index.wxss:47` + `:39` — OCR failure reason `#B85450` on `--bg-error-soft #FEF2F2` = **4.34:1**
- Evidence: `.proc-err { font-size:var(--fs-caption); color:var(--red) }` inside `.proc-card--err { background:var(--bg-error-soft) }`. This is the only text telling the agent *why* a scan failed (`index.wxml:77` appends 「· 点此手动录入」).
- Fix: `var(--red-deep)` (≈5.4:1 on `#FEF2F2`).
- Confidence: high

[severity: P2] `components/ocr-flow/index.wxss:91` — reassurance copy uses the *disabled* token: `#837463` on `#FBF8F3` = **4.27:1** at 24rpx
- Evidence: `.ocr-phase-sub { font-size:var(--fs-tiny); color:var(--text-disabled) }` renders 「已识别的结果已保留，重试不会丢失」 (`index.wxml:108`), 「报告即将刷新」/「3s 后进入保障报告」 (`:123`) and 「系统已根据年龄自动推测，可直接确认或手动调整」 (`:179`). Informative text, not a disabled control, and it fails AA.
- Fix: use `--text-secondary` (`#6E5A3E` on `#FBF8F3` = 6.20:1).
- Confidence: high

[severity: P2] `pages/report/index.wxss:144` + `:73` — `--accent-deep #8B6F3C` on an `--accent-dim` pill over `--bg-root` = **3.87:1**
- Evidence: `.preview-entry-btn { color:var(--accent-deep); background:var(--accent-dim) }` — `accent-dim` = `rgba(201,169,110,.12)` over `#F5F0EB` ⇒ effective `#F0E7DC`, ratio 3.87:1 (28rpx). The same recipe over `--bg-card` (`report-markdown/index.wxss:30` .h1n-edit, `:157` .risk-check, `report/index.wxss:73` .title-qual-act, `:281` .deep-badge) is **4.29:1** — still short of 4.5:1.
- Impact: 预览客户版效果 / 标记成交 / [编辑] / 核对 / 去补全 — all gold-on-gold-pale.
- Fix: darken `--accent-deep` for text (e.g. `#7A5F31` ⇒ ≈5.2:1 on `#F9F3E8`) or lighten `--accent-dim`.
- Confidence: high

[severity: P3] `components/chat-panel/index.wxss:23` — dark-mode timestamp `#8A8072` on `#2A2826` = **3.78:1**
- Evidence: `.ai-msg-time { color: var(--text-disabled) }` at 24rpx under `@media (prefers-color-scheme: dark)` (`app.wxss:199`). The dark `--text-tertiary #948872` on the same surface is 4.21:1 — also short.
- Fix: raise dark `--text-disabled`/`--text-tertiary` to ≈`#A79A83`.
- Confidence: medium

[severity: P3] `components/ocr-flow/index.wxss:47` — dark mode `#D06560` on `--bg-error-soft #3A2422` = **3.93:1** (and on `--bg-surface #232120` = 4.36:1 for `.done-red`/`.mm-del`/`.proc-group-head--err`)
- Fix: use a lighter red for dark text (`#E08A85` ⇒ ≈5.4:1 on `#3A2422`).
- Confidence: medium

[severity: P3] `pages/report/index.wxss:22,62,93` etc. — 24rpx (12px) is the floor and carries decision-relevant status text
- Evidence: no WXSS literal below `--fs-tiny: 24rpx` exists (verified by scanning all `font-size: <n>rpx`), but 24rpx is used for `.pc-status` (保单状态, `report-markdown:176`), `.ocr-badge` (`ocr-flow:58`), `.proc-pending-state` (`:20`), `.facts-time` (`report/index.wxss:121`), `.cal-m` (`report-markdown:38`), `.num-lbl` (`app.wxss:290`), `.report-disclaimer` (`report/index.wxss:93`). `app.wxss:67-73` documents that the audience is 40+ and that mini programs do not follow system font scaling.
- Fix: for status/state tokens (`pc-status`, `ocr-badge`, `tone-badge`) bump to `--fs-caption` (28rpx).
- Confidence: medium

Passing pairs worth keeping as regression anchors: `#1A1A2E` on `#FFFDF9` 16.79:1; `#6E5A3E` on `#FFFDF9` 6.47:1; `#7C5E1C` on `#F5ECCE` 5.11:1; `#17754A` on `#e6f4ec` 5.03:1; `#9E423D` on `#EBD8D2` 4.63:1; `#2E2418` on `#C9A96E` 6.79:1; dark `#E8E0D5` on `#2A2826` 11.23:1; dark `#D4A93E` on `#443B2A` 5.01:1.

## Copy quality

[severity: P2] `pages/report/index.wxml:179` — agent-side term 「客户档案」 is rendered in the **customer** view
- Evidence: `<text class="facts-title">客户档案</text>` with `wx:if="{{factsView}}"` and no `isShared` guard, while `facts-view.js:69-74` explicitly supports the shared view (it filters leads/timeline). From the customer's side, their own family data is labelled a "client record". Compare the care taken nearby for `deep-clarify` (`index.wxml:156` `wx:if="{{!isShared && clarifications.length}}"`).
- Fix: `{{isShared ? '家庭档案' : '客户档案'}}`, or hide the card in the shared view.
- Confidence: high

[severity: P2] `components/markdown-render/index.wxml:96,99` (and `:39,41,44`) — 「话术内容」 + 复制 / 表格 复制·全屏 leak into the customer view
- Evidence: the report page renders the AI sections with `<markdown-render content="{{deep.portrait}}" variant="report" />` (`report/index.wxml:137-153`) with **no `readonly`** and no shared guard; the discussion at `:106` and `:120-122` only removes the 「AI 解读」 badge. `report-markdown` does accept `readonly` (`index.js:40-57`) but never passes it down. A quote block therefore shows a toolbar labelled 话术内容 ("sales script") with a 复制 button to the end customer.
- Fix: thread `readonly` into `markdown-render` and hide the 复制/表格/全屏 toolbars when set; rename the label to 重点摘录 at minimum.
- Confidence: high

[severity: P2] `pages/index/index.wxml:5-6` — home headline promises a speed the product cannot keep, in C-end voice
- Evidence: 「上传保单，秒出报告」 / 「AI保单整理助手」 (`index.wxml:5-6`). Project facts: OCR is a 100s-timeout pipeline (`README.md:23`) and 深度分析 is a 60s call (`report/index.js:555`, `report-analysis.js:45`), with the report page's own loader saying 「小秘正在认真看保单...」 and the banner 「保障分析自动更新中…」 (`report/index.js:546`).
- Fix: 「上传保单 · 生成保障报告」 plus an honest expectation (「约 1 分钟」).
- Confidence: high

[severity: P2] `pages/report/index.js:98,709` vs `index.wxml:64` vs `index.wxml:247` — three different names for the same person
- Evidence: 「请联系**代理人**重新分享」 (`:98`), 「请联系**代理人**重新分享」 (`:709`), 「请联系您的**保险顾问**上传保单」 (`:64`), 「可联系您的**服务顾问**」 (`:247`). Also 「由保小秘生成」 (`:248`) vs the persona 「小秘」 (`chat-panel/index.wxml:6`) in the same screen.
- Fix: pick one term (suggested 服务顾问) as a constant and reuse it in all four strings.
- Confidence: high

[severity: P2] `pages/report/index.wxml:50-53` — analyst jargon in the customer-facing banner
- Evidence: `.title-qual` (no `isShared` guard on the container, only 去补全 is owner-gated) renders 「本报告为定性分析：家庭年收入未填写，未做缺口金额、回本年限等量化测算」. 定性分析 / 量化测算 / 回本年限 are internal口径 terms, and it discloses the family's missing data in negative framing.
- Fix: give the shared view its own sentence (e.g. 「补充家庭收支信息后，本报告会自动补充额度测算」— the phrasing already used at `chapter-builder.js:276`).
- Confidence: high

[severity: P3] `pages/report/index.js:945` — success toast 「小秘记下了」 does not say what happened
- Evidence: after a successful save the only feedback is `wx.showToast({ title: '小秘记下了', icon:'none' })`, while other write paths are explicit: 已删除 / 状态已更新 / 已标记成交 / 已创建，可上传保单或补成员 / 报告已更新 (`index.js:873`) / 分析完成.
- Fix: 「已保存，报告已更新」.
- Confidence: high

[severity: P3] `components/chat-panel/index.js:218` vs `:278` — two different strings for the same failure
- Evidence: `'小秘处理出错了，请重试'` (empty `cleanText`, with a 重试 button) vs `'抱歉，小秘遇到了一点问题，请重试。'` (catch branch). Neither names a cause.
- Fix: one string; prefer `errorHandler.getErrorInfo(e).tip` as the `:252` branch already does.
- Confidence: high

[severity: P3] `utils/errorHandler.js:20-30` — generic tips with no recovery path
- Evidence: 400 「操作有误，请重试」, 403 「没有操作权限」, 404 「数据不存在或已被删除」, 500 「服务繁忙，请稍后重试」, shown as a 2.5s `mask:true` toast (`:117-122`). For 400 the user gets no field and no cause (the real reason is often in `err.msg`, which only reaches `info.detail`, used by chat but not by `onSaveEdit`).
- Fix: prefer `tip + '：' + detail` when `detail` is a human-readable business message.
- Confidence: medium

[severity: P3] `pages/report/index.js:176` — dead-end recovery toast
- Evidence: `onClarifyFix` with an unknown `mode` falls back to `wx.showToast({ title: '请先在报告对应位置补充该信息' })` — no location, no entry point.
- Fix: keep the row visible and expand an inline form, or scroll to the owning chapter via the existing `onTocNav` mechanism.
- Confidence: medium

[severity: P3] `utils/edit-form.js:139` + `ocr-flow/index.wxml:120` — small copy/affordance mismatches
- Evidence: `title: '编辑成员' + name` renders 「编辑成员张三」 with no separator; the OCR success card puts a ✕ (`/images/close.svg`) top-right but labels it 「查看报告」/「立即进入保障报告」 and binds the primary action to it — a close glyph doing "proceed".
- Fix: 「编辑成员 · 张三」; use a forward chevron or remove the icon button (the primary CTA is already at `:127`).
- Confidence: high

[severity: P3] `pages/report/index.js:19` — 「本报告基于OCR识别结果自动生成」 shown to customers
- Evidence: `DISCLAIMER_FALLBACK` is rendered in both views (`index.wxml:232`, no `isShared` guard) and contains the internal acronym `OCR`.
- Fix: 「本报告基于保单信息自动生成…」 in the shared view.
- Confidence: medium

## Information hierarchy

[severity: P2] `pages/report/index.wxml:99-102` + `utils/report/chapter-builder.js:228` + `:258-261` — the same missing-coverage finding is printed three times
- Evidence: (1) hero list 「张三 缺少重疾、意外保障」 (`index.wxml:101`); (2) 保障汇总 chapter `pre` 「⚠️ 张三缺少重疾、意外」 rendered as a red block (`chapter-builder.js:228` → `report-markdown/index.wxml:110` `.md-pre`); (3) 保障缺口 chapter bullets 「- 重疾：缺口 80 万」 (`chapter-builder.js:258-261`). Three restatements of the same gap before any new information.
- Fix: drop the `pre` block (redundant with `hero.alerts`) or demote it into the 缺口 chapter only.
- Confidence: high

[severity: P2] `pages/report/index.wxml:224-230` — a survey row inside a customer-facing report
- Evidence: `feedback-row` renders for `hasPolicy` regardless of view; in the shared view it asks 「这份报告看得清楚吗？」 with 有帮助/没帮助, and both handlers only fire `track('report_feedback')` (`index.js:633-642`). It sits directly above the compliance disclaimer.
- Fix: replace with a non-interactive line in the shared view, or move the survey into the agent's 预览 mode only.
- Confidence: medium

[severity: P3] `pages/report/index.wxml:181` — collapse affordances use different glyph pairs for the same gesture
- Evidence: 客户档案 uses text `收起 ▴ / 展开 ▾` (`:181`) and report chapters the same pair (`report-markdown/index.wxml:9`), but the policy-status picker uses a different `▾` (`edit-sheet/index.wxml:27,34`) and `.fold-arrow` never rotates; four glyph conventions (`▾`, `▴`, `→`, `＋`) plus `✕`/`✓` are used as icons with no shared icon set.
- Fix: pick one chevron pair (or reuse the two SVG assets).
- Confidence: medium

## Consistency

[severity: P2] `pages/report/index.wxml:60` + `components/edit-sheet/index.wxml:16,21` + `utils/report/chapter-builder.js:228,369` — emoji used as structural icons
- Evidence: `📄` as the empty-state icon (`:60`), `⚠️` as the low-confidence marker in every form label (`edit-sheet/index.wxml:16,21`), `⚠️` as the per-member bullet in the coverage chapter (`chapter-builder.js:228`), `💡` as the premium-peak bullet (`:369`, which also reaches the customer view since `premium_calendar.content` has no `isShared` guard). Meanwhile the project ships real SVG assets (`images/upload.svg`, `images/close.svg`) and inline data-URI SVGs (`markdown-render/index.wxss:172-184`) — three icon languages in one product.
- Fix: replace with the existing inline-SVG technique, or a text glyph with a colour token.
- Confidence: high

[severity: P2] `app.wxss:304-331` vs `components/ocr-flow/index.wxss:2-3,79-82` — two competing definitions of the OCR dialog
- Evidence: app.wxss declares `.ocr-card { width:600rpx; max-height:80vh; padding:var(--sp-10) var(--sp-7) }` and `.ocr-confirm-btn { height:88rpx }`, while `ocr-flow/index.wxss` re-declares `.ocr-card { width:100%; max-width:640rpx; max-height:78vh; padding:var(--sp-5) }` and `.ocr-confirm-btn`. The component comment (`ocr-flow/index.wxss:78`) asserts 「组件内定义覆盖 app.wxss 全局（app.wxss 改动对此不生效）」, contradicting `styleIsolation: "apply-shared"` in `ocr-flow/index.json:3` and the other components' reliance on app-level classes. Whichever wins is renderer-dependent.
- Fix: delete the app.wxss OCR block (or the component duplicates) so each selector has one owner.
- Confidence: medium

[severity: P3] no `aria-role` anywhere in the project (0 matches across all `*.wxml`)
- Evidence: interactive `<view>`s carry only `aria-label` — e.g. `report/index.wxml:331` (上传保单), `:335` (发送消息), `index.wxml:70` (FAB 上传), `report-markdown/index.wxml:4` (TOC chips), `:90` (保单卡片). There is also no `aria-disabled`/`aria-expanded` counterpart for `.is-disabled` (`report/index.wxss:204`) or collapsed chapters (`report-markdown/index.wxml:9`).
- Fix: add `aria-role="button"` to tappable views and `aria-expanded` where state toggles.
- Confidence: medium

[severity: P3] `components/report-markdown/index.wxss:143` — stale comment asserts style isolation that no longer holds
- Evidence: 「组件隔离：app.wxss 全局类不作用于组件，需组件内自持」 above a duplicated `.num-cell`/`.num-val`/`.num-lbl` block identical to `app.wxss:287-290`, while `report-markdown/index.json:3` sets `styleIsolation: "apply-shared"`.
- Fix: delete the component copy and the comment.
- Confidence: medium

[severity: P3] Radius/shadow/spacing literals outside the token scale
- Evidence: `border-radius:999rpx` (`report/index.wxss:67`) vs `--r-full: 9999rpx`; `border-radius:18rpx` chat bubbles (`chat-panel/index.wxss:20,28,43`) and `6rpx` (`report/index.wxss:26`, `chat-panel:20`) are off-scale while `--r-sm/md/lg/xl/2xl` exist; `.fab-upload { box-shadow:0 8rpx 24rpx rgba(201,169,110,0.3) }` (`report/index.wxss:197`) duplicates `--accent-glow` used by the identical FAB on the home page (`index/index.wxss:34`); `.pano-hd-cell { min-width:148rpx }` contradicts its own comment 「加 min-width:132rpx」 (`report-markdown/index.wxss:100-106`).
- Fix: map these to the nearest token; keep the two FABs on one shared class.
- Confidence: high

[severity: P3] Button heights are 80-88rpx across the product with no rule
- Evidence: 88rpx (`ocr-confirm-btn`, `.mm-add`, `.load-error-btn`, `.fab-inner`), 84rpx (`.rd-btn`, `report/index.wxss:255`), 80rpx (`.footer-share/.footer-export` `:103`, `.analysis-cancel` `:230`, `.empty-btn` `clients/index.wxss:42`). The 80rpx trio are below the 88rpx (44pt) floor used everywhere else, and `report/index.wxss:101` documents the 88→80 change as intentional de-emphasis rather than a size decision.
- Fix: standardise interactive heights on 88rpx (express hierarchy with fill/border instead).
- Confidence: medium

## What already works well

- **State coverage is unusually complete for a mini program.** Home has skeleton → list → error-with-retry (`index.wxml:32-35`); client list distinguishes 加载失败 / 搜索无结果 / 尚无客户 with different copy and exits (`clients/index.wxml:35-53`); the report page replaced a blank dead-end with a two-exit error card (`report/index.wxml:16-21`) and branches the modal by status code with actionable copy for 404/401 (`report/index.js:601-610`); OCR has upload / recognize / done / saving / failed / saved / match / roles, including a defensive 「暂无识别结果」 (`ocr-flow/index.wxml:34`) and reassurance that results survive a failed save (`:108`).
- **Recovery paths are named, not implied**: 重新加载 / 返回首页 / 点击重试 / 重试 / 全部重试 / 去补全 / 去关联 / 去设置 (permission modal with `wx.openSetting`, `ocr-flow/index.js:80-86`) / 撤销 with a live countdown (`chat-panel/index.wxml:40`) / 放弃全部-重试 on save failure (`ocr-flow/index.wxml:110-113`).
- **Async operations are cancellable and time-aware**: the 60s analysis layer shows elapsed seconds and a 取消分析 button instead of a locked `showLoading` (`report/index.wxml:256-262`, `report-analysis.js:34-39`); OCR exposes 取消并清理 with an indefinite progress bar for the recognition phase (`ocr-flow/index.wxml:11,15`); export waits 70s against a 60s function limit (`report/index.js:752-757`).
- **Destructive actions are consistently double-guarded**, use the danger colour, and the 失效日期 requirement is enforced in three places (dialog, form validation, and `LABEL_TO_VALUE` derivation).
- **Feedback discipline**: `:active` press states exist on nearly every tappable element, `prefers-reduced-motion` is honoured globally (`app.wxss:340-354`), `-webkit-tap-highlight-color` is themed, and the double-tap blue flash is replaced by a warm-gold dim.
- **A real design-token system exists**: colour, type scale, spacing, radius, motion, and z-index are centralised in `app.wxss:7-150`, with dark mode as a tonal variant rather than an inversion, and repeated contrast fixes already documented in-file (the `#C9A96E` → `#8B6F3C` white-text fix, the `--text-tertiary` split, the dark FAB gradient override). Most contrast findings above are single-token fixes, not redesigns.
- **Accessibility groundwork**: ~40 `aria-label`s on icon-only controls, `role="alert"` on inline form errors (`edit-sheet/index.wxml:39`), semantic `<button disabled>` where async guards exist, safe-area insets on every fixed/bottom element, and no horizontal page scroll anywhere.
- **The 7-chapter report is genuinely scannable**: sticky TOC with a mask-fade affordance (`report-markdown/index.wxss:9`), numbered serif chapter headers, default-collapsed 缴费月历/附录, per-chapter `[编辑]`/`核对`/`去补全` entry points, `tabular-nums` on every figure, and a timeline legend that explains the red/green dots (`report-markdown/index.wxml:31-32`).

───────── 回执 2/5 ─────────
Agent bc77e390-04b2-4662-b4eb-7b87b879caad sent a message:  # 报告链路只读审计（reportAI / reportPdf / _shared 报告类 / miniprogram report）

范围与方法：完整读取了 reportAI(index/prompts/report-coverage/report-context/report-dedup/report-versions)、reportPdf/index.js(858 行)、_shared 的 report-fields/familyPortrait/policy-status/gap-core/fact-vocab/report-files/v2-context/markers/amount/thresholds/policy-table/cash-value-math/parse-expiry/readiness/config，以及 miniprogram/utils/report/*、report-builder/md-parse/facts-view/report-share。所有编号结论都在 $env:TEMP 用真实模块跑过（未改仓库任何文件）。`sync-shared.js --check` 语义核对：MINIPROGRAM/utils 与各 `_shared` 副本与权威源逐文件 MD5 全等（唯一 DIFF 是 `miniprogram/utils/errorHandler.js`，不在本审计范围）；`report-files.js` 确为 reportPdf 函数独有文件，无权威源副本，未报。

---

## P1

### P1-1 `cloudfunctions/_shared/familyPortrait.js:42,243-244` — 孤儿保障含「年金」→ 整个报告生成 500（不是缺一段，是彻底失败）
- Evidence：L42 `_CATEGORY_KW` 仍写 `['年金','年金险']`，而 L36 `STANDARD_COVERAGE`/fact-vocab 已在 2026-09-22 统一规范词为 `'年金'`（同文件 L31-34 注释正是"该键根本不存在"）。L243 `for (const dim of _inferCategories(l.name))` → `dim='年金险'`；L244 `if (coverage[dim].status === 'missing')` 读 `coverage['年金险']`（undefined）→ TypeError。
- 实测（真实模块 + 打桩 wx-server-sdk）：`buildPortrait(members,[{predicate:'拥有保障',object_value:'公司年金',...}],{policies:[]})` → `TypeError: Cannot read properties of undefined (reading 'status') at familyPortrait.js:244`。该函数由 `_shared/v2-context.js:209` 在 `scene==='report'` 调用 → `reportAI/index.js:129 Promise.all` 内 → 落 L402 外层 catch → 返回 `wrapError('处理')`。
- 用户可见后果：只要该家庭 facts 里有一条「拥有保障/公司提供保障」且 `object_value` 含「年金」（企业年金、年金险），点生成报告**永远失败**，且不是"内容缺失"而是"报告生成失败"提示。现有测试只覆盖 `'重疾+医疗综合团险'`（tests/familyPortrait.test.js:120-126），未覆盖此词。
- Fix：L42 改 `['年金','年金']`→ 直接用规范词 `'年金'`（并加 `coverage[dim] &&` 防御）。
- Confidence: high（真实模块复现 + 调用链 grep 验证）

### P1-2 `cloudfunctions/reportAI/index.js:310,313` — 去重重写复用解析失败的时间判定，缺"剩余预算≥一次调用"守卫，可击穿 60s
- Evidence：`_canRetryParseFailure(spentMs)` 语义是 `spentMs + 40000 <= 55000`（L85-87），即"当前已耗时 ≤15s 才允许再发一次 40s"。但 L310 只在**已耗时**≤15s 时放行，没检查"再发一次后还会不会超"。首轮成功但耗时 15s、L314 解析、L318 `findRepetitions` 再来一次重写，则新调用从 15s 起跑、最长 40s → 结束于 55s，之后还有 `loadFamilyView`→`archivePrevious`（add+orderBy+最多 50 次 remove）→`silentUpdateWhere`→`advanceStage`→`logAI` 共 5+ 次 DB 往返（L335-384），必然越过 cloudbaserc 的 60s。平台杀函数 → 用户拿不到报告，且已白烧 2~3 次 AI token，日志只剩"函数超时"（正是 L78-84 注释记载的同一个事故模式，只是换成了去重分支）。
- 注：解析失败分支与去重分支互斥（解析失败即 return 500），所以最坏情况是 2 次调用而非 4 次——但上面的 15s+40s 已足够越界。
- Fix：`if (retryWorthy.length > 0 && (Date.now() - t0) + ATTEMPT_TIMEOUT_MS <= FN_LIMIT_MS - TAIL_RESERVE_MS)`（即用 `spentMs=Date.now()-t0` 但判定改为预测式），或给重写单独设更短的 timeoutMs。
- Confidence: high（算式与调用点均逐行核对）

### P1-3 `cloudfunctions/reportAI/report-coverage.js:49,55,67` — 生效日不可解析时向 AI 上下文注入字面量「NaN」
- Evidence：三处都用 `new Date(p.effective_date).getFullYear()`，且**没有** `contract_effective_date` 兜底（同文件 L42 `保障到期` 列、`policy-status.js:61`、`familyPortrait.js:168`、`reportPdf/index.js:492/677` 全都是 `contract_effective_date || effective_date`）。日期非法 → `getFullYear()` 为 NaN → `Math.max(0, thisYear-NaN)` = NaN → `String(NaN * annual_premium)`。
- 实测：保单 `effective_date:'2020年5月'`（"脏日期"是真实存在形态，见 tests/writePoliciesBatch.test.js:225）→ 输出的结构化保单清单为 `| 重疾A | 重疾险 | 50 | - | 有效 | 2020年5月 | - | NaN | NaN | - | - |`。这段 markdown 直接进 `enrichedContext`（`report-context.js:182`），prompt 又要求"直接引用系统预计算值"，模型会把 NaN 抄进结论/计划，客户在报告里看到"已缴年 NaN"。
- Fix：抽 `const eff = p.contract_effective_date || p.effective_date || ''` + `const effY = eff ? new Date(eff).getFullYear() : NaN`，`!isFinite(effY)` 时返回 `'-'`。
- Confidence: high（实测输出）

### P1-4 `cloudfunctions/_shared/familyPortrait.js:239-252` — 同一成员同险种多张保单时覆盖矩阵只留最后一张（画像 800 万 vs 清单 1200 万）
- Evidence：L251 `coverage[dim] = { status, amount: pol.sumAssured, ... }` 是**赋值**不是累加；`report-coverage.js` 的结构化清单逐行列出，用户看到两个数。
- 实测：同一成员两张医疗险（400 万 + 800 万）→ 画像覆盖矩阵 `医疗险 amount = 800`；同一份上下文的「结构化保单清单」里是两行 400/800。prompt L64 明确要求"review 直接引用其结论" → 模型可能按 800 万讨论"已有保障"，与实际 1200 万不符（或反之漏报）。
- Fix：`if (coverage[dim].status === 'missing') 赋值; else coverage[dim].amount = Number(coverage[dim].amount||0) + Number(pol.sumAssured||0)`，状态取"covered 优先"。
- Confidence: high（实测）

## P2

### P2-1 `miniprogram/utils/report/chapter-builder.js:109` vs `report-coverage.js:69` — 现价取行口径差 1 年（同一保单前端/后端不同行）
- Evidence：chapter-builder 注释 L92 写"≤ 当前保单年度(当前年-生效年**+1**)"，实现 L109 `policyYear = new Date().getFullYear() - effYear + 1`；后端 `report-coverage.js:69` `paidYears = ctx.thisYear - effYear`（**不 +1**）。两处都调用 `cashAtYear`，周年未到的保单会跨行。
- 实测：`effective_date:'2015-11-20'`、现价表 y10=100/y11=110/y12=120（每万）→ 后端现价列 11000（取 y11），前端按注释口径取 y12=12000。若周年在 12 月而当前是 1 月，两者展示的"当前现价"相差一年。
- Fix：抽到 `_shared/cash-value-math.js` 一个 `paidYearsOf(policy, now)`，两端共用。这是 sync-shared 的 CONTRACT_FILES 机制存在的理由（cash-value-math.js 已在契约内），不要就地改。
- Confidence: high（后端取值实测；前端按注释口径推演）

### P2-2 `miniprogram/utils/report-builder.js:27,63` — `buildDeepAnalysis(report)` 每次 refresh 被调用两次
- Evidence：L27 `const deep = buildDeepAnalysis(report)`，L63 `return { ..., deep: buildDeepAnalysis(report) }`。`buildReportView` 是报告页唯一聚合入口（`miniprogram/pages/report/index.js:471`，且 line 1 顶层 require）。
- 后果：每次刷新页都多做一遍 core_insights 包装与 3 次 `String.replace`。纯冗余，无正确性影响。
- Fix：L63 直接用 `deep`。
- Confidence: high（grep 确认唯一调用点）

### P2-3 `miniprogram/utils/report/gap-engine.js:55-57` — `var i` 与外层 `for (var i...)` 同名遮蔽，`buildGapMatrix` 结果不可靠（该导出当前 0 调用方）
- Evidence：外层 `for (var i = 0; i < members.length; i++)`（L50），内层 `for (var i = 0; i < gaps.length; i++)`（L55）在同一函数作用域，内层把外层索引改写 → 一旦某成员任一格走过内层循环，外层就会跳成员。
- Fix：删掉这个函数（见 Dead code），或把内层改成 `var k`。
- Confidence: medium（静态作用域分析确凿；因无调用方故无运行时观测）

### P2-4 `miniprogram/utils/report/data-normalizer.js:23` 与 `report-builder.js:130` — `parseInt` 无基数，且 `|| 0` 把缺失收入抹平为 0
- Evidence：`parseInt(family.family_income ...) || 0` / `parseInt(family && family.family_income) > 0`。无基数 → `parseInt('0x1F')`=31；`'三十万'`→NaN→0。`family_income` 由 `_shared/family-compat.js:28` `fs.income || 0` 合成，缺失被抹平成 `0` → `assessDataCompleteness` 的"年收入"永远判为缺（这个方向是对的），但 `normalizeFamilyData.totalIncome` 也会把"未填写"当成"真的是 0"，L208 `income: totalIncome > 0 ? totalIncome : null` 与 L368 的缺失文案是仅有的两处防护，第三处消费方新增就会破。
- Fix：`Number(...)` 替代 `parseInt`；把"未填写"表示为 `null` 显式向下传。
- Confidence: high（代码确凿；影响为潜在）

### P2-5 `cloudfunctions/reportAI/report-versions.js:83-85` — 清理旧版本整段失败被静默吞掉，且每次都白读最多 50 条
- Evidence：`await Promise.all(stale.data.map(v => db.collection(REPORTS_COL).doc(v._id).remove().catch(() => 0)))` — 失败不计数、不记日志、不抛出；下一轮 `skip(keepVersions).limit(50)` 会读到**同一批**删不掉的记录，永久空转。同文件 L87-97 的 catch 只兜 `_addWithCollectionEnsure` 与 orderBy 的异常，删不掉的单条不触发它。
- 用户可见后果：`reports` 集合无限增长（每次生成都 add），报告"历史版本"列表在报告中只显示最近 3 版（前端不读旧版），但集合与查询成本持续上涨；且与 `report-files.js` 中"删失败必须留痕"的既定不变量相反。
- Fix：统计 `results` 中失败的条数，>0 时 `console.error` + 落 `agent_logs`（复用本文件已有的 `report_archive_fail` 动作）。
- Confidence: high

### P2-6 `cloudfunctions/_shared/report-files.js:126-137` — 删记录部分失败时 `recordsDeleted` 虚增，且下一轮白读同一批
- Evidence：L131 一次 `_.in(slice)` remove 最多 100 个 `_id`；L132 无条件 `out.recordsDeleted += slice.length`，不看 `res.stats.removed`。部分失败 → 计数虚高（cleanup 汇总报表失真），且这些记录仍带旧 `created_at` → 下一轮重新被读到、重新删文件（文件已不存在，`_isDeleteOk` 按"不存在=成功"返回 true）→ 只徒增云存储调用。
- Fix：`out.recordsDeleted += (res.stats && res.stats.removed) || slice.length` 并保留"未删掉的 id 下一轮重试"的语义。
- Confidence: medium（`remove()` 返回值形状未在仓库内验证；计数虚增的确凿性依赖 SDK 行为）

### P2-7 `cloudfunctions/reportPdf/index.js:772` — 注释与代码直接相反（bufferPages）
- Evidence：L772 `// bufferPages 未使用（无 switchToPage 回填页码），移除以避免与 addPage 的自动分页逻辑冲突`，而 L543 `new PDFDocument({ size:'A4', margin:0, bufferPages: true, ... })`，L102-123 `_finalize()` 正是用 `bufferedPageRange()` + `switchToPage()` 回填页脚与目录，L780 也调用 `L.finalize()`。注释会让下一个维护者"按注释删掉 bufferPages"，直接导致页脚总页数与首页目录全部失效。
- Fix：删掉 L772-773 两行注释。
- Confidence: high

## P3

- `[P3] miniprogram/utils/report/chapter-builder.js:62` — `_numW` 的 `Number.isInteger(r) ? String(r) : String(r)` 是恒等死三元（注释却写"整数省略 .0"）。无行为影响。Fix：`String(r)`。
- `[P3] miniprogram/utils/report/gap-engine.js:99` — `x === Math.floor(x) ? String(x) : String(x)` 同类死三元。
- `[P3] cloudfunctions/reportAI/report-coverage.js:69-74` — 「现价」列与 chapter-builder `_currentCashValue` 的 0 值处理不同：前者 `String(row.v * coverScale(...))`，后者 `if (cashW !== null && cashW > 0)` 才渲染。现价表首行 v=0 时后端显示"0"、前端整行不显示，同数据两处不一致（合并到 P2-1 一起修更省事）。
- `[P3] cloudfunctions/reportPdf/index.js:693` — `const beNatural = startY + (beY || 0) - 1` 在 `beY` 为 0/null 时算出 `startY-1`（正确性由下一行 `if (beY && beY>0 && ...)` 兜住，属侥幸写法）。Fix：先判 `if (beY > 0)` 再算。
- `[P3] cloudfunctions/report-dedup.js:90-100` — 去重合并是 O(hits²·len)；实测最坏合法输入（7×2400 字高度重叠）169ms / 1 hit，可接受，但真实报告若命中数百 gram 会线性放大。UNVERIFIED：未构造出数百 hits 的样本。

## Verified clean（已核对，勿报）
- **页码 / 页脚**：`_finalize` 先 `switchToPage` 再逐页画，总页数口径与目录回填一致；`_ensure` 与 `doc.heightOfString(..., lineGap:3)` 的 lineGap 已对齐（r4 修复）。
- **pdfkit 监听顺序**：`reportPdf/index.js:781-787` 先 `doc.end()` 再挂 `data/end`。实测 pdfkit 0.15.2 两种顺序都得到 4243 bytes（内部队列在 nextTick 排空）→ **不是 bug**。
- **`coverage_term=105` / `premium_term=1` 哨兵**：reportAI、reportPdf `_termYear`、timeline-builder `_coverTermYear`、chapter-builder `_periodText/_payTermText` 全部走 `isLifetimeTerm/isSinglePayTerm`，无内联比较（grep 全仓确认）。
- **`readiness_tier`**：只有 `reportAI/index.js:359` 写，`reportPdf/index.js:648` 与报告页只读不推，老报告缺字段 → 空串不猜。
- **`report-fields.js`**：`toWriteFields/toReadReport` 是唯一读写口，数组字段 `core_insights` 缺省 `[]`（无 `String([])` 退化）。
- **gap 计算口径**：前端 `buildGaps` 与后端 `buildGapSnapshot` 同调 `_shared/gap-core.evaluateCoverage`；实测同一家庭两边 `reference=250, existing=100, gap=150` 一致。
- **`data-normalizer.premiumRatio`** 空收入除零已被 `totalIncome > 0` 守卫，实测 8000/300000=2.7%。
- **`familyPortrait._decayedConfidence`** 对缺时间戳/无效时间戳都有早返回，不会产生 NaN 置信度。
- **`markers.js`、`thresholds.js`、`fact-vocab.js`、`policy-status.js`、`parse-expiry.js`、`amount.js`** 未发现未经验证的数值/日期缺陷；`parse-expiry` 的 setMonth 溢出与次日零点边界都已修且注释与实现一致。

## Clean areas
- `policy-status.js` 的 `listExpiredButActive` 排序（非一年期优先、同组按到期日升序）与 `calcStatus` 同源，`isOneYearPolicy` 三形态并集实现正确。
- `cash-value-math.js` 的三个函数纯函数无副作用，`coverScale` 的 `Math.max(1, ...)` 防了 <1 万保额的 0 缩放。
- `md-parse.js` 表格/有序列表续行/段落推进逻辑不存在死循环（每分支都推进 `i`）；`splitRow` 保留中间空单元格的注释与实现一致。
- `report-share.js` 无 token 时回退 `?share=1`（不泄漏 owner 形态链接），`shareExpireHint` 对 0/NaN 返回空串。
- `v2-context._loadPoliciesOrNull` 按 B 注释"不回退空数组"实现，确实返回 `null`。
- `report-files.recordReportFile` 建集合重试路径与 `report-versions._addWithCollectionEnsure` 语义一致，均返回结构化失败而非抛出。

## Dead code candidates（附 grep 证据）
1. `miniprogram/utils/report/gap-engine.js:36` `buildGapMatrix` — 全仓 grep `buildGapMatrix` 仅命中自身定义/导出与 `chapter-builder.js:160` 的一句"已删除死代码"注释；唯一导出点在 `report/index.js`/`report-builder.js` 均**未**转发。本身还有 P2-3 的变量遮蔽缺陷 → 建议直接删函数与 `module.exports` 里的名字。
2. `cloudfunctions/_shared/familyPortrait.js:398` 导出的 `SOURCE_PRIORITY` — grep 仅本文件 L24/L69 内部使用 + 导出，无外部消费方。
3. `cloudfunctions/reportAI/report-dedup.js:117` 导出的 `FIELDS/NGRAM/MIN_FIELDS` — grep 仅 `RETRY_MIN_FIELDS` 被 `reportAI/index.js:65` 消费，其余三个常量无外部引用（tests/report-dedup.test.js 也只测函数），可收窄导出面。
4. `cloudfunctions/reportPdf/index.js:419 _fmtMoney` / `:413 _wanStr` / `:425 _amtCell` / `:627 _insuredCount` 等均为使用中的内部函数，**不是**死代码（已逐一 grep 确认调用点），列出以免误删。
5. 重复计算（非死代码但应合并）：`report-builder.js:27/63` 的 `buildDeepAnalysis` 双调用（见 P2-2）。

未做：未运行完整 109 套测试（只跑了 familyPortrait / report-coverage / report-retry-budget / report-files / cleanup-prune 五套，57 tests 全绿，用以确认上述缺陷**没有**被现有测试覆盖）。未修改仓库任何文件。

───────── 回执 3/5 ─────────
Agent 065d6194-553d-4c8e-9a52-cc591a9fbdd1 sent a message:  AI/OCR/guard audit (read-only, nothing modified). Authoritative `cloudfunctions/_shared/*` only; verified via MD5 that reportAI/ocrService/conversationAI `_shared` copies of guard/config/pii-rules/ai-gateway/ai-client/ai-accounting/retry are byte-identical.

TOP FINDINGS (full detail in my final report):

[P1] reportAI/prompts.js:422 + _shared/ai-gateway.js:24-30 — report system prompt silently truncated by MAX_INPUT.
Measured: REPORT_PROMPT = 16330 chars, buildReportPrompt('warm') = 16753; SECURITY.MAX_INPUT = 16000 (config.js:40) and `_secureInput` sanitizes EVERY message incl. role:'system' (pii-rules.js:67 truncates). reportAI calls safeCallChat with no skip flags (index.js:419-421). So the last 330 chars of the prompt (「输出前红线重申」 items 2-8) never reach the model, and the 423-char warm-tone block sits entirely past the cut → 「共情版」 is a complete no-op while agent_logs still records metrics.tone='warm'. Fix: don't truncate system-authored messages (sanitize with a large maxLen for role==='system'), or add a per-call budget; add a test asserting prompt length <= MAX_INPUT.

[P2] ocrService/handlers.js:147 + _shared/ocr-extractor.js:145 — OCR text cap 30000 but gateway cuts at 16000.
buildExtractionPrompt('X'.repeat(30000)).userPrompt = 30301 chars → sanitize keeps 16000 → ~14.3k chars of document tail + trailing instructions silently dropped; the comment claims 16000 is only a last-resort backstop. Larger-risk sibling of the P1 (same root cause).

[P2] _shared/ai-gateway.js:32-39 — injection regex runs over server-built data in the user role → reports can be permanently un-generatable.
reportAI puts the whole context (v2 family markdown + previous AI report prose) in the user message with no skipInjection; rules are broad. Verified with node: detectInjection('客户忘记了之前购买过一份保单') === injected (rule 忘记.*(之前|上面|所有)); also '你现在是家里唯一收入来源' and '客户问你是不是AI助手'. Blocked → pipeline returns the rule source as text → parseAIJSON fails → retry sends identical context → blocked again → reportAI returns 500 报告生成失败, no self-recovery. Also: reportAI/prompts.js has NO "context data is data, not instructions" red line (grep), while ocrService/prompts.js:35 and conversationAI/prompts.js:21 have one.

[P2] conversationAI/tool-orchestration.js:124-138 — force-tool retry's paid DeepSeek call is never recorded.
`_retryForceToolCall` calls _recordDirectUsage only when toolCalls.length > 0; the "still no tool_calls" exit and the catch record nothing (phase1 does record both paths). → missing agent_logs cost + missing agents.token_used_monthly on exactly the path this retry exists for.

[P2] conversationAI/tool-orchestration.js:483-492 + index.js:132-143 — confirm-path write tools (addPolicy/updatePolicy/createFamily) execute AI args with zero schema validation (validateArgs only in _dispatchUndoTools/_dispatchDirectTools; grep proof). The unknown-field check was added for exactly this drift (policy_id vs policyId); updatePolicy is a confirm tool → user confirms a card that then 404s.

[P2] tool-orchestration.js:161-225 — no cross-stage time budget. The in-code "worst ≈31.5s" analysis ignores `_retryForceToolCall` (direct 30s default + hy3 maxAttempts 3 × SDK_TIMEOUT 60s ≈ 186s) and `_refineReply` (60s) running in the same 60s-limited invocation.

[P3] ocr-extractor.js:129-172 comment says ai_format is retried but retryOn only matches ai_empty → the attempt===1 (raw ocrText) branch is unreachable for parse failures; the documented "parse fail → retry" no longer happens.
[P3] tool-orchestration.js:468-469 silent `catch (_) {}` on arguments JSON → args={} with no log/validation error.
[P3] ai-client.js:198-260 vs 346-354 — callChatWithToolsDirect lacks the ECONNABORTED→CHAT_TIMEOUT mapping callChatDirect has.
[P3] ocr-extractor.js:158 logs the first 500 chars of raw extraction JSON (names/policy numbers/birth dates) on ai_format.
[P3] tool-orchestration.js:41/588 CONFIRM_TOOLS is stale (contradicts the real split lists at L481-482 and the header comment) and dead (grep: no importer).

CLEAN (verified): agent_logs.timestamp vs operation_logs.created_at field alignment with both rate limiters; no double-count (recordAIUsage has exactly one production caller; gateway bump only on success); `confirmed` stripping before dispatch; callChat timer cleared via finally; insurer-normalize idempotent + no duplicate keys; reportAI tone whitelist applied at caller (index.js:103) before buildReportPrompt.

DEAD EXPORTS (grep proof): CONFIRM_TOOLS; guard.js detectConfusables re-export; injection-guard INJECTION_RULES; pii-rules PII_PATTERNS; insurer-normalize LIFE_MAP; ai-client setAiObserver (tests only); ai-gateway calcTokenUsage/bumpAgentTokens re-export (tests only); ocr-core _isCashValueFooterResidue/_cashValueTitleRatio.

No files were modified. Tests: `npx jest tests/tool-orchestration.test.js tests/report-prompt-tone.test.js` → 36 passed (2 suites).

───────── 回执 4/5 ─────────
Agent f6a0363f-3bae-4351-abf9-b3debdccbf0a sent a message:  AUDIT RESULT — miniprogram scope (app.*, pages/**, components/**, utils/** except utils/report/**). Read-only; I modified no repo file. ⚠️ Workspace churn: another actor edited files while I audited (callCloud.js 13:31:28, utils/ocr-flow.js 13:33:15, components/ocr-flow/index.js 13:35:13, new untracked tests/callCloud.test.js). Findings below were re-verified against the current revision where the file changed.

## Findings

[severity: P0 — FOUND, ALREADY FIXED MID-AUDIT] utils/callCloud.js:11-20 — timeout promise rejected synchronously (setTimeout deleted), so *every* wx.cloud call rejected instantly as 云函数超时.
- Evidence (state at 13:28): `const timer = new Promise((_, reject) => { const e = new Error('云函数超时:'+name); e.__timeout = true; reject(e) })` with `let timerId` never assigned → `Promise.race([call, timer])` always lost to the already-rejected timer. Consequence: 100% of getFamily/listFamilies/OCR/AI calls fail; read ops additionally double-fire (retry).
- Status: fixed in the tree at 13:31:28 (`timerId = setTimeout(...)` restored) and pinned by new tests/callCloud.test.js. I ran `npx jest tests/callCloud.test.js` → 7/7 pass.
- Confidence: high (read the pre-fix source; post-fix test passes). No action needed unless the other actor's change is reverted.

[severity: P2] components/ocr-flow/index.js:183,198-204,387 — 取消 during upload does NOT stop the billed OCR/AI call.
- Evidence: `var upResult = await flow.compressAndUpload(...)` (183) → no `_ocrCancelled` check → `await flow.batchOCR(validIds, ...)` (203) fires; the flag is only checked AFTER it returns (204) and at 210. `onProcDiscardAll` sets `_ocrCancelled = true` (387) while the upload await is pending.
- Consequence: user taps「取消并清理」during upload, still pays ~0.5元/图 OCR + AI tokens; finally block then deletes the uploaded files and discards the (paid) result. Silent double cost on weak networks (cancel is the natural reaction to slow upload).
- Fix: after 183 add `if (this._disposed || this._ocrCancelled) return`; also guard `upProgress` (line 172) with `!self._ocrCancelled`.
- Confidence: high (code-verified at current revision; grep `_ocrCancelled` → only 160/204/210/387).

[severity: P2] components/edit-sheet/index.js:15 — `onSwitchEdit` mutates the `mode` **property** owned by the host, so view/edit state leaks across openings.
- Evidence: `onSwitchEdit() { if (this.properties.saving) return; this.setData({ mode: 'edit' }); this.triggerEvent('edit') }`. Hosts bind `mode="{{sheetMode}}"` (pages/report/index.wxml:365) / `"{{ocrSheet.mode}}"` (ocr-flow/index.wxml:189); the host value is unchanged, so the framework's binding diff never re-sends it and the child keeps its local 'edit'.
- Consequence: 报告页 → 保单卡片 (view 态) → [编辑] → 关闭 → 再点任一保单卡片：`_openEditSheet(cfg,'view')` (report/index.js:1015) 仍渲染可编辑表单 + [保存]，与“查看态起步”设计相悖；OCR sheet 同理（onEditCard 设 'view' 后残留）。
- Fix: keep it in data — `observers: { mode(v){ this.setData({ localMode: v }) } }`, render from `localMode`; or let the host own it (`triggerEvent('edit')` → parent `setData({sheetMode:'edit'})`).
- Confidence: medium (pattern is unsafe regardless of framework diff semantics; the property-diff behaviour is UNVERIFIED without a simulator).

[severity: P2] utils/history-store.js:167-168,195 + components/chat-panel/index.js:137 — first-load *business* failure is remembered as “loaded”, so chat history stays empty for the whole session.
- Evidence: `_fetch` returns `null` when `api()` resolves `ok:false` (e.g. 401 during cold start); `load()` falls through to `if (!mode) historyLoaded = true; return 0`. Later `load()` short-circuits at line 137 `(!mode && historyLoaded) return 0`, and chat-panel has no error UI (`_loadHistory` → `_expandPanel`). Only `onCollapse` → `reset()` recovers.
- Consequence: open 小秘 once while login/DB hiccups → panel shows the empty-state chips forever (user believes their history is gone) until they collapse and expand again.
- Fix: only set `historyLoaded = true` when data was obtained (`if (!mode && raw) historyLoaded = true`), or return `{error:true}` when `_fetch` returns null on the first load.
- Confidence: high (code path traced; network rejections do return `{error:true}` — only non-200 business failures are affected).

[severity: P3] components/chat-panel/index.js:433-434 — `setData` after detach.
- Evidence: `const count = await this._loadHistory('more'); this.setData({ refreshingMore: false })` — no `_disposed` guard (every other async path in the file has one, e.g. lines 87/92/282).
- Consequence: 下拉历史时离开页面/收起面板 → 「setData 组件已销毁」告警（真机无 UI，但污染日志与错误上报）。Fix: `if (!this._disposed) this.setData(...)`.
- Confidence: high (read).

[severity: P3] pages/index/index.js:106-112 and pages/clients/index.js:140-144 — delete-animation timer calls setData with no `_disposed` guard.
- Evidence: `setTimeout(() => { this.setData({ removingId: '', recentClients: ...filter(...) }); this._fetchClients(true) }, 250)`. `onUnload` sets `_disposed` but the callback never checks it (chat-panel does at line 87).
- Consequence: confirming a delete then leaving the page within 250 ms → “setData on unloaded page” warning. Fix: early-return when `this._disposed`.
- Confidence: high (read).

[severity: P3] pages/report/index.js:645-667 — `onToggleDeal` has no in-flight guard → double-tap write race.
- Evidence: `const next = this.data.dealStatus === 'won' ? '' : 'won'; this.setData({dealStatus: next}); saveFamilyPatch(...)`. Two fast taps send two concurrent patches ('won' then ''); server last-write-wins can disagree with the optimistic UI (refresher flips the badge back). Every other write path guards (`_saving`, `_changingStatus`, `_exportingPdf`, `_previewing`).
- Fix: `if (this._dealing) return; this._dealing = true` … `finally { this._dealing = false }`.
- Confidence: high on missing guard, medium on user-visible race.

[severity: P3] components/ocr-flow/index.js:60-93 — `chooseAndStart()` has no re-entrancy guard before `wx.chooseMedia` (`_ocrBusy` is only set inside `_startOCR`, after selection).
- Consequence: double-tap on 上传框/FAB can open the album picker twice / start two flows (second flow then blocked by `_ocrBusy`/`visible` at 153, leaving a stray picker). Fix: `if (this._picking || this._ocrBusy) return; this._picking = true`, clear in success/fail.
- Confidence: medium (platform behaviour of concurrent chooseMedia UNVERIFIED; guard is the standard remedy).

[severity: P3] components/markdown-render/index.wxml:55,56,58 — `wx:key="rowIdx"` / `"colIdx"` with no matching `wx:for-index`.
- Evidence: compact-table branch `wx:for="{{ item.parsedRows }}" wx:for-item="row" wx:key="rowIdx"` (55) and `wx:for="{{ row }}" wx:for-item="cell" wx:key="colIdx"` (56) — neither declares `wx:for-index`; the grid branch does (74-75, 186-187). Key resolves to undefined → duplicate/absent key warning and identity-less rows on re-render.
- Fix: add `wx:for-index="rowIdx"` / `wx:for-index="colIdx"` (or use `index`). Confidence: high for the invalid key, low for visible impact (tables are static after parse).

[severity: P3] components/{ocr-flow,edit-sheet,report-markdown}/*.wxss — global utility class `pressable` (and `.truncate/.safe-bottom/.card-stagger/.paper-card/.anim-number/.low-conf`) cannot reach isolated components.
- Evidence: app.wxss:295-296 defines `.pressable:active`; wechat docs: “除继承样式外，app.wxss 中的样式对自定义组件无效（除非改样式隔离）” — the repo already documents this in report-markdown/index.wxss:143. grep: pressable in ocr-flow wxml=15/wxss=0, edit-sheet 4/0, report-markdown 5/1 (only `.pc-status.pressable:active`); chat-panel is fine (`styleIsolation:'apply-shared'`).
- Consequence: 无按压反馈（`hover-class` 也未用）→ 这些按钮看起来“点了没反应”，正是审计里多次出现的投诉形态。Fix: 各组件 wxss 补 `.pressable:active{opacity:.85;transform:scale(.98)}` 或用 `hover-class`。
- Confidence: high (docs + grep).

[severity: P3] pages/clients/index.js:109-111 — 手动新建客户后不失效首页 SWR 缓存。
- Evidence: `onCreateFamily` success → `navigateToFamily(id)`; no `HOME_CACHE_KEY` removal (report page does remove it on edit/delete/status: report/index.js:421/944/1069). 首页 onShow→`_fetchClients()` hits the 60 s cache (pages/index/index.js:38-41) and the home page has **no** pull-to-refresh, so the new client is invisible on 首页 for up to 60 s with no way to force it.
- Fix: `wx.removeStorageSync(HOME_CACHE_KEY)` in the create success path (key is exported by utils/family-actions.js).
- Confidence: high (code + comments in both files).

[severity: P3] utils/family-actions.js:25 — `wx.navigateTo` with no `fail` handler.
- Consequence: navigation failure (stack/URL) = completely silent tap; ocr-flow’s `chooseMedia` got a fail branch after the same audit, `onExitPreview` has one too. Fix: add `fail: () => wx.showToast({title:'打开失败，请重试', icon:'none'})`.
- Confidence: high (read).

## Clean areas (verified, not assumed)
- Contract copies: `node scripts/sync-shared.js --check` → “Contract: 0 created, 0 updated, 14 unchanged”; all 14 CONTRACT_FILES identical to cloudfunctions/_shared. No copy drift findings.
- WXML→JS handlers: `npx jest tests/wxml-binding-integrity.test.js tests/component-integrity.test.js` → 24/24 pass; my own scan found no handler bound without a definition.
- WXML→JS data fields: scripted extraction of every `{{root}}` identifier across pages+components resolved to data/props/loop aliases (remaining hits were class-string fragments like 'is-ok', 'card-removing'). No silent-blank binding found; no camelCase `data-*` dataset trap (all dataset keys are single lowercase words and match `dataset.xxx` reads).
- Timers/listeners: `_loaderTimer`, `_autoRetryTimer`, `_ocrTick`, `_savedTick`, `_undoTimer`, `_parseTimer`, clients `_timer` are all cleared in `onUnload`/`detached` (grep-verified); components reset `_disposed=false` on re-attach (chat-panel:58, ocr-flow implied).
- Navigation depth bounded ≤4 (index→clients→report→preview) — no navigateTo growth toward the 10-page cap, no redirect loops.
- Error/loading paths: report page has loadError + retry for both owner and shared (report/index.js:600,712,836); ocr-flow failure paths all end with `flow.hide()`+`_emitBusy()`; `wx.chooseMedia`/`uploadFile`/`downloadFile`/`deleteFile` have fail handlers or `.catch`.
- app.json/theme.json/sitemap.json consistent (@bgColor/@navBgColor etc. all defined); 3 pages only, matching CONTEXT.md.

## Dead code candidates (grep proof; test-only callers labelled)
- pages/report/index.js:42 `refreshing` — set at 853/883, never read in any wxml (grep `\brefreshing\b` in pages/report/index.wxml → 0).
- pages/report/index.js:50 `reportMeta: { date:'', no:'' }` — `buildReportMeta` returns `{dateTime,dataAt,analysisAt}`; `reportMeta.date`/`.no` appear nowhere else (grep `reportMeta\.(date|no)` → 0).
- utils/ocr-flow.js:26-30 `processed`, `totalPolicies`, `streamFilled`, `matched` — written (38,51,54,59,240,241) but read by no wxml (grep each name in miniprogram/**/*.wxml → 0).
- components/ocr-flow/index.js:47 `clearTimeout(this._navTimer)` — `_navTimer` assigned nowhere (grep → 1 hit, this line); stray timer cleanup.
- app.wxss:304-334 `.ocr-mask/.ocr-card/.ocr-bar*/.ocr-phase-num/.ocr-phase-of/.ocr-phase-title/.ocr-fail-tip/.ocr-summary-list/.low-conf` — 0 page consumers; ocr-flow redefines the ones it uses locally (isolation), e.g. `.ocr-mask` ocr-flow/index.wxss:2, `.ocr-confirm-btn`/`.ocr-done-title`/`.ocr-actions-row`/`.ocr-phase-sub` all duplicated there.
- utils/report-builder.js:27+63 `buildDeepAnalysis(report)` computed twice per `buildReportView` call (identical pure input → duplicate work/serialization); reuse the line-27 `deep`.
- utils/report-builder.js:29,104-114 `makeHints` + the `hints` key of `buildReportView` — only `tests/report-builder.test.js:79,86` asserts `view.hints === []`; no page/component reads it (`report` 契约无 hints 键，恒空 — the wxml comment already says so).
- utils/report-builder.js:119 `assessDataCompleteness` — callers: only tests/report-builder.test.js:222/231 (grep production → 0).
- Historical note: `clearCachedOcrText` (utils/ocr-flow.js) was an unused export when I read the file; the 13:33 concurrent edit already removed it, so nothing to do.
- pages/report/index.js:120 sets `chatBusy` (read at index.wxml:335) without declaring it in `data` — works, but it is invisible to binding audits; declare it.

Structure/context respected: 14 CONTRACT_FILE copies verified in-sync (no differences reported), 3 pages + component-based tab/FAB left as designed, no file modified by me.

───────── 回执 5/5 ─────────
Agent 00a70e21-351d-4691-8ddd-082ab1aa0aff sent a message:  AUDIT RESULT (scoped: cloudfunctions/_shared/<11 files>, dataWrite/**, dataQuery/**). Read-only; no files modified by me.

CAVEAT: the workspace was being edited concurrently while I audited (db-helpers.js master rewritten 13:32:23, family-write.js 13:33:01, and sync-shared re-generated the _shared copies at ~13:34). All findings below were re-verified against the 13:33–13:37 content.

P1
1. dataWrite/family-write.js:232 — `await deleteFamily(db, familyId, openid)` return value ignored. db-helpers.js:78-84 deleteFamily catches its own error and returns `{code:500}` (it never throws), so a failed final `families` remove still yields `{code:200,msg:'删除成功'}` while all child collections were already cascade-deleted → family stays in listFamilies with 0 members. Fix: `const r = await deleteFamily(...); if (r.code !== 200) return { code: 207, ... }`. Verified by reading both files + the call site.
2. dataWrite/completeness-sync.js:25 (+ _shared/writeSeam.js:104) — policy queries used for scoring/stage do not filter `status`, and deletePolicy only soft-deletes (`status:'deleted'`). Repro with tests/helpers/memory-db: family with a single soft-deleted policy → completeness_score = 60 (still gets the +20 policy points) and advanceStage(db,'f1','o1') moves engagement_stage onboarding→profiling. This directly contradicts policy-write.js:362-364 (“删掉最后一张保单后完整度会掉档，同样需要重算”). Fix: add `status: db.command.neq('deleted')` to both count/get queries (or reuse loadActivePolicies).

P2
3. _shared/memberRepo.js:234-242 FINANCE_FIELD_MAP accepts `income`/`debt`/`liability` aliases into the 元-contract fields (annual_income/total_debt) while the member-level key of the same name is 万 (prompts say upsertMember.data.income=万). Path: dataWrite/handlers.js:33 `updateFinances` passes `event` straight through, and the function-calling schema in conversationAI/tools.js:52 is not enforced — an `{income: 25}`-style call stores 25 元 → getFinance → 0.0025 万 (10000× under-report). Medium confidence (depends on model emitting the alias; no live caller of recordField today). Fix: drop the 万-flavored aliases or reject them with 400.
4. dataQuery/entity-query.js:93,97 (and _shared/memberRepo.js:82-87 findMember) — member lookups omit `status !== 'deleted'`, unlike queryMembers (line 36) and getMembers (memberRepo:48). A soft-deleted member is still resolvable by queryMemberProfile (returns attributes + policies) and writable via setMemberField/upsertMember. Fix: add `status: db.command.neq('deleted')` to the lookups.
5. dataWrite/cash-value-matcher.js:51,65,74,105 — policy matches/candidate lists don't filter `status`, so a soft-deleted policy can be re-matched and receives `cash_value_available/latest_cash_value` (policy-write.js:605, 648); the "long-term candidates" list also surfaces deleted policies. Fix: add status filter to those 4 queries.
6. _shared/db-helpers.js:44-51 safeQueryAll — a failed page is caught, logged and returned as `{data:[]}`, which the loop then reads as “last page” → returns `truncated:false` with silently missing rows (callers entity-query.js:59,109 and share.js:130 ignore the flag anyway). Fix: propagate a per-page failure into the returned object (or rethrow) instead of treating it as end-of-data.

P3
7. dataQuery/family-list.js:159-160,175-176 — `families.profile_progress` is written nowhere (repo grep), so `_computeProgress` is the only path, and its `hasFinance` reads `families.financial_snapshot`, which reportAI/report-context.js:135 documents as no longer maintained (真相源 = `finances`) → finance score always 0. `deliverable_status`/`profile_progress` are also read by nothing under miniprogram/. Dead-ish output; either read finances or delete the fallback.
8. dataWrite/completeness-sync.js:28 — branch `family.profile_state === 'not_ready'` is unreachable: no writer emits 'not_ready' (createFamily writes 'collecting'); constants.js:25 comment claiming reportAI/handlers maintain profile_state is stale.
9. dataWrite/handlers.js:22,32,33 — `upsertMember`/`updateFinances` routes are dead: conversationAI/index.js:26,72-76 executes both in-process via its own _shared/memberRepo, and no miniprogram caller exists (only the unused apiClient.js:36-37 mappings). The comment “由前端 tools fn 路由到本网关” no longer matches the tree (chat-panel dropped streamText).
10. dataWrite/member-write.js:40-56 — if recordField is ever re-wired: the 负债 branch parses `"50万"`→50 and stores it in the 元-contract `total_debt` (10000× under-report), while the sibling 收入 branch explicitly rejects unit text (line 54). Currently moot: recordField has no caller.
11. Duplicated amount math (amount.js:6 forbids scattered conversions): fact-member-sync.js:38,40 inline `Math.round(n/100)/100` instead of `yuanToWan`; policyToFacts.js:24-27 re-branches what `fmtYuan` already does.

DEAD CODE (grep proof)
- _shared/memberRepo.js:295 deleteMembersForFamily — grep shows only definitions/exports in the 7 copies + a mention in a family-write.js:194 comment; zero call sites.
- dataWrite/fact-write.js:139 addMemberFact — grep 'addMemberFact' hits only its definition/export + comments (fact-member-sync.js:10, member-write.js header); zero call sites.
- dataWrite/fact-write.js:198 `strategyOf` re-export — imported nowhere from './fact-write' (tests import it from _shared/fact-vocab).
- dataWrite/member-write.js:23 recordField — only reference is the apiClient.js:22 mapping; no page calls it.
- _shared/memberRepo.js:21 _MEMBER_FIELD_ZH — exported but no consumer anywhere.
- dataWrite/handlers.js:32-33 (see P3 #9); completeness-sync.js:28 (unreachable).

CLEAN (checked, genuinely fine)
writeSeam _openid injection/pre-check/await-ed hooks/batchRemove strict+anti-loop; createHandler OPENID preference; share.js token format+expiry+internal-field stripping; listFamilies/_pageAllMembers stable `_id` pagination and truncated flag; queryMessages cursor+limit clamp; policy-write money normalization (_toYuanAmount + NaN→0 on both write paths), effective_date cleanup, status_effective_date guard, POLICY_STATUS_CHANGEABLE derived from MANUAL_STATUSES; fact-write add-then-supersede with `_id: neq(new)` + rollback + agent_confirmed protection + injection/desensitize; member-matcher family_id in sync where-clause + member_id rollback; memberRepo.createMembersForFamily really does preserve `mem_*` ids (verified: 'mem_keep'.indexOf('m_')===2, matches tests/memberStore.test.js).

