/**
 * reportPdf — 报告 PDF 导出（服务端 pdfkit）
 * 输入 {familyId}；输出 {fileID}。owner 鉴权由 familyView/policy-read 的 _openid 过滤保证。
 * 金额口径：DB 存元 → yuanToWan 转万展示。数据组装对齐 dataQuery/getFamilyDetail。
 * v1 排版：家庭概况 → 深度分析(markdown 纯文本化) → 家庭成员 → 保单明细 → 经济状况 → 免责。
 */
const path = require('path')
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const PDFDocument = require('pdfkit')

const { loadFamilyView } = require('./_shared/familyView')
const { loadActivePolicies } = require('./_shared/policy-read')
const { loadCashValues } = require('./_shared/cash-value-read')
const { toReadReport } = require('./_shared/report-fields')
const { yuanToWan, fmtYuan } = require('./_shared/amount')
const { calcAge } = require('./_shared/calc-age')
const { parseExpiry } = require('./_shared/parse-expiry')
// 2026-09-15 架构审查候选 2：状态文案改用单一事实源（原先自带 if-else，
// 导致"退保/失效/理赔终止"在 PDF 上显示为"待确认"）
const { STATUS_LABELS, listExpiredButActive, isOneYearPolicy, isLifetimeTerm, isSinglePayTerm } = require('./_shared/policy-status')
// 保费现金流趋势：跨树契约（与页面缴费月历章同源，勿在本文件另写算法）
const { buildPremiumTrend } = require('./_shared/premium-trend')
// 保额按险种拆分：跨树契约（与报告页摘要卡、AI 上下文同源；2026-10-14 起不再展示单一总保额）
const { summarizeCoverage } = require('./_shared/coverage-summary')
// 现价/回本计算唯一事实源（与报告表格、前端时间轴共用）
const { breakEvenYear } = require('./_shared/cash-value-math')
// 导出文件登记（2026-09-20 复核批次 B）：云存储无列举 API，不登记就永远找不到这个文件
const { recordReportFile } = require('./_shared/report-files')
// 版式纯函数（2026-10-22）：列宽/双列配对可单测，剩下只有"字有没有压线"要真机看
const { twoColumnRows, columnWidth } = require('./layout')
// 险种归一（成员卡片按险种归行）：与页面同一份跨树契约，避免"PDF 把增额寿当成另一种险"
const { canonCat } = require('./_shared/thresholds')
// A1–A6 异常清单（2026-10-22）：与页面同一份契约，PDF 不再"纸上没有异常提示"
const { buildAnomalies } = require('./_shared/anomaly-list')

const FONT_FILE = path.join(__dirname, 'fonts', 'NotoSansSC-Regular.otf')
// 2026-09-25 PDF 审计：原措辞「基于OCR识别结果自动生成」对**手工录入 / 对话录入**的保单不成立，
// 等于在客户纸面上虚报数据来源。改为覆盖三种录入路径（代理人录入 / 保单识别），
// 三条必备免责表述（仅供参考 / 不构成投保建议 / 以保单原件为准）原样保留。
const DISCLAIMER = '本报告由「保小秘」依据代理人录入及保单识别结果自动生成，数据仅供参考，不构成投保建议。请以保单原件为准。'

const PREFIX = { '{{URGENT}}': '【立即】', '{{NEAR}}': '【近期】', '{{MID}}': '【中期】' }
const EMOJI = {
  '\u2705': '✓ ', '\u26a0\ufe0f': '! ', '\u26a0': '! ', '\u{1F4A1}': '', '\u274c': '× ',
  '\u{1F534}': '[紧急] ', '\u{1F7E1}': '[关注] ', '\u{1F7E2}': '[良好] ', '\u{1F4CC}': ''
}
function mdPlain(raw) {
  if (!raw) return ''
  let t = String(raw)
  for (const k of Object.keys(PREFIX)) t = t.split(k).join(PREFIX[k])
  t = t
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/^\s*\|?\s*[-:| ]+\s*\|?\s*$/gm, '')
  t = t.split('\n').map(function (line) {
    if (line.indexOf('|') !== -1) {
      return line.split('|').map(s => s.trim()).filter(Boolean).join('　')
    }
    return line
  }).join('\n')
  for (const k of Object.keys(EMOJI)) t = t.split(k).join(EMOJI[k])
  // 2026-09-22 修（PDF 审计 P2-2）：通用 emoji 剔除。上面 EMOJI 表只映射了 9 个常用标记，
  // 其余 emoji（🙂💰🚗…）在 NotoSansSC 里**没有字形** → 在 PDF 上渲染成空白或豆腐块。
  // 区间刻意**绕过 U+2713（✓）**：它是上面 EMOJI 映射的输出字符（'\u2705' → '✓ '），
  // 若一并删掉，报告里所有对勾都会消失。同理不碰 CJK 区（0x3000+）与全角标点（0xFF00+）。
  // 也剔除 U+200D（零宽连接符）与私用区（E000-F8FF），避免留下不可见残渣。
  // 2026-09-25（PDF 全面审计）：**符号类必须替换为空格，不能删除**。
  // 原实现把 [\u2190-\u2712]（箭头/数学/几何符号）与 [\u2714-\u2BFF] 一并删掉，于是 AI 写的
  // 「缺口合计约 80 万→需要补充定期寿险」渲染成「80 万需要补充定期寿险」——两侧的词被粘连，
  // 语义被改坏（本次审计用真实渲染逐字复现）。改空格后读作「80 万 需要补充…」，语义不变。
  // 装饰性字符（emoji / 变体选择符 / 零宽连接符 / 私用区）不承载语义，仍直接删（不插空格）。
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{FE00}-\u{FE0F}\u200D\u{E000}-\u{F8FF}]/gu, '')
  t = t.replace(/[\u2190-\u2712\u2714-\u2BFF]/g, ' ')
  return t.replace(/[ \t]{2,}/g, ' ').replace(/ *\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---------- 布局 ----------
// 审计（MEDIUM）：doc/y 原为模块级可变状态，云函数实例热复用 / 并发调用会互相污染渲染状态。
// 已收进 createLayout() 闭包：每次 main 调用通过 createLayout() 获得独立状态实例，互不影响。
const PAGE_W = 595.28
// 2026-09-22 全面审计（死代码清理）：原 `const PAGE_H = 841.89` 已删除——全文件零引用
// （页高由 PDFKit 的 A4 尺寸决定，自动分页不读它）。
const M = 52
const W = PAGE_W - M * 2
const TOP_Y = 60
function createLayout() {
  let doc = null
  let y = 0
  // 目录回填所需状态：预留区起点 + 各小节所在页码（渲染时记录，最后一并画到首页预留区）
  let _tocTop = 0
  let _tocEntries = []

function _cn(size) { doc.font('cn').fontSize(size) }
// 恒纵向 A4 + margin:0。
// 必须显式传 margin:0：PDFDocument 构造时 margin:0 只作用于第一页，
// doc.addPage 若省略 margin 会回退到 PDFKit 默认 72pt，导致新页 maxY=841.89-72=769.89。
// 页脚画在 y=797.89，797.89 > 769.89 会触发 LineWrapper 自动分页 → 页脚被挤到下一页
// （偶数页空白 + 下一页顶部出现页脚，"上下颠倒"视觉）。
//
// 2026-09-25 审计（页脚总页数）：页脚**不在渲染过程中画**，改为渲染结束后统一回填 ——
// 「第 N / 总页数 页」需要先知道总页数，而总页数只有渲染完才知道；
// 因此文档开 bufferPages，最后 _finalize() 逐页 switchToPage 画一次页脚。
// 好处：pdfkit 万一自作分页带出的页也一定被补上页脚（渲染中画的那版会漏）。
function _addPage() {
  doc.addPage({ size: 'A4', margin: 0 })
}
const _BUILD = 'r4' // 部署验证标记：每次改代码递增；现挂在 PDF 元数据（info.Keywords）
/** 逐页回填页脚（含总页数）+ 首页目录。必须在 doc.end() 之前、全部内容渲染完之后调用。 */
function _finalize() {
  const range = doc.bufferedPageRange()
  const total = range.count
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i)
    doc.save(); _cn(8); doc.fillColor('#999999')
    doc.text('保小秘生成 · 家庭保单化验单 · 第 ' + (i + 1) + ' / ' + total + ' 页', M, doc.page.height - 44, { width: W, align: 'right', lineBreak: false })
    doc.restore()
  }
  if (_tocEntries.length) {
    // 回填首页预留区（预留高度由 _reserveToc 按同样的行高算出，两者必须一致）
    doc.switchToPage(range.start)
    let ty = _tocTop
    _cn(10); doc.fillColor('#8a6d2f'); doc.text('目录', M, ty, { width: W }); ty += TOC_HEAD
    _cn(9)
    for (const e of _tocEntries) {
      doc.fillColor('#666666'); doc.text(e.title, M, ty, { width: W - 40, lineBreak: false })
      doc.fillColor('#999999'); doc.text(String(e.page), M + W - 30, ty, { width: 30, align: 'right', lineBreak: false })
      ty += TOC_LINE
    }
  }
}
const TOC_HEAD = 16   // 「目录」标题占高
const TOC_LINE = 13   // 每条目录行高
/** 在首页预留目录区（只推进 y，不落笔；真正内容由 _finalize 回填） */
function _reserveToc(titles) {
  _tocTop = y
  y += TOC_HEAD + titles.length * TOC_LINE + 6
  _tocEntries = titles.map(function (t) { return { title: t, page: 1 } })
}
function _ensure(h) {
  if (y + h > doc.page.height - 56) { _addPage(); y = TOP_Y }
}
function _title(t) { _ensure(30); _cn(20); doc.fillColor('#1a1a1a'); doc.text(t, M, y, { width: W }); y = doc.y + 8 }
function _sub(t) { _cn(9); doc.fillColor('#888888'); doc.text(t, M, y, { width: W }); y = doc.y + 12 }
function _rule() { _ensure(6); doc.strokeColor('#e0e0e0').lineWidth(0.8).moveTo(M, y).lineTo(PAGE_W - M, y).stroke(); y += 14 }
// 2026-09-25 审计：原 _ensure(30) 只保住标题本身 → 标题落在页面最后一行、正文全在下一页
// （实测「保障节点（未来关键时点）」孤立在页脚上方）。预留 62pt 让标题至少带得动首行内容。
function _sec(t) {
  _ensure(62); _cn(13); doc.fillColor('#8a6d2f')
  // 记录小节实际落页（目录回填用）：直接问 pdfkit 的缓冲页数，而不是自维护计数 ——
  // pdfkit 在文本超出页底时会自行 continueOnNewPage()（绕过 _addPage），自维护计数会漏记，
  // 导致其后所有小节的目录页码整体错位。缓冲页数无论如何加页都是准的。
  const te = _tocEntries.find(function (e) { return e.title === t })
  if (te) te.page = doc.bufferedPageRange().count
  doc.text(t, M, y, { width: W }); y = doc.y + 3
  doc.strokeColor('#d8c59a').lineWidth(1).moveTo(M, y).lineTo(PAGE_W - M, y).stroke(); y += 10
}
/**
 * 按高度取一段能放得下的文本（2026-09-25 审计新增）
 *
 * 为什么需要：_ensure() 只能把「放不下」的段落推到新页；若单段本身高过一整页的可用高度，
 * 推完仍然放不下 → pdfkit 的 LineWrapper 会自行 continueOnNewPage() 分页，**绕过 _addPage()**，
 * 于是那一页会由 pdfkit 自行 continueOnNewPage 带出（绕过 _addPage），页脚靠 _finalize 兜住。
 * 故绘制前先按高度切块。二分查找切点，落在字符边界（中文无词边界，按字符切即最优可达）。
 * @returns {{text: string, rest: string}} 本块与余下部分（全放得下时 rest 为 ''）
 */
