/**
 * reportPdf — 报告 PDF 导出（服务端 pdfkit）
 * 输入 {familyId}；输出 {fileID}。owner 鉴权由 familyView/policy-read 的 _openid 过滤保证。
 * 金额口径：DB 存元 → yuanToWan 转万展示。数据组装对齐 dataQuery/getFamilyDetail。
 * v1 排版：家庭概况 → 深度分析(markdown 纯文本化) → 家庭成员 → 保单明细 → 经济状况 → 免责。
 */
const fs = require('fs')
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

const FONT_FILE = path.join(__dirname, 'fonts', 'NotoSansSC-Regular.otf')
const DISCLAIMER = '本报告基于OCR识别结果自动生成，数据仅供参考，不构成投保建议。请以保单原件为准。'

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
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

// ---------- 布局 ----------
// 审计（MEDIUM）：doc/y/_pageNo 原为模块级可变状态，云函数实例热复用 / 并发调用会互相污染渲染状态。
// 已收进 createLayout() 闭包：每次 main 调用通过 createLayout() 获得独立状态实例，互不影响。
const PAGE_W = 595.28
const PAGE_H = 841.89
const M = 52
const W = PAGE_W - M * 2
const TOP_Y = 60
function createLayout() {
  let doc = null
  let y = 0
  let _pageNo = 1

function _cn(size) { doc.font('cn').fontSize(size) }
// 恒纵向 A4 + margin:0。
// 必须显式传 margin:0：PDFDocument 构造时 margin:0 只作用于第一页，
// doc.addPage 若省略 margin 会回退到 PDFKit 默认 72pt，导致新页 maxY=841.89-72=769.89。
// _foot 在 y=797.89 画页脚时 797.89 > 769.89，触发 LineWrapper 自动分页，
// 页脚被挤到下一页 → 偶数页空白 + 下一页顶部出现页脚（"上下颠倒"视觉）。
function _addPage() {
  doc.addPage({ size: 'A4', margin: 0 })
  _pageNo++
  _foot()
}
const _BUILD = 'r4' // 部署验证标记：每次改代码递增；页脚可见此标记即为新代码生成
function _foot() {
  doc.save(); _cn(8); doc.fillColor('#999999')
  doc.text('保小秘生成 · 家庭保障检视报告 · 第 ' + _pageNo + ' 页 · ' + _BUILD, M, doc.page.height - 44, { width: W, align: 'right', lineBreak: false })
  doc.restore()
  // 重置 doc.y：_foot 在 y≈797 画页脚后，doc.y 停留在页脚位置，会污染后续 doc.text 的内部坐标判断
  doc.y = TOP_Y
}
function _ensure(h) {
  if (y + h > doc.page.height - 56) { _addPage(); y = TOP_Y }
}
function _title(t) { _ensure(30); _cn(20); doc.fillColor('#1a1a1a'); doc.text(t, M, y, { width: W }); y = doc.y + 8 }
function _sub(t) { _cn(9); doc.fillColor('#888888'); doc.text(t, M, y, { width: W }); y = doc.y + 12 }
function _rule() { _ensure(6); doc.strokeColor('#e0e0e0').lineWidth(0.8).moveTo(M, y).lineTo(PAGE_W - M, y).stroke(); y += 14 }
function _sec(t) {
  _ensure(30); _cn(13); doc.fillColor('#8a6d2f')
  doc.text(t, M, y, { width: W }); y = doc.y + 3
  doc.strokeColor('#d8c59a').lineWidth(1).moveTo(M, y).lineTo(PAGE_W - M, y).stroke(); y += 10
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
  const st = p.status || ''
  if (st === 'active') return '有效'
  if (st === 'expired') return '已失效'
  if (st === 'cancelled') return '已取消'
  return '待确认'
}

// ---------- 主流程 ----------
function buildPdf(ctx) {
  const family = ctx.family
  const report = ctx.report
  const members = (family.members || []).filter(m => m.status !== 'deleted')
  const policies = ctx.policies || []
  const fs = family.financial_snapshot || {}
  const name = family.family_name || family.name || '家庭'
  const now = new Date()
  const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
  const act = policies.filter(p => p.status === 'active')
  const premiumW = yuanToWan(act.reduce((s, p) => s + (p.annual_premium || 0), 0))
  const coverageW = yuanToWan(act.reduce((s, p) => s + (p.sum_assured || 0), 0))
  const income = fs.income || 0
  const debtAmt = (fs.debt && fs.debt.amount) || 0
  const expense = fs.fixed_expense || 0
  // 兜底：financial_snapshot 未填但成员有个人收入（万）时，经济状况仍展示成员合计
  const memberIncome = members.reduce(function (s, m) { return s + (m.income || 0) }, 0)

  // 标题
  _title(name + ' · 家庭保障检视报告')
  _sub('生成时间：' + dateStr + '　|　家庭成员 ' + members.length + ' 人　|　保单 ' + policies.length + ' 份（有效 ' + act.length + '）')
  _rule()

  // 保障摘要
  _sec('保障摘要')
  _cn(10)
  const colW = W / 3
  const sums = [['年保费(万)', String(premiumW || 0)], ['总保额(万)', String(coverageW || 0)], ['保障人数', String(new Set(act.map(p => p.insured_name || '')).size)]]
  let cx = M
  for (const it of sums) {
    _cn(9); doc.fillColor('#888888'); doc.text(it[0], cx, y, { width: colW - 8, lineBreak: false })
    _cn(15); doc.fillColor('#1a1a1a'); doc.text(String(it[1]), cx, y + 12, { width: colW - 8, lineBreak: false })
    cx += colW
  }
  y += 40
  // premiumW/income 均为万口径，占比 = 保费万 / 收入万 × 100
  if (income > 0) _para('保费占家庭年收入约 ' + (premiumW / income * 100).toFixed(1) + '%', 9, { color: '#777777' })
  _rule()

  // 深度分析（AI 解读）
  const deep = report && (report.review || report.analysis || report.plan || report.suggestions || (report.core_insights && report.core_insights.length))
  if (deep) {
    _sec('深度分析（AI 解读）')
    if (report.core_insights && report.core_insights.length) {
      _para('核心洞察', 11, { color: '#8a6d2f' })
      for (const ins of report.core_insights) _para('• ' + ins, 10, { indent: 4 })
      y += 2
    }
    const blocks = [['现有保障点评', report.review], ['保障缺口分析', report.analysis], ['配置建议', report.plan], ['行动清单', report.suggestions]]
    for (const b of blocks) {
      const txt = mdPlain(b[1])
      if (!txt) continue
      _cn(11); doc.fillColor('#444444'); doc.text(b[0], M, y, { width: W }); y = doc.y + 2
      _block(txt, 10, { color: '#333333' })
    }
    if (report.disclaimer) _para(mdPlain(report.disclaimer), 8, { color: '#999999' })
    _rule()
  }

  // 家庭成员
  _sec('家庭成员')
  if (!members.length) {
    _para('尚未录入家庭成员', 10, { color: '#999999' })
  } else {
    for (const m of members) {
      const age = m.age || (m.birth_date ? calcAge(m.birth_date) : '')
      const line = (m.name || '未命名') + '（' + (m.role || '成员') + '）' +
        (age ? ' · ' + age + '岁' : ' · 年龄待补') +
        (m.occupation ? ' · ' + m.occupation : '') +
        (m.health ? ' · 健康：' + m.health : '')
      _para(line, 10)
    }
  }
  _rule()

  // 保单明细（纵向主行 + 副行附加信息：保单号/公司/保险期间全保留）
  _sec('保单明细')
  if (!policies.length) {
    _para('暂无保单记录', 10, { color: '#999999' })
  } else {
    _para('金额单位：不足 1 万按元显示；每行保单下方为 公司/保险期间/缴费期/生效日', 8, { color: '#999999', gap: 4 })
    _policyTable(policies)
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
  _sec('缴费月历（每年固定缴费月）')
  const months = ctx.payMonths || []
  const filledMonths = months.filter(m => m.items.length)
  if (!filledMonths.length) {
    _para('暂无年度缴费安排', 10, { color: '#999999' })
  } else {
    for (const m of months) {
      if (!m.items.length) continue
      _cn(10); doc.fillColor('#1a1a1a'); doc.text(String(m.month) + '月', M, y, { width: 42, lineBreak: false })
      const t = m.items.map(function (it) { return it.name + ' ' + _fmtMoney(it.premium) }).join('　')
      _cn(9); doc.fillColor('#555555')
      const tx = M + 48
      const tw = W - 48
      // r4：heightOfString 与 doc.text 的 lineGap 保持一致，防低估触发 pdfkit 自动分页
      _ensure(doc.heightOfString(t, { width: tw, lineGap: 2 }) + 10)
      doc.text(t, tx, y, { width: tw, lineGap: 2 })
      y = doc.y + 4
    }
  }
  _rule()

  // 经济状况（financial_snapshot 万口径直显；收入缺省时用成员收入合计兜底）
  _sec('经济状况')
  const showIncome = income > 0 ? income : memberIncome
  if (!showIncome && !debtAmt && !expense) {
    _para('家庭财务信息待补全', 10, { color: '#999999' })
  } else {
    if (showIncome > 0) _para('家庭年收入：' + _wanStr(showIncome) + (income > 0 ? '' : '（成员收入合计）'), 10)
    if (debtAmt > 0) {
      const dt = (fs.debt && fs.debt.type) ? '（' + fs.debt.type + '）' : ''
      _para('总负债：' + _wanStr(debtAmt) + dt, 10)
    }
    if (expense > 0) _para('固定支出：' + _wanStr(expense), 10)
  }
  _rule()

  // 免责
  _ensure(20)
  _para(DISCLAIMER, 8, { color: '#999999' })
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
// 缴费期短文本（对齐前端 chapter-builder _payTermText）
function _payTermShort(p) {
  if (/^(1|一)年/.test(String(p.insurance_period || '').trim())) return '一次性'
  if (p.payment_period) return String(p.payment_period)
  const pt = p.premium_term
  if (pt === 1 || pt === '1' || pt === 0 || pt === '0') return '趸交'
  if (pt) return '缴' + String(pt) + '年'
  return '—'
}
// 保单明细表（纵向）：主行=产品/保单号/被保人/保额/年缴/状态，副行=公司/保险期间/缴费期/生效日
// 全纵向无方向切换；跨页自动重复表头；主行/副行成组不拆行
function _policyTable(policies) {
  const fs = 8.5
  const rowH = 20
  const subH = 14
  const x0 = M
  const heads = ['产品', '保单号', '被保人', '保额', '年缴', '状态']
  const widths = [170, 90, 52, 52, 48, 42]
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
    if (cy + rowH + subH > doc.page.height - 52) { _addPage(); cy = TOP_Y; headRow() }
    const eff = (p.contract_effective_date || p.effective_date || '').substring(0, 10) || '—'
    const cells = [
      String(p.product_name || p.policy_name || '未命名保单'),
      p.policy_number || '—',
      p.insured_name || '—',
      _amtCell(p.sum_assured),
      _amtCell(p.annual_premium),
      _statusTxt(p)
    ]
    _cn(fs); doc.fillColor('#333333')
    for (let i = 0; i < cells.length; i++) {
      doc.text(cells[i], x0 + xs[i] + 3, cy + 6, { width: widths[i] - 6, lineBreak: false, ellipsis: true })
    }
    const bits = []
    if (p.insurer) bits.push('公司：' + p.insurer)
    if (p.insurance_period) bits.push('保险期间：' + p.insurance_period)
    const pt = _payTermShort(p)
    if (pt !== '—') bits.push('缴费期：' + pt)
    bits.push('生效日：' + eff)
    cy += rowH
    _cn(7.5); doc.fillColor('#999999')
    doc.text(bits.join('　'), x0 + 3, cy + 2, { width: W - 6, lineBreak: false, ellipsis: true })
    cy += subH + 3
    doc.strokeColor('#efefef').lineWidth(0.5).moveTo(x0, cy - subH).lineTo(x0 + W, cy - subH).stroke()
  }
  y = cy + 8
}

  // 会话 API：begin(fname) 新建 PDF 文档并重置页码/纵坐标；build(ctx) 执行完整排版
  return {
    begin: function (fname) {
      doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: fname + '保障检视报告' } })
      _pageNo = 1
      y = 60
      doc.registerFont('cn', FONT_FILE)
      _foot()
      return doc
    },
    build: buildPdf
  }
}

