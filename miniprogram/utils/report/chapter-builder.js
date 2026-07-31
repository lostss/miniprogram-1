/**
 * chapter-builder.js — 报告章节编排（基础版报告 · 6 章单页长图）
 *
 * 设计稿验收（docs 基础版报告）：
 *   1. 家庭结构（成员树 + 家庭财务）
 *   2. 保障汇总（成员×险种矩阵 + 缺失提示）
 *   3. 缴费月历（12 格 + 峰值高亮）
 *   4. 缴费年历和关键节点（时间轴）
 *   5. 风险提示（置信度告警 + 免责声明）
 *   6. 附录：保单明细（按成员分组卡片）
 *
 * 依赖 gap-engine / timeline-builder / data-normalizer，
 * 将家庭数据组装为章节卡片数组。AI 分析章节（规划/建议等）由扩展版承载。
 */

var { normalizeFamilyData } = require('./data-normalizer')
var { buildGapMatrix, buildCoverageMatrix } = require('./gap-engine')
var { buildTimeline } = require('./timeline-builder')
var { canonCat } = require('../thresholds')
var createBlock = require('../custom-blocks').create

// 险种短名：卡片展示用（重疾险 → 重疾；寿险保留全称，'寿' 不可读）
function _shortCat(cat) {
  var s = String(cat || '')
  if (s.length > 1 && s.charAt(s.length - 1) === '险') {
    var t = s.slice(0, -1)
    if (t.length >= 2) return t
  }
  return s
}

// 金额展示：≥1万 → 'X万'（去尾 .0），否则 'X元'（WXML 不支持拼接，预处理）
function _fmtAmount(v) {
  var n = Number(v) || 0
  if (n >= 10000) {
    var wan = n / 10000
    var x = Math.round(wan * 100) / 100
    return (x === Math.floor(x) ? String(x) : String(x)) + '万'
  }
  return String(Math.round(n)) + '元'
}

// 成员角色分组排序：长辈 → 父母 → 本人/配偶 → 子女
function _roleGroup(role) {
  var r = role || ''
  if (/爷爷|奶奶|外公|外婆/.test(r)) return 0
  if (/父亲|母亲|父母|爸爸|妈妈/.test(r)) return 1
  if (/本人|配偶|丈夫|妻子/.test(r)) return 2
  return 3
}

/**
 * 置信度告警（设计稿第 5 章）：need_review 或低置信度保单
 */
function buildConfidenceAlerts(policies) {
  var alerts = []
  for (var i = 0; i < (policies || []).length; i++) {
    var p = policies[i]
    var name = p.product_name || '未知名保单'
    if (p.need_review) { alerts.push({ name: name, issue: '保额需人工确认' }); continue }
    var conf = typeof p.confidence === 'number' ? p.confidence : 1
    if (conf < 0.95) { alerts.push({ name: name, issue: '识别置信度较低' }); continue }
    var fc = p.field_confidence
    if (fc && typeof fc === 'object') {
      var lowField = null
      for (var k in fc) {
        if (typeof fc[k] === 'number' && fc[k] < 0.95 && !/^name$/i.test(k)) { lowField = k; break }
      }
      if (lowField) alerts.push({ name: name, issue: '部分字段置信度较低' })
    }
  }
  return alerts
}

/**
 * 构建所有报告章节（基础版 6 章）
 */