function _cutByHeight(text, width, maxH) {
  const s2 = String(text)
  if (doc.heightOfString(s2, { width: width, lineGap: 3 }) <= maxH) return { text: s2, rest: '' }
  let lo = 1, hi = s2.length, best = 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (doc.heightOfString(s2.slice(0, mid), { width: width, lineGap: 3 }) <= maxH) { best = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  return { text: s2.slice(0, best), rest: s2.slice(best) }
}
function _para(t, size, opts) {
  if (!t) return
  opts = opts || {}
  const s = size || 10
  _cn(s)
  doc.fillColor(opts.color || '#333333')
  const w = W - (opts.indent || 0)
  // 审计修复（r4）：heightOfString 必须带与 doc.text 相同的 lineGap——此前缺省导致多行文本高度低估，
  // doc.text 实际超出页底触发 pdfkit 内部自动分页（自动页无 margin:0，产生空白页/错位翻转）
  const h = doc.heightOfString(t, { width: w, lineGap: 3 })
  // 本页装不下整段 → 按高度切块，逐块递归（每块都放得下，不会触发 pdfkit 自作分页）：
  //   ① 先尽量填满**当前页剩余空间** —— 否则整段被整块推到下一页，前面留一大片空白；
  //   ② 余下部分按整页可用高度切。
  // 单段 <= 当前页剩余高度时走下面的原路径（常见情形，行为不变）。
  const limitY = doc.page.height - 56
  const onePageMax = limitY - TOP_Y
  if (h > (limitY - y)) {
    // 本页剩余空间不足三行 → **先换页再切**。不能只靠「跳过首页切块」：那样会在同一个 y 上
    // 反复切出同一段（块 ≤ 整页高但 > 本页剩余）→ 递归不收敛（实测卡死）。
    if ((limitY - y - 20) <= s * 3) { _addPage(); y = TOP_Y }
    const chunks = []
    let rest = String(t)
    const firstCap = limitY - y - 20        // 预留 _ensure 的 12 + gap 余量
    if (firstCap > s * 3) {
      const cut = _cutByHeight(rest, w, firstCap)
      if (cut.text) { chunks.push(cut.text); rest = cut.rest }
    }
    while (rest) {
      const cut = _cutByHeight(rest, w, onePageMax)
      chunks.push(cut.text); rest = cut.rest
    }
    for (const chunk of chunks) _para(chunk, size, opts)
    return
  }
  _ensure(h + 12 + (opts.gap || 8))
  doc.text(t, M + (opts.indent || 0), y, { width: w, lineGap: 3 })
  y = doc.y + (opts.gap || 8)
}
function _block(text, size, opts) {
  // 多段/列表文本逐行绘制（AI 文本；块内分页安全）
  const lines = (text || '').split('\n')
  for (const ln of lines) {
    if (!ln.trim()) { y += (size || 10) * 0.6; continue }
    _para(ln.trim(), size, Object.assign({ indent: /^[•\d]/.test(ln.trim()) ? 14 : 0 }, opts || {}))
  }
}
function _statusTxt(p) {
  // 单一事实源 policy-status.STATUS_LABELS（9 态）。
  // 原实现只认 active/expired/cancelled，其余（lapsed/surrendered/claim_terminated）
  // 一律落到"待确认"——业务员显式标了"退保"，导出的 PDF 上却印"待确认"。
  return STATUS_LABELS[p.status] || '待确认'
}

// ---------- 主流程 ----------
function buildPdf(ctx) {
  const family = ctx.family
  const report = ctx.report
  const members = (family.members || []).filter(m => m.status !== 'deleted')
  const policies = ctx.policies || []
  // 2026-09-22（PDF 审计 P2-6）：原变量名为 `fs`，与模块级 `const fs = require('fs')` 同名遮蔽
  // （后者其实从未使用，已删）。改名消除可读性陷阱：本变量是财务快照，不是文件系统。
  const fin = family.financial_snapshot || {}
  // 2026-09-25 PDF 审计：封面用「<经济支柱>家庭」，不再直接印代理人的档案名（见 _displayName）
  const name = _displayName(family)
  // 章节目录（2026-09-25 审计新增）：小节清单必须**在正文渲染之前**固定下来 ——
  // 首页要按它预留高度、最后再回填页码。
  // 2026-10-24：目录里不再有「深度分析（AI 解读）」—— PDF 已不含 AI 章节（只列事实）。
  const tocTitles = ['保障摘要']
    .concat(['成员卡片', '保单明细', '异常与待核验', '保障期间（谁保到什么时候）', '保障节点（未来关键时点）', '保费分布', '缴费与现金流（每年固定缴费月）'])
  const now = new Date()
  const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
  const act = policies.filter(p => p.status === 'active')
  const premiumW = yuanToWan(act.reduce((s, p) => s + (p.annual_premium || 0), 0))
  // 保额汇总：2026-10-14 用户决策「不再展示单一总保额，按保障类型统计」——
  // 主数字改为**保障型保额**（重疾/医疗/意外/寿险 = 发生风险时赔钱的那部分），储蓄型另计，
  // 并列出分险种明细。聚合走跨树契约 coverage-summary.js（与报告页 / AI 上下文同源；
  // 此前本文件自算 coverageW，是三份独立实现之一）。
  // ⚠️ 金额口径本身**未变**（医疗险报销年限额仍计入其险种金额，见 docs/data-model-v2.md「保额口径」）；
  // 变的是"把它们相加成一个数字"这件事 —— 那正是会误导的地方。
  const covSum = summarizeCoverage(act)
  // coverageW（protectionW 合计）自 2026-10-17 起不再展示：报销上限与赔付款相加会误导。
  const income = fin.income || 0
  const debtAmt = (fin.debt && fin.debt.amount) || 0
  // 兜底：financial_snapshot 未填但成员有个人收入（万）时，经济状况仍展示成员合计
  const memberIncome = members.reduce(function (s, m) { return s + (m.income || 0) }, 0)

  // 标题
  _title(name + ' · 家庭保单化验单')
  _sub('生成时间：' + dateStr + '　|　家庭成员 ' + members.length + ' 人　|　保单 ' + policies.length + ' 份（有效 ' + act.length + '）')
  _rule()

  // 2026-09-20（PDF 审计 §4）：定性模式披露，置于正文最前（与报告页页头卡片同位置）。
  // 空串不渲染——只有 tier=degraded 的导出才有这一行，它是客户拿到的纸面上
  // 唯一"为什么整份报告没有金额"的解释。
  const qualNote = _qualitativeNote(family)
  if (qualNote) { _para(qualNote, 9, { color: '#8a6d2f' }); y += 2 }

  // 章节目录（客户翻纸面用）：只预留位置，页码在 _finalize() 里回填（渲染完才知道各节落在第几页）
  _reserveToc(tocTitles)

  // 保障摘要
  _sec('保障摘要')
  _cn(10)
  const colW = W / 3
  // 2026-09-25 审计：原 `new Set(act.map(p => p.insured_name || ''))` 把所有**缺被保人姓名**的保单
  // 算成同一个人（空串也是集合里的一个键）→ 3 张未挂到人的保单显示「保障人数 1」，与本页
  // 明细表里 3 行「—」自相矛盾。改为只数非空姓名；一个都数不出时如实写「待补」。
  const insuredCount = _insuredCount(act)
  // 2026-10-17：与报告页/摘要卡同口径 —— 主数字改「给付型保额」（寿险+重疾），
  // 报销额度单列成一行（医疗+意外）。仍保留 3 格布局（colW 按 3 等分算），
  // 不把 2310 万这种"报销上限 + 赔付款"的合计再印到纸上。
  const sums = [['年保费(万)', String(premiumW || 0)], ['给付型保额(万)', String(covSum.payoutW || 0)], ['保障人数', insuredCount]]
  let cx = M
  for (const it of sums) {
    _cn(9); doc.fillColor('#888888'); doc.text(it[0], cx, y, { width: colW - 8, lineBreak: false })
    _cn(15); doc.fillColor('#1a1a1a'); doc.text(String(it[1]), cx, y + 12, { width: colW - 8, lineBreak: false })
    cx += colW
  }
  y += 40
  // 分险种明细（与报告页摘要卡同源数据）：按保障类型列出，储蓄型另计
  if (covSum.byCat.length) {
    _para(covSum.byCat.map(function (x) { return x.cat + ' ' + x.w + ' 万' }).join('　·　'), 9, { color: '#555555' })
  }
  if (covSum.quotaW > 0) {
    _para('报销额度（医疗 / 意外）' + covSum.quotaW + ' 万，每年需续保，与上述给付型保额不可相加', 9, { color: '#777777' })
  }
  if (covSum.savingsW > 0) {
    _para('储蓄型（年金 / 增额寿 / 终身寿）合计 ' + covSum.savingsW + ' 万，与上述给付型分列', 9, { color: '#777777' })
  }
  if (covSum.unknownW > 0) {
    _para(covSum.unknownW + ' 万的保单未标注险种，未计入上述分类', 9, { color: '#999999' })
  }
  // premiumW/income 均为万口径，占比 = 保费万 / 收入万 × 100
  if (income > 0) _para('保费占家庭年收入约 ' + (premiumW / income * 100).toFixed(1) + '%', 9, { color: '#777777' })
  // 2026-09-22：一年期短险单列（沿用 2026-09-04「防总保额虚高误导」决策，原先只到报告页摘要卡）。
  // 与下面的到期提醒同属"总保额的口径说明"：先讲构成（其中多少是一年期短险），再讲时效（哪些载明已过期）。
  const shortNote = _shortNote(act)
  if (shortNote) { _para(shortNote, 9, { color: '#777777' }); y += 2 }
  // 2026-09-22（产品决策）：载明期限已过的保单提醒。紧贴"保障摘要"——摘要里的总保额/人数
  // 正是把这些已过期保单算进去的数字，提醒放这里才对得上号。
  const expNote = _expiryNote(act)
  if (expNote) { _para(expNote, 8.5, { color: '#8a6d2f' }); y += 2 }
  _rule()

  // 成员卡片（2026-10-24，方案第二部分第 6 项）：每人一张五行表，两列并排。
  // 只给「险种 / 保额 / 年缴」三列 —— 保险期间与缴费期间在「保单明细」节按保单逐条已给，
  // 这里重复一遍会把纸面撑长而不增信息（PDF 的目标是 1–2 页）。
  if (members.length) {
    _sec('成员卡片')
    _para('每人五行（意外/医疗/重疾/寿险/储蓄）；期间明细见「保单明细」。无保单成员照常列出。', 8, { color: '#999999', gap: 4 })
    const COL_GAP2 = 20
    const colW2 = columnWidth(W, 2, COL_GAP2)
    const cards = _memberCardData(members, act, policies)
    for (const row of twoColumnRows(cards)) {
      const y0 = y
      let h = 0
      ;[row.left, row.right].forEach((c, ci) => {
        if (!c) return
        const x = M + ci * (colW2 + COL_GAP2)
        let yy = y0
        _cn(9.5); doc.fillColor('#1a1a1a')
        doc.text(c.title, x, yy, { width: colW2 })
        yy = doc.y + 1
        _cn(8); doc.fillColor('#555555')
        c.lines.forEach((ln) => {
          doc.text(ln, x, yy, { width: colW2 })
          yy = doc.y + 1
        })
        _cn(8); doc.fillColor('#888888')
        doc.text(c.foot, x, yy, { width: colW2 })
        h = Math.max(h, doc.y - y0)
      })
      y = y0 + h + 8
    }
    _rule()
  }

  // 2026-10-24（用户决策）：PDF **不再包含 AI 深度分析**。
  // 报告定位是"家庭保单化验单：只列事实"，而 AI 的 review/analysis/plan/suggestions 是诊断与建议；
  // 纸面件是拿去面谈、甚至直接留给客户的，一旦印上建议，定位就破了。
  // AI 仍保留为 App 内的独立入口（页尾手动生成），与纸质件彻底分开。
  void deep
  void report

  // 2026-10-27（用户决策）：删除「家庭成员」节 —— 它与「成员卡片」是同一批人的两份清单，
  // 姓名/角色/年龄已在成员卡片标题里，职业与健康不属于保单事实（方案只加工保单）。

  // 保单明细（纵向主行 + 副行附加信息：保单号/公司/保险期间全保留）
  _sec('保单明细')
  if (!policies.length) {
    _para('暂无保单记录', 10, { color: '#999999' })
  } else {
    _para('金额单位：不足 1 万按元显示；每行保单下方为 公司/保险期间/缴费期/生效日', 8, { color: '#999999', gap: 4 })
    _policyTable(policies)
  }
  _rule()

  // 异常与待核验 A1–A6（2026-10-22）：与页面同一份契约（_shared/anomaly-list），
  // 编号固定，顾问面谈可直接引用"见 A3"。本次无异常 → 整段不出现（不印空标题）。
  const anomalies = buildAnomalies({ policies: policies, now: new Date() })
  if (anomalies.length) {
    _sec('异常与待核验')
    _para('只列基于保单基本信息可核对的事实与提示，不涉及条款、不构成诊断。编号固定（A1–A6）。', 8, { color: '#999999', gap: 4 })
    for (const g of anomalies) {
      _ensure(22)
      _para(g.code + '　' + g.title + '（' + g.count + ' 项）', 10)
      for (const it of g.items) {
        _ensure(14)
        _para('　' + it.member + '　' + it.product + '　' + it.detail, 9, { color: '#666666', gap: 2 })
      }
    }
    _rule()
  }

  // 保障期间（2026-10-13 报告结构 v2.0 ③）：与页面甘特图**同源数据**，纸面以表格呈现。
  // 位置与页面一致——紧邻"保障节点"之前（同一章里先看全局期间，再看未来关键时点）。
  _sec('保障期间（谁保到什么时候）')
  const cov = ctx.coverage || { rows: [], notes: [] }
  if (!cov.rows.length) {
    _para('暂无可展示的保障期间（保单缺少生效日期或保障期间）', 10, { color: '#999999' })
  } else {
    for (const r of cov.rows) {
      _ensure(16)
      // 到期年补"止于多少岁"（与页面甘特图同行信息同源）：回答"60 岁时还剩什么"
      const span = r.startY + ' → ' + (r.lifetime ? '终身' : (r.endY + '年' + (r.endAge ? '（止于' + r.endAge + '岁）' : '')))
      const tail = []
      if (r.cat) tail.push(r.cat)
      if (r.oneYear) tail.push('一年期·续保')
      // 缴费期与保障期分开写（与页面甘特图"斜纹=缴费期/实色=保障期"同语义）：
      // 纸面上用"缴费至 XXXX 年"承担，于是"钱交完了但保障还在"同样一眼可见
      if (r.singlePay) tail.push('趸交')
      else if (r.payEndY) tail.push('缴费至' + r.payEndY + '年')
      if (r.sumAssured) tail.push(_fmtMoney(r.sumAssured))
      _cn(9.5); doc.fillColor('#1a1a1a')
      doc.text('· ' + r.name + ' ｜ ' + r.product + ' ｜ ' + span + (tail.length ? ' ｜ ' + tail.join(' ｜ ') : ''), M, y, { width: W })
      y = doc.y + 3
    }
    for (const n of (cov.notes || [])) _para('· ' + n, 8, { color: '#999999' })
  }
  _rule()

  // 保障节点（里程碑：保障期满/交费期满/现价回本，按年分组）
  _sec('保障节点（未来关键时点）')
  const nodes = ctx.nodes || []
  if (!nodes.length) {
    _para('暂无未来保障节点', 10, { color: '#999999' })
  } else {
    for (const yr of nodes) {
      _ensure(20)
      _cn(11); doc.fillColor('#1a1a1a'); doc.text(String(yr.y) + '年', M, y, { width: W }); y = doc.y + 2
      for (const it of yr.items) {
        _para(it.name + '：' + it.notes.join(' / '), 9, { color: '#555555', indent: 12, gap: 3 })
      }
      y += 4
    }
  }
  _rule()

  // 缴费月历（每年固定缴费月：active 保单按生效月分组）
  // 2026-10-22：节名与页面章节对齐（页面已改名「缴费与现金流」，因为该章同时有年度趋势与月历）
  // 保费分布 7a / 7b（2026-10-24，方案第三部分）：页面已有，纸面补齐。
  // 7c（月历）与 7d（按年）紧随其后，由下一节承担 —— 四段齐全但不重复。
  if (act.length) {
    _sec('保费分布')
    _para('仅计有效保单；附加险保费并入自身险种；保障型=意外/医疗/重疾/寿险，储蓄型=年金等。', 8, { color: '#999999', gap: 4 })
    _cn(9); doc.fillColor('#8a6d2f'); doc.text('7a 按成员与险种', M, y, { width: W }); y = doc.y + 3
    const COL_W = [110, 58, 58, 58, 58, 58, 80]
    const heads = ['成员', '意外', '医疗', '重疾', '寿险', '储蓄', '合计']
    const line = (cells, color) => {
      _ensure(14)
      let x = M
      _cn(8); doc.fillColor(color)
      cells.forEach((c, i) => {
        doc.text(String(c == null ? '' : c), x, y, { width: COL_W[i], align: i === 0 ? 'left' : 'right', lineBreak: false })
        x += COL_W[i]
      })
      y += 12
    }
    const premRow = (name, list) => {
      const row = [name]
      ;['意外险', '医疗险', '重疾险', '寿险', '年金'].forEach((cat) => {
        const yuan = list.filter((p) => canonCat(p.insurance_category || '') === cat)
          .reduce((s, p) => s + (Number(p.annual_premium) || 0), 0)
        row.push(yuan > 0 ? String(Math.round(yuan)) : '0')
      })
      row.push(String(Math.round(list.reduce((s, p) => s + (Number(p.annual_premium) || 0), 0))))
      return row
    }
    line(heads, '#888888')
    members.forEach((m) => {
      line(premRow(m.name || '未指定', act.filter((p) => String(p.insured_name || '') === String(m.name || ''))), '#444444')
    })
    line(premRow('合计', act), '#1a1a1a')
    y += 4

    _cn(9); doc.fillColor('#8a6d2f'); doc.text('7b 按公司', M, y, { width: W }); y = doc.y + 3
    const byIns = {}
    act.forEach((p) => {
      const k = p.insurer || '未知保司'
      if (!byIns[k]) byIns[k] = { name: k, count: 0, prem: 0 }
      byIns[k].count += 1
      byIns[k].prem += Number(p.annual_premium) || 0
    })
    Object.keys(byIns).map((k) => byIns[k]).sort((a, b) => b.prem - a.prem).forEach((x) => {
      _para(x.name + '　' + x.count + ' 份　' + _fmtMoney(x.prem), 9, { color: '#444444', gap: 2 })
    })
    _rule()
  }

  _sec('缴费与现金流（每年固定缴费月）')
  const months = ctx.payMonths || []
  const filledMonths = months.filter(m => m.items.length)
  if (!filledMonths.length) {
    _para('暂无年度缴费安排', 10, { color: '#999999' })
  } else {
    for (const m of months) {
      if (!m.items.length) continue
      _cn(10); doc.fillColor('#1a1a1a'); doc.text(String(m.month) + '月', M, y, { width: 42, lineBreak: false })
      // 单期金额 + 频次后缀（月交显示「100元/月」，年交不加后缀）；同频次时补月度合计
      const t = m.items.map(function (it) { return it.name + ' ' + _fmtMoney(it.premium) + (it.unit && it.unit !== '年' ? '/' + it.unit : '') }).join('　')
        + (m.total ? '　合计 ' + _fmtMoney(m.total) + (m.unit && m.unit !== '年' ? '/' + m.unit : '') : '')
      _cn(9); doc.fillColor('#555555')
      const tx = M + 48
      const tw = W - 48
      // r4：heightOfString 与 doc.text 的 lineGap 保持一致，防低估触发 pdfkit 自动分页
      _ensure(doc.heightOfString(t, { width: tw, lineGap: 2 }) + 10)
      doc.text(t, tx, y, { width: tw, lineGap: 2 })
      y = doc.y + 4
    }
  }
  // 2026-10-14 保费现金流（用户稿子两处：关键节点的"下一期缴费"、年度趋势的"缴费期满释放现金流"）。
  // ⚠️ 与页面同源：走跨树契约 _shared/premium-trend.js（不在本文件另写一份算法 —— 期限口径分裂
  // 已经让 PDF 吃过一次亏，见 policy-terms.js 头注释）。
  // ⚠️ 用本作用域内的 `act`（= policies.filter(active)，见 buildPdf 开头）。
  // 首版写成 `activePolicies` —— 那是**另一个函数**（调用层）里的变量名，此处为 undefined
  // → PDF 导出必 ReferenceError。测试没抓到（断言只查源码文本），是 eslint no-undef 抓的。
  const trend = buildPremiumTrend(act, family.members || [])
  if (trend.upcoming.length) {
    const u = trend.upcoming[0]
    _para('下一期缴费：' + u.y + ' 年 ' + u.m + ' 月，合计 ' + _fmtMoney(u.amountW * 10000) +
      '（' + u.count + ' 笔' + (u.list.length ? '：' + u.list.map(function (it) { return it.product + ' 第' + it.periodNo + ' 期' }).join('、') : '') + '）', 9, { color: '#555555' })
  }
  // 最多两级台阶：最近一次下降 + 最终归零（中间台阶多时只报头尾，避免纸面啰嗦）
  const stepIdx = trend.drops.length > 2 ? [0, trend.drops.length - 1] : trend.drops.map(function (_, i) { return i })
  stepIdx.forEach(function (i) {
    const d = trend.drops[i]
    _para(d.y + ' 年起年缴保费降至 ' + d.toW + ' 万（' + d.products.join('、') + ' 缴费期满），每年减少支出 ' + d.reducedW + ' 万', 9, { color: '#555555' })
  })
  trend.notes.forEach(function (n) { _para('· ' + n, 8, { color: '#999999' }) })
  _rule()

  // 2026-10-27（用户决策）：删除「经济状况」节。
  // 收入与负债在报告里只服务于"需求推算"，而 PDF 已不含推算；单独印一节收支，
  // 客户会问"我的收入为什么印在保单清单里"。要看收支请看 App（家庭财务章仍是事实）。
  void income
  void memberIncome
  void debtAmt
  void fin

  // 免责
  // 2026-09-25 PDF 审计：这是法律上最该被读到的一行，却是全篇最浅最小的字（8pt #999999，
  // 对比度约 2.9:1，低于 WCAG AA 的 4.5:1）。提到 9pt / #666666。
  _ensure(24)
  _para(DISCLAIMER, 9, { color: '#666666' })
}

// 财务展示：financial_snapshot 已是"万"口径（getFinance 元→万、edit-form 表单直接写万），
// 禁止再经 yuanToWan（会把 30 万缩水成 0.3 万）；0/空返回空串
function _wanStr(v) {
  const n = Number(v)
  if (isNaN(n) || n <= 0) return ''
  const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10)
  return s + '万'
}
function _fmtMoney(v) {
  const n = Number(v)
  if (!n) return ''
  return Number(n).toLocaleString('en-US') + '元'
}
// 金额单元格：>0 用 fmtYuan（≥1万→万，<1万→元），空/0 → —
function _amtCell(v) {
  const n = Number(v)
  if (isNaN(n) || n <= 0) return '—'
  return fmtYuan(n)
}
// 缴费期短文本（与前端 chapter-builder._payTermText 判据一致）
// 2026-09-15：原实现只看 insurance_period 文本，漏了 coverage_term===1（对话录入的一年期）
// → 同一份保单前端显示"一次性"、PDF 显示"趸交"。
// 2026-09-25 审计：本文件原先还自建了一份 `_isOneYearPolicy`（只认文本形态 + coverage_term），
// 而契约 policy-status.isOneYearPolicy 额外认**日期区间形态**（线上真实数据的一年期全是这个形态）
// → 同一张保单在「一年期短险」汇总里被算作短险、在「缴费期」列却显示 "—"，同一页内自相矛盾。
// 现统一走契约（契约是超集，只会把 "—" 修成 "一次性"）。
function _payTermShort(p) {
  if (isOneYearPolicy(p)) return '一次性'
  if (p.payment_period) return String(p.payment_period)
  const pt = p.premium_term
  if (pt === 1 || pt === '1' || pt === 0 || pt === '0') return '趸交'
  if (pt) return '缴' + String(pt) + '年'
  return '—'
}
// 保单明细表（纵向）：主行=产品/保单号/被保人/保额/年缴/状态，副行=公司/保险期间/缴费期/生效日
// 全纵向无方向切换；跨页自动重复表头；主行/副行成组不拆行
// 列宽合计 490（W=491.28）。原 170/90/52/52/48/42=454 白白空出 37pt，最该宽的产品名反而最先被挤；
// 2026-09-25 审计把余量给产品名（+28）与被保人/保额/年缴。
const POLICY_COLS = [198, 90, 54, 56, 50, 42]
/**
 * 单行裁剪（2026-09-25 审计新增）
 *
 * pdfkit 的 `ellipsis: true` 只在**同时传了 height** 时才生效（pdfkit 0.15 LineWrapper：
 * `if (this.height != null && this.ellipsis && ...)`），本文件从不传 height →
 * 原 `ellipsis: true` 是**死参数**，超宽文本直接换行；而主行行高恒为 rowH=20，
 * 换行的第二行于是压在下方副行上，两段文字**逐字重叠**（审计用渲染后的文本坐标证实：
 * 主行第二行 y=98.3 与副行 y=102.0 的 x 区间完全重合，客户看到的是糊成一团的乱码）。
 * 现按实测字宽裁剪 + 省略号，保证主行恒为单行、列不错位。
 */