// ======================== 保障节点 / 缴费月历（复刻前端 timeline-builder / chapter-builder 口径） ========================
// 双字段兼容：OCR 文本（insurance_period/payment_period）优先，兜底对话数字（coverage_term/premium_term）
function _termYear(textPeriod, numTerm, startY, age, opts) {
  if (textPeriod) {
    const r = parseExpiry(textPeriod, String(startY) + '-01-01', age || 0)
    if (/终身|长期/.test(String(textPeriod || ''))) return null
    return r.year
  }
  const t = numTerm
  if (t === null || t === undefined || t === '' || t === 0 || t === '0') return null
  const n = parseInt(String(t), 10)
  if (!isNaN(n) && n > 0) {
    if (opts && opts.singleYearEnd === true && n === 1) return null // 趸交/终身缴费无"缴完"节点
    return startY + n
  }
  return null
}
function _findBreakeven(p, cv) {
  if (!p || !cv || !cv.cash_values || !cv.cash_values.length) return null
  const scale = Math.max(1, Math.round(yuanToWan(p.sum_assured || 0)))
  const premium = p.annual_premium || 0
  if (scale <= 0 || premium <= 0) return null
  for (const row of cv.cash_values) if (row.v * scale >= premium * row.y) return row.y
  return null
}
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
    const key = (p.product_name || '未命名保单') + '(' + name + ')'
    const endY = _termYear(p.insurance_period, p.coverage_term, startY, age)
    if (endY && endY > thisYear) events.push({ y: endY, note: '保障期满', key: key })
    const payEnd = _termYear(p.payment_period, p.premium_term, startY, age, { singleYearEnd: true })
    if (payEnd && payEnd > thisYear) events.push({ y: payEnd, note: '交费期满', key: key })
    if (Array.isArray(cashValues)) {
      const cv = cashValues.find(c => c.policy_id === (p.id || p._id)) || null
      const beY = cv ? _findBreakeven(p, cv) : null
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
// 缴费月历：active 保单按生效月聚合（每年固定缴费月，与前端"未来12个月滚动"不同的静态存档口径）
function buildPayMonths(active) {
  const months = []
  for (let i = 0; i < 12; i++) {
    const items = []
    let total = 0
    for (const p of active) {
      const dt = p.contract_effective_date || p.effective_date || ''
      const d = new Date(dt)
      if (isNaN(d.getTime()) || d.getMonth() !== i) continue
      const prem = p.annual_premium || 0
      items.push({ name: (p.product_name || '未命名保单') + (p.insured_name ? '(' + p.insured_name + ')' : ''), premium: prem })
      total += prem
    }
    months.push({ month: i + 1, items: items, total: total })
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
    const fname = family.family_name || family.name || '家庭'
    const cloudPath = 'reports/' + openid + '/' + familyId + '_' + Date.now() + '.pdf'

    // bufferPages 未使用（无 switchToPage 回填页码），移除以避免与 addPage 的自动分页逻辑冲突
    // 每次调用创建独立渲染会话（createLayout 闭包），避免实例热复用/并发下模块级状态互相污染
    const L = createLayout()
    const doc = L.begin(fname)
    const activePolicies = policies.filter(p => p.status === 'active')
    const nodes = buildNodes(activePolicies, family.members || [], cashValues)
    const payMonths = buildPayMonths(activePolicies)
    L.build({ family, report, policies, nodes, payMonths })
    doc.end()

    const buffer = await new Promise(function (resolve) {
      const chunks = []
      doc.on('data', c => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
    })

    const up = await cloud.uploadFile({ cloudPath: cloudPath, fileContent: buffer })
    return { code: 200, data: { fileID: up.fileID } }
  } catch (e) {
    console.error('[reportPdf] 生成失败:', e && e.message, e && e.stack)
    return { code: 500, msg: 'PDF 生成失败，请稍后重试' }
  }
}