function buildChapters(family, report) {
  var norm = normalizeFamilyData(family)
  var members = norm.members
  var policies = norm.policies
  var active = norm.active
  var debt = norm.debt
  var totalIncome = norm.totalIncome
  var annualPremium = norm.annualPremium
  var annualPremiumW = norm.annualPremiumW
  var premiumRatio = norm.premiumRatio
  var totalCoverage = norm.totalCoverage
  var policyCount = norm.policyCount
  var expense = norm.expense

  var matrix = buildCoverageMatrix(members, active)
  var gaps = buildGapMatrix(require('./gap-engine').buildGaps(family), members)
  var ch = []

  // ======== ① 家庭结构 ========
  var sortedMembers = [].concat(members).sort(function(a, b) {
    return (_roleGroup(a.role) - _roleGroup(b.role)) || String(a.name).localeCompare(String(b.name), 'zh')
  })
  var nodes = sortedMembers.map(function(m) {
    var role = m.role || ''
    return { name: m.name, role: role, age: m.age || '', member_id: m.member_id || '', display: m.age ? (role + '(' + m.age + ')') : role }
  })
  ch.push({
    key: 'family_structure', title: '家庭结构', num: '1', edit: 'family',
    customBlocks: [createBlock('family_tree', {
      nodes: nodes,
      finance: {
        income: totalIncome,
        debt: Math.round(debt * 100) / 100,
        expense: Math.round(expense * 100) / 100
      }
    })]
  })

  // ======== ② 保障汇总 ========
  var missingLines = (function() {
    var lines = []
    var gapList = require('./gap-engine').buildGaps(family)
    for (var i = 0; i < members.length; i++) {
      var m = members[i]
      var missing = gapList.filter(function(g) { return g.member === m.name && g.gap > 0 }).map(function(g) { return _shortCat(g.category) })
      if (missing.length > 0) lines.push(m.name + '缺少' + missing.join('、'))
    }
    return lines
  })()
  ch.push({
    key: 'coverage_summary', title: '保障汇总', num: '2',
    pre: missingLines.length > 0 ? ('⚠️ ' + missingLines.join('\n⚠️ ')) : '',
    customBlocks: [createBlock('panorama', { heads: matrix.heads, cats: matrix.cats, rows: matrix.rows })]
  })

  // ======== ③ 缴费月历 ========
  var months = (function() {
    var arr = []
    for (var i = 0; i < 12; i++) {
      var t = active.reduce(function(s, p) {
        var mo = -1
        var dt = p.contract_effective_date || p.effective_date || ''
        if (dt) { var d = new Date(dt); if (!isNaN(d.getTime())) mo = d.getMonth() }
        return mo === i ? s + (p.annual_premium || 0) : s
      }, 0)
      arr.push({ m: i + 1, v: t > 0 ? t + '元' : '-', h: t > 0 ? 1 : 0 })
    }
    var max = Math.max.apply(null, arr.map(function(x) { return x.h === 1 ? x.v : 0 }).map(function(v) { return parseInt(v, 10) || 0 }))
    if (max > 0) {
      for (var j = 0; j < arr.length; j++) {
        if ((parseInt(arr[j].v, 10) || 0) === max) arr[j].h = 2
      }
    }
    return arr
  })()
  var peakMonth = months.filter(function(x) { return x.h === 2 }).map(function(x) { return x.m + '月' }).join('、')
  ch.push({
    key: 'premium_calendar', title: '缴费月历', num: '3',
    pre: '单位：元 · 年总保费 ' + annualPremiumW + '万（占收入 ' + premiumRatio + '%）',
    customBlocks: [createBlock('calendar', { items: months })],
    content: peakMonth ? '💡 ' + peakMonth + '缴费压力最大，请提前安排资金' : ''
  })

  // ======== ④ 缴费年历和关键节点 ========
  var timeline = buildTimeline(policies, members)
  var timelineItems = timeline.map(function(e) {
    var item = { y: e.y, type: e.type, soon: e.soon, label: e.label }
    if (e.type === 'payment') {
      item.date = e.y + '-' + String((e.m || 0) + 1).padStart(2, '0') + '-' + String(e.day || 1).padStart(2, '0')
      item.name = (e.label || '').replace(/（.+?）缴费.*$/, '')
      item.premium = e.premium
      item.note = '续保'
    } else if (e.type === 'expiry') {
      item.date = e.y + '年'
      item.name = (e.label || '').replace(/（.+?）到期.*$/, '')
      item.note = '需关注续保或替换'
    } else {
      item.date = e.y + '年'
      item.name = (e.label || '').replace(/（.+?）缴完.*$/, '')
      item.note = '缴费期满'
    }
    return item
  })
  ch.push({
    key: 'premium_timeline', title: '缴费年历和关键节点', num: '4',
    pre: '年总保费：' + (annualPremium > 0 ? annualPremium.toLocaleString() + '元' : '--'),
    customBlocks: [createBlock('timeline', { items: timelineItems })]
  })

  // ======== ⑤ 风险提示 ========
  var alerts = buildConfidenceAlerts(active)
  ch.push({
    key: 'risk_alerts', title: '风险提示', num: '5',
    customBlocks: [createBlock('risk_alerts', {
      items: alerts,
      disclaimer: String((report && report.disclaimer) || '') || '本报告基于OCR识别结果自动生成，数据仅供参考，不构成投保建议。请以保单原件为准。'
    })]
  })

  // ======== ⑥ 附录：保单明细 ========
  var groups = []
  var byMember = {}
  var sorted = [].concat(active).sort(function(a, b) {
    return String(a.product_name || '').localeCompare(String(b.product_name || ''), 'zh')
  })
  for (var i = 0; i < sorted.length; i++) {
    var p = sorted[i]
    var n = p.insured_name || '未归属'
    if (!byMember[n]) byMember[n] = []
    byMember[n].push({
      policy_id: p.id || p._id || '',
      product_name: p.product_name || '未知产品',
      category: _shortCat(canonCat(p.insurance_category || '其他')),
      sum_assured: p.sum_assured || 0,
      annual_premium: p.annual_premium || 0,
      effective_date: (p.contract_effective_date || p.effective_date || '').substring(0, 10),
      sum_display: _fmtAmount(p.sum_assured || 0),
      premium_display: _fmtAmount(p.annual_premium || 0)
    })
  }
  Object.keys(byMember).forEach(function(n) { groups.push({ name: n, policies: byMember[n] }) })
  ch.push({
    key: 'appendix_policies', title: '附录：保单明细', num: '6',
    customBlocks: [createBlock('policy_cards', { groups: groups })],
    note: '共 ' + policyCount + ' 份有效保单'
  })

  return ch
}

module.exports = { buildChapters, buildConfidenceAlerts }