function _clip(str, width) {
  const s = String(str == null ? '' : str)
  if (!s) return ''
  if (doc.widthOfString(s) <= width) return s
  let cut = s.length
  while (cut > 1 && doc.widthOfString(s.slice(0, cut) + '…') > width) cut--
  return s.slice(0, cut) + '…'
}
function _policyTable(policies) {
  const fs = 8.5
  const rowH = 20
  const subH = 14
  const x0 = M
  const heads = ['产品', '保单号', '被保人', '保额', '年缴', '状态']
  const widths = POLICY_COLS
  const xs = []
  let acc = 0
  for (let i = 0; i < widths.length; i++) { xs.push(acc); acc += widths[i] }
  let cy = y
  const headRow = function () {
    if (cy + rowH > doc.page.height - 52) { _addPage(); cy = TOP_Y }
    doc.save()
    doc.fillColor('#f2efe6').rect(x0, cy, W, rowH).fill()
    doc.restore()
    for (let i = 0; i < heads.length; i++) {
      _cn(fs); doc.fillColor('#666666')
      doc.text(heads[i], x0 + xs[i] + 3, cy + 6, { width: widths[i] - 6, lineBreak: false })
    }
    cy += rowH
  }
  headRow()
  for (const p of policies) {
    const eff = (p.contract_effective_date || p.effective_date || '').substring(0, 10) || '—'
    const cells = [
      String(p.product_name || p.policy_name || '未命名保单'),
      p.policy_number || '—',
      p.insured_name || '—',
      _amtCell(p.sum_assured),
      _amtCell(p.annual_premium),
      _statusTxt(p)
    ]
    _cn(fs)
    // 产品名最多两行：它是客户识别这张保单的第一信息，截成「…重大疾…」几乎不可读；
    // 其余列单行裁剪（列不错位）。行高按产品名实测高度决定 → 主行不再是固定 rowH。
    // 注意这里**必须**传 height —— pdfkit 的 ellipsis 只在 height != null 时生效，
    // 恰好也给出「超过两行就省略号收尾」的语义（不会再溢出到下一行）。
    const nameW = widths[0] - 6
    const nameH = doc.heightOfString(String(cells[0] || ''), { width: nameW, lineGap: 2 })
    const rowHActual = Math.max(rowH, Math.min(nameH, fs * 2 * 1.6) + 8)
    // 预留主行 + **最多两行副行**：副行过长会换行，原实现只按固定 subH 预留 → 换行后与下一条
    // 保单重叠（2026-09-25 审计实测）。真实高度在绘制后按 heightOfString 推进 cy。
    if (cy + rowHActual + subH * 2 > doc.page.height - 52) { _addPage(); cy = TOP_Y; headRow() }
    doc.fillColor('#333333')
    doc.text(String(cells[0] || ''), x0 + 3, cy + 6, { width: nameW, lineGap: 2, height: rowHActual - 8, ellipsis: true })
    for (let i = 1; i < cells.length; i++) {
      // _clip 依赖当前字体字号（widthOfString）→ 必须在 _cn(fs) 之后调用
      doc.text(_clip(cells[i], widths[i] - 6), x0 + xs[i] + 3, cy + 6, { width: widths[i] - 6, lineBreak: false })
    }
    const bits = []
    if (p.insurer) bits.push('公司：' + p.insurer)
    if (p.insurance_period) bits.push('保险期间：' + p.insurance_period)
    const pt = _payTermShort(p)
    if (pt !== '—') bits.push('缴费期：' + pt)
    bits.push('生效日：' + eff)
    cy += rowHActual
    _cn(7.5); doc.fillColor('#999999')
    // 副行**允许换行**（公司/保险期间/缴费期/生效日 不该被丢掉），但高度必须实测：
    // 原实现固定 subH=14 且带死的 ellipsis → 两行的副行会压到下一条保单的主行上（审计已复现）。
    const subTxt = bits.join('　')
    const subHActual = Math.max(subH, doc.heightOfString(subTxt, { width: W - 6, lineGap: 2 }))
    doc.text(subTxt, x0 + 3, cy + 2, { width: W - 6, lineGap: 2 })
    const sepY = cy + subHActual + 1
    doc.strokeColor('#efefef').lineWidth(0.5).moveTo(x0, sepY).lineTo(x0 + W, sepY).stroke()
    cy = sepY + 3
  }
  y = cy + 8
}

  // 会话 API：begin(fname) 新建 PDF 文档并重置页码/纵坐标；build(ctx) 执行完整排版
  return {
    begin: function (fname) {
      // bufferPages：页脚要写「第 N / 总页数 页」、首页要回填目录页码 —— 两者都必须在文档渲染完之后
      // 用 switchToPage 回头补画，故必须开缓冲（文档仅 3~6 页，内存开销可忽略）。
      doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: fname + '家庭保单化验单', Keywords: 'baoxiaomi build ' + _BUILD } })
      y = 60
      _tocTop = 0
      _tocEntries = []
      doc.registerFont('cn', FONT_FILE)
      return doc
    },
    build: buildPdf,
    // 内容全部渲染完之后、doc.end() 之前调用：逐页回填页脚（含总页数）+ 首页目录
    finalize: _finalize
  }
}

// ======================== 保障节点 / 缴费月历（复刻前端 timeline-builder / chapter-builder 口径） ========================
// 双字段兼容：OCR 文本（insurance_period/payment_period）优先，兜底对话数字（coverage_term/premium_term）
// 哨兵判定（终身 coverage_term = 105/'105'/0/'0'；趸交 premium_term = 1/'1'/0/'0'）已收敛到契约
// `_shared/policy-status` 的 isLifetimeTerm / isSinglePayTerm。
// 【2026-09-22 口径自查】本文件原先就地自建 `const LIFETIME_TERM = 105` —— 那正是 2026-09-20
// PDF 审计 P1 的修法（原实现只排除 0/'0'，coverage_term=105 的保单算出 ~2130 年"保障期满"）。
// 但"就地补一份"只是把"下一个消费方还会漏"往后推了一次：同一约定当时另有 3 处在内联比较。
// 现统一走契约 + 源码扫描测试兜住新增消费方。

function _termYear(textPeriod, numTerm, startY, age, opts) {
  if (textPeriod) {
    const r = parseExpiry(textPeriod, String(startY) + '-01-01', age || 0)
    if (/终身|长期/.test(String(textPeriod || ''))) return null
    return r.year
  }
  const t = numTerm
  // 2026-09-20 修（PDF 审计 P1）：补 105（终身）哨兵。原实现只排除 0/'0' →
  // coverage_term=105 的保单算出 startY+105，PDF「保障节点」出现 ~2130 年"保障期满"的
  // 荒谬条目；而同一份数据在前端 timeline-builder._coverTermYear 返回 null（无该节点）→ 口径分裂。
  // 触发面：insurance_period 为空（文本优先，见本函数首行）且 coverage_term=105，即**对话录入**路径；
  // OCR 录入的保单带 insurance_period，不受影响。
  // premium_term 无 105 约定（schema 只有 1=趸交/年限），故统一排除对下方两个调用点都安全。
  if (t === null || t === undefined || t === '') return null
  if (isLifetimeTerm(t)) return null // 终身（105/'105'）与更早的未填哨兵（0/'0'）都无到期节点
  const n = parseInt(String(t), 10)
  if (!isNaN(n) && n > 0) {
    if (opts && opts.singleYearEnd === true && isSinglePayTerm(n)) return null // 趸交/终身缴费无"缴完"节点
    return startY + n
  }
  return null
}

// ---------- 报告级披露（2026-09-20 PDF 审计 §4 / P2-1）----------
// 两个纯函数，各自返回一行文案或空串（空串 = 不渲染），便于单测。
/**
 * 封面/元数据用的客户显示名（2026-09-25 PDF 审计）
 *
 * 为什么：封面原标题取 `families.family_name` —— 那是**代理人自己的档案名**，实测形如
 * 「李姐-转介绍（老客户）」，客户拿到手会看到「转介绍（老客户）」这种内部备注。
 * 现改为按成员推导「<经济支柱姓名>家庭」：优先 role 含「本人/经济支柱」且有姓名的成员，
 * 其次任一有姓名的成员；一个姓名都取不到时回退 family_name（不猜）。
 * 注意：小程序内仍用 family_name（代理人视角），只改**对外纸面**的标题。
 */
function _displayName(family) {
  const members = (family && family.members) || []
  const named = members.filter(function (m) {
    return m && m.status !== 'deleted' && String(m.name || '').trim()
  })
  const pillar = named.find(function (m) { return /本人|经济支柱/.test(String(m.role || '')) }) || named[0]
  if (pillar) return String(pillar.name).trim() + '家庭'
  return String((family && (family.family_name || family.name)) || '家庭')
}

/**
 * 剥掉正文**首行**的 markdown 标题（2026-09-25 PDF 审计）
 *
 * 为什么：AI 的 review/analysis/plan 常以「## 保障缺口分析」这种标题开头，而 buildPdf 已经在
 * 上面印了同名小节标题 → 客户纸面上标题连印两次（审计已复现）。只剥首行：中间的标题可能
 * 是 AI 的子分段，保留为普通行。
 */
function _stripLeadHeading(text) {
  return String(text || '').replace(/^\s*#{1,6}[ \t]*[^\n]*(?:\n|$)/, '')
}

/**
 * 「保障人数」计数（2026-09-25 PDF 审计）
 *
 * 原实现 `new Set(act.map(p => p.insured_name || ''))`：空串也是集合里的一个键，于是**所有**
 * 缺被保人姓名的保单被算成同一个人 —— 3 张未匹配到人的保单显示「保障人数 1」，与明细表里
 * 3 行「—」自相矛盾。改为只数非空姓名；一张都数不出时如实写「待补」（无有效保单写 0）。
 */
function _insuredCount(policies) {
  const list = Array.isArray(policies) ? policies : []
  const names = new Set(list.map(function (p) { return String((p && p.insured_name) || '').trim() }).filter(Boolean))
  if (names.size) return String(names.size)
  return list.length ? '待补' : '0'
}

function _pad2(n) { return String(n).padStart(2, '0') }
function _fmtTs(d) {
  return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate()) + ' ' + _pad2(d.getHours()) + ':' + _pad2(d.getMinutes())
}

/**
 * 定性模式披露（tier=degraded → 本报告不含量化测算）。
 *
 * 报告页页头有这张卡片，而 PDF 是唯一会离开小程序、被转发/打印/归档的形态，此前**完全没有**
 * 这个说明——客户拿到一份一个金额都没有的分析，纸面上没有任何解释。
 * ⚠️ 取 `family.readiness_tier`（reportAI 在**生成时刻**落库），不按当前数据重推：
 * 与"这份报告当时是怎么生成的"严格同源。缺字段（老报告）→ 空串，不猜。
 */
function _qualitativeNote(family) {
  return String((family && family.readiness_tier) || '') === 'degraded'
    ? '本报告为定性分析：生成时家庭年收入未填写，未做缺口金额、回本年限等量化测算。'
    : ''
}

/**
 * 分析时点 + 数据口径说明（审计 P2-1）。
 *
 * 封面只有"生成时间"（= 导出时刻），而深度分析一节是 families.last_* **AI 快照**，
 * 其余章节（成员/保单明细/经济状况）却是导出时的**实时数据**——同一个"生成时间 今天"
 * 会让读者以为分析也是今天的。故显式标注分析时刻，并点明两段数据的时点差。
 */
function _analysisNote(family) {
  const ts = family && family.last_analysis_at
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  return '分析生成于 ' + _fmtTs(d) + '；本文其余章节（成员 / 保单明细 / 经济状况）为导出时的实时数据'
}

// 回本判定已收敛到 _shared/cash-value-math.js（原 _findBreakeven 与 report-coverage、
// 前端 timeline-builder 三处逐字同构，各自演化）
// 保障节点（owner 全节点：保障期满/交费期满/现价回本，未来年份）→ [{ y, items:[{name, notes[]}] }]
function buildNodes(policies, members, cashValues) {
  const thisYear = new Date().getFullYear()
  const ageByName = {}
  for (const m of (members || [])) if (m && m.name) ageByName[m.name] = m.age || 0
  const events = []
  for (const p of policies) {
    const eff = p.contract_effective_date || p.effective_date || ''
    if (!eff) continue
    const startY = new Date(eff).getFullYear()
    if (isNaN(startY)) continue
    const name = p.insured_name || '--'
    const age = ageByName[name] || 0
    // 2026-09-25 审计：无被保人姓名时原实现拼出「产品名(--)」，客户看到的是疑似乱码的括号。
    // 无名字就干脆不拼括号（明细表里该列已如实显示「—」）。
    const key = (p.product_name || '未命名保单') + (p.insured_name ? '(' + name + ')' : '')
    const endY = _termYear(p.insurance_period, p.coverage_term, startY, age)
    if (endY && endY > thisYear) events.push({ y: endY, note: '保障期满', key: key })
    const payEnd = _termYear(p.payment_period, p.premium_term, startY, age, { singleYearEnd: true })
    if (payEnd && payEnd > thisYear) events.push({ y: payEnd, note: '交费期满', key: key })
    if (Array.isArray(cashValues)) {
      const cv = cashValues.find(c => c.policy_id === (p.id || p._id)) || null
      const beY = cv ? breakEvenYear(cv.cash_values, p.annual_premium, p.sum_assured) : null
      const beNatural = startY + (beY || 0) - 1
      if (beY && beY > 0 && beNatural > thisYear) events.push({ y: beNatural, note: '现价回本', key: key })
    }
  }
  events.sort((a, b) => a.y - b.y || a.key.localeCompare(b.key) || a.note.localeCompare(b.note))
  const seen = new Set()
  const merged = events.filter(e => { const k = e.y + '|' + e.key + '|' + e.note; if (seen.has(k)) return false; seen.add(k); return true })
  const byYear = {}
  for (const e of merged) { (byYear[e.y] = byYear[e.y] || []).push(e) }
  return Object.keys(byYear).map(Number).sort((a, b) => a - b).map(function (yr) {
    const map = {}
    for (const e of byYear[yr]) { (map[e.key] = map[e.key] || []).push(e.note) }
    const order = { '保障期满': 0, '交费期满': 1, '现价回本': 2 }
    return { y: yr, items: Object.keys(map).map(function (k) {
      const notes = map[k]
      notes.sort((a, b) => order[a] - order[b])
      return { name: k, notes: notes }
    }) }
  })
}
/**
 * 保障期间行（2026-10-13 报告结构 v2.0 ③）—— 页面是**时间条图**，PDF 是**同源数据的表格式**呈现。
 *
 * 为什么 PDF 不做图：pdfkit 画甘特条要自己算轴/条/分页，出错面大；而纸面读者要的是
 * "谁·保什么·保到什么时候"，表格同样回答。**数据口径必须同源**（见 gantt-builder.js）：
 *   - 到期年一律走 `_termYear`（文本 `insurance_period` 优先、`coverage_term` 数字兜底，
 *     终身哨兵由 `_shared/policy-status` 判定）—— 与前端 `timeline-builder.coverTermYear` 同规则；
 *   - 终身（无到期年）单独标注，不算"缺信息"；
 *   - **无生效日期 / 无保障期间** → 不入表，只在表下按条数说明（红线 3：不确定就标出来）。
 * ⛔ 与前端一致：**不做**空白期/重叠区/断档倒计时（缺 `reimbursement_type` 字段，做了就是猜）。
 *
 * ⚠️ 改动本函数时同步改 `miniprogram/utils/report/gantt-builder.js`（两份实现属已知的
 * "跨端双实现"，与 buildNodes 同性质；口径以 policy-status 契约为准，不各写一套哨兵比较）。
 */
function buildCoverageRows(policies, members) {
  const ageByName = {}
  for (const m of (members || [])) if (m && m.name) ageByName[m.name] = m.age || 0
  const rows = []
  let missStart = 0
  let missTerm = 0
  const thisYear = new Date().getFullYear()
  for (const p of (policies || [])) {
    const eff = p.contract_effective_date || p.effective_date || ''
    const startY = eff ? new Date(eff).getFullYear() : NaN
    if (!eff || isNaN(startY)) { missStart++; continue }
    const name = p.insured_name || '未指定被保人'
    const age = ageByName[name] || 0
    const lifetime = isLifetimeTerm(p.coverage_term) || /终身|长期/.test(String(p.insurance_period || ''))
    const endY = lifetime ? null : _termYear(p.insurance_period, p.coverage_term, startY, age)
    if (!lifetime && !endY) { missTerm++; continue }
    // 缴费期满年（与页面甘特图的"缴费期/保障期"两段语义同源）：趸交不单列，无缴费期信息则为 null
    const singlePay = isSinglePayTerm(p.premium_term)
    const payEndY = singlePay ? null : _termYear(p.payment_period, p.premium_term, startY, age)
    rows.push({
      name: name,
      product: p.product_name || '未命名保单',
      cat: p.insurance_category || '',
      sumAssured: p.sum_assured || 0,
      startY: startY,
      endY: endY,
      lifetime: lifetime,
      oneYear: isOneYearPolicy(p),
      singlePay: singlePay,
      payEndY: payEndY,
      // 到期时被保人年龄（回答"60 岁时还剩什么"）：当前年龄 + 距到期年数；年龄未知不显示
      endAge: (!lifetime && endY && age > 0) ? (age + (endY - thisYear)) : null,
      // 排序键（视图不消费）：同一被保人的保单相邻
      _startY: startY
    })
  }
  const order = {}
  ;(members || []).forEach(function (m, i) { if (m && m.name && order[m.name] === undefined) order[m.name] = i })
  rows.sort(function (a, b) {
    const oa = order[a.name] === undefined ? 999 : order[a.name]
    const ob = order[b.name] === undefined ? 999 : order[b.name]
    return oa - ob || a._startY - b._startY || String(a.product).localeCompare(String(b.product))
  })
  rows.forEach(function (r) { delete r._startY })
  const notes = []
  if (missStart) notes.push(missStart + ' 张保单缺少生效日期，未在表中显示')
  if (missTerm) notes.push(missTerm + ' 张保单未填写保障期间，未在表中显示')
  if (rows.some(function (r) { return r.oneYear })) notes.push('一年期短险每年需续保，表中期间表示当前保单年度')
  if (rows.some(function (r) { return r.lifetime })) notes.push('"终身"保单无固定到期日')
  return { rows: rows, notes: notes, thisYear: thisYear }
}

// 缴费月历：active 保单按生效月聚合（每年固定缴费月，与前端「未来12个月滚动」不同的静态存档口径）
//
// 2026-09-25 审计修正（三处客户可见的错账 + 一处该有却没有的合计）：
//   ① **趸交保单被排进「每年固定缴费月」** —— 趸交只交一次，排进来等于告诉客户每年都要交；
//      实测夹具里一张 3.5 万趸交终身寿险出现在 11 月，客户会据此虚增年度支出。
//   ② **缴费期已结束的保单没有剔除** —— 10 年缴、2015 年就交完的保单仍列在月历里。
//   ③ **月交/季交/半年交保单直接显示年保费** —— 该月支出被放大 12/4/2 倍。
//   ④ 单期金额与**月度合计**（buildPayMonths 早已算出 total，从未渲染）。
// 注：频次只按 payment_method 判定（该字段由录入侧给出）；无该字段时按年交处理，不猜。
const PAY_FREQ = { '月交': { n: 12, unit: '月' }, '季交': { n: 4, unit: '季' }, '半年交': { n: 2, unit: '半年' }, '年交': { n: 1, unit: '年' } }
function buildPayMonths(active) {
  const thisYear = new Date().getFullYear()
  const months = []
  for (let i = 0; i < 12; i++) {
    const items = []
    for (const p of active) {
      const dt = p.contract_effective_date || p.effective_date || ''
      const d = new Date(dt)
      if (isNaN(d.getTime()) || d.getMonth() !== i) continue
      // ① 趸交（含 premium_term=1/0 哨兵）无周期性缴费，不进月历
      if (isSinglePayTerm(p.premium_term) || String(p.payment_method || '') === '趸交') continue
      // ② 缴费期已过（如 10 年缴、2015 年交完）→ 不再有年度支出
      //    age 传 0：判不出（如「交至60岁」缺年龄）时返回 null，宁可保留也不误删
      const startY = d.getFullYear()
      const payEnd = _termYear(p.payment_period, p.premium_term, startY, 0, { singleYearEnd: true })
      if (payEnd && payEnd < thisYear) continue
      // ③ 按缴费频次折算单期金额（annual_premium 契约是「年缴保费（元）」）
      const freq = PAY_FREQ[String(p.payment_method || '').trim()] || PAY_FREQ['年交']
      const annual = p.annual_premium || 0
      const prem = freq.n > 1 ? Math.round(annual / freq.n) : annual
      items.push({ name: (p.product_name || '未命名保单') + (p.insured_name ? '(' + p.insured_name + ')' : ''), premium: prem, unit: freq.unit })
    }
    // ④ 同月内频次一致才给合计（混频相加会把「每月 100」和「每年 1 万」加成一个无意义数字）
    const units = new Set(items.map(function (x) { return x.unit }))
    const sameUnit = units.size === 1
    const total = sameUnit ? items.reduce(function (s, x) { return s + x.premium }, 0) : 0
    months.push({ month: i + 1, items: items, total: total, unit: sameUnit ? items[0].unit : '' })
  }
  return months
}

exports.main = async function (event) {
  const wxContext = cloud.getWXContext()
  const openid = (wxContext && (wxContext.OPENID || wxContext.openId)) || (event && event._authOpenid)
  const familyId = event && event.familyId
  if (!openid) return { code: 401, msg: '未登录' }
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  try {
    const db = cloud.database()
    const [family, policies, cashValues] = await Promise.all([
      loadFamilyView(db, openid, familyId),
      loadActivePolicies(db, familyId, openid),
      loadCashValues(db, familyId, openid)
    ])
    if (!family) return { code: 404, msg: '家庭不存在或无权访问' }
    const report = toReadReport(family)
    const fname = _displayName(family)
    const cloudPath = 'reports/' + openid + '/' + familyId + '_' + Date.now() + '.pdf'

    // 每次调用创建独立渲染会话（createLayout 闭包），避免实例热复用/并发下模块级状态互相污染。
    // ⚠️ 勿删 createLayout.begin 里的 `bufferPages: true`：页脚「第 x / y 页」与首页目录都靠
    // _finalize() 的 bufferedPageRange() + switchToPage() 回填（本文件 L102-123）。
    // （2026-09-22 全面审计：此处原有一句"bufferPages 未使用…移除"的注释与代码完全相反，
    //   照着它删掉会静默毁掉分页总数与目录——已删除该注释。）
    const L = createLayout()
    const doc = L.begin(fname)
    const activePolicies = policies.filter(p => p.status === 'active')
    const nodes = buildNodes(activePolicies, family.members || [], cashValues)
    const payMonths = buildPayMonths(activePolicies)
    const coverage = buildCoverageRows(activePolicies, family.members || [])
    L.build({ family, report, policies, nodes, payMonths, coverage })
    L.finalize()   // 页脚（含总页数）+ 首页目录回填 —— 必须在 doc.end() 之前
    doc.end()

    const buffer = await new Promise(function (resolve) {
      const chunks = []
      doc.on('data', c => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
    })

    const up = await cloud.uploadFile({ cloudPath: cloudPath, fileContent: buffer })
    // 2026-09-20（复核批次 B）：登记导出文件，供 cleanup 的 TTL 回收按 fileID 定位。
    // ⚠️ 为什么必须登记：wx-server-sdk 无列举云存储的 API（已核对类型定义），
    // 不记这一笔，`reports/<openid>/<familyId>_<ts>.pdf` 就是永久孤儿。
    // 登记失败不影响本次导出（文件已生成，登记只是回收索引）→ 内部已记日志，此处不中断。
    await recordReportFile(db, { openid, familyId, fileID: up.fileID, filePath: cloudPath })
    return { code: 200, data: { fileID: up.fileID } }
  } catch (e) {
    console.error('[reportPdf] 生成失败:', e && e.message, e && e.stack)
    return { code: 500, msg: 'PDF 生成失败，请稍后重试' }
  }
}

// 纯函数暴露给测试（2026-09-20 PDF 审计修复；同 reportAI 的 _pickClarifications 做法）
/**
 * 到期提醒（2026-09-22 产品决策：一年期产品默认是续保的，但要在文中给出提醒）。
 *
 * 为什么需要：`writePolicy` 入库一律写 `status='active'`（不判定），而读取侧 `ensureStatus`
 * 又把它当"手动设定"、永不重算 → 载明到期日已过的保单在纸面上永远显示"有效"。
 * 实测真实家庭 14 份保单全部 active，其中 6 份载明期限已过（最早 2020-09-27，含 4 份
 * 医疗险 400 万限额 + 1 份意外险 800 万）。**状态本身不改**（一年期按保证续保默认有效），
 * 只在此披露，把"是否已续保"交给代理人确认。
 *
 * @param {array} policies 应为已过滤的 active 保单
 * @returns {string} 空串 = 无需披露
 */
function _expiryNote(policies, now) {
  const alerts = listExpiredButActive(policies, now)
  if (!alerts.length) return ''
  const fmt = function (a) { return a.product_name + '·' + a.insured_name + '（载明至' + a.expiryText + '）' }
  const oneYear = alerts.filter(function (a) { return a.isOneYear })
  const other = alerts.filter(function (a) { return !a.isOneYear })
  const parts = []
  // 2026-09-25 PDF 审计（措辞准确性）：一年期那支原写「**按保证续保默认仍有效**」，而
  // isOneYear 判据只认「1 年 / 一年 / 日期区间约一年」，**判不出是否保证续保** ——
  // 意外险、部分医疗险并不保证续保，这句话对它们是不成立的承诺（客户可能据此以为仍在保）。
  // 改为把「通常按年续保」作为一般事实陈述、把是否保证续保交还条款，动作仍是「请确认续保」。
  // 产品决策本意（2026-09-22 D3：一年期默认续保 + 文中给提醒）不变。
  if (other.length) parts.push('下列非一年期产品载明保障期限已过，建议核实是否已续保或另投：' + other.map(fmt).join('、'))
  if (oneYear.length) parts.push('下列一年期产品载明保障期限已过，请确认是否已正常续保（一年期通常按年续保，是否保证续保以条款为准）：' + oneYear.map(fmt).join('、'))
  return '⚠️ ' + parts.join('　')
}

/**
 * 一年期短险单列（沿用 2026-09-04「防总保额虚高误导」决策；该决策原先只落到报告页摘要卡）。
 *
 * ⚠️ 口径别混：医疗险限额**是**保额的一部分（2026-09-22 决策，见 `docs/data-model-v2.md`「保额口径」）。
 * 这里单列的理由**不是**"限额不算保障"，而是**期限** —— 一年期产品每年需续保，把它当长期保障厚度
 * 会让读者误判。因此措辞用"每年需续保"，**不要**改成"不计入保额"。
 * @returns {string} 空串 = 无一年期短险
 */
function _shortNote(policies) {
  const shortWan = yuanToWan((policies || []).reduce(function (s, p) {
    return isOneYearPolicy(p) ? s + (p.sum_assured || 0) : s
  }, 0))
  if (!shortWan) return ''
  return '其中一年期短险 ' + shortWan + ' 万（每年需续保，不宜计入长期保障厚度）'
}

/**
 * 成员卡片数据（2026-10-24，PDF 用）
 *
 * 与页面 chapters.member_cards 同口径：固定五行、医疗只给份数、储蓄优先年领、
 * 失效单列且不计入合计。刻意**不引用** chapter-builder（那是前端模块），
 * 但口径必须一致 —— 由 tests/pdf-page-consistency 的"同一成员同一险种保额一致"断言钉住。
 */
function _memberCardData(members, act, allPolicies) {
  const CATS = [['意外险', '意外'], ['医疗险', '医疗'], ['重疾险', '重疾'], ['寿险', '寿险'], ['年金', '储蓄']]
  const catOf = (p) => canonCat((p && p.insurance_category) || '其他')
  // 本地格式化（这两个 helper 定义在 createLayout 闭包内，模块作用域拿不到）
  const money = (v) => {
    const n = Math.round(Number(v) || 0)
    if (!n) return ''
    return n >= 10000 ? (Math.round(n / 1000) / 10) + '万' : String(n) + '元'
  }
  const wan = (w) => (Math.round((Number(w) || 0) * 10) / 10) + '万'
  return members.map((m) => {
    const mine = (act || []).filter((p) => String(p.insured_name || '') === String(m.name || ''))
    const lines = []
    CATS.forEach(([cat, label]) => {
      const inCat = mine.filter((p) => catOf(p) === cat)
      if (!inCat.length) { lines.push(label + '　—'); return }
      const prem = inCat.reduce((s, p) => s + (Number(p.annual_premium) || 0), 0)
      const payout = inCat.reduce((s, p) => s + (Number(p.annuity_payout) || 0), 0)
      const sum = inCat.reduce((s, p) => s + (Number(p.sum_assured) || 0), 0)
      let sumText
      if (cat === '医疗险') sumText = inCat.length + ' 份'
      else if (cat === '年金' && payout > 0) sumText = '年领 ' + money(payout)
      else sumText = sum > 0 ? wan(sum / 10000) : '—'
      lines.push(label + '　' + sumText + '　' + (prem > 0 ? money(prem) : '—'))
    })
    const inact = (allPolicies || []).filter((p) => p.status !== 'deleted' && p.status !== 'active' &&
      String(p.insured_name || '') === String(m.name || ''))
    const premTotal = mine.reduce((s, p) => s + (Number(p.annual_premium) || 0), 0)
    return {
      title: (m.name || '待补姓名') + '（' + (m.role || '成员') + (m.age ? ' · ' + m.age + '岁' : '') + '）· 年缴 ' + money(premTotal),
      lines: lines,
      foot: '有效 ' + mine.length + ' 份' + (inact.length ? ' · 失效 ' + inact.length + ' 份' : '')
    }
  })
}


exports._termYear = _termYear
exports._displayName = _displayName
exports.DISCLAIMER = DISCLAIMER
exports._stripLeadHeading = _stripLeadHeading
exports._insuredCount = _insuredCount
exports.buildPayMonths = buildPayMonths
exports.buildCoverageRows = buildCoverageRows
exports.buildNodes = buildNodes
exports._shortNote = _shortNote
exports._qualitativeNote = _qualitativeNote
// 2026-10-24：暴露给单测（成员卡片是"纸面与页面同口径"的关键，必须可断言）
exports._memberCardData = _memberCardData
exports._analysisNote = _analysisNote
exports._mdPlain = mdPlain
exports._expiryNote = _expiryNote
