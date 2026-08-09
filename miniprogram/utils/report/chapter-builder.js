/**
 * chapter-builder.js — 报告章节编排（基础版报告 · 7 章单页长图）
 *
 * 设计稿验收（docs 基础版报告）：
 *   1. 家庭结构（成员树）
 *   2. 家庭财务（独立章，R2 从家庭结构拆出）
 *   3. 保障汇总（成员×险种矩阵 + 缺失提示）
 *   4. 缴费月历（12 格 + 峰值高亮）
 *   5. 缴费年历和关键节点（时间轴）
 *   6. 特别提醒（置信度告警，无告警时整章跳过）
 *   7. 附录：保单明细（按成员分组卡片）
 *
 * 免责声明为静态合规文案，不在此处渲染，由报告页底部小字承载
 * （见 pages/report/index.wxml .report-disclaimer）。
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
    var pid = p.id || p._id || ''
    var name = p.product_name || '未知名保单'
    // 告警携带保单引用（policy_id + 低置信字段），供 [核对] 定位编辑 Sheet
    if (p.need_review) { alerts.push({ name: name, issue: '保额需人工确认', policy_id: pid, field: 'sum_assured' }); continue }
    var conf = typeof p.confidence === 'number' ? p.confidence : 1
    if (conf < 0.95) { alerts.push({ name: name, issue: '识别置信度较低', policy_id: pid }); continue }
    var fc = p.field_confidence
    if (fc && typeof fc === 'object') {
      var lowField = null
      for (var k in fc) {
        if (typeof fc[k] === 'number' && fc[k] < 0.95 && !/^name$/i.test(k)) { lowField = k; break }
      }
      if (lowField) alerts.push({ name: name, issue: '部分字段置信度较低', policy_id: pid, field: lowField })
    }
  }
  return alerts
}

/**
 * 构建所有报告章节（基础版 7 章）
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
  // 去代际分层：成员卡片平铺流动布局（排序仍按角色分组序+中文名）
  ch.push({
    key: 'family_structure', title: '家庭结构', num: '1', edit: 'family',
    customBlocks: [createBlock('family_tree', { nodes: nodes })]
  })

  // ======== ② 家庭财务（独立章，R2 从家庭结构拆出） ========
  // edit:'financials' → 章标题行渲染 [编辑]（onChapterEdit mode='financials'）
  ch.push({
    key: 'family_finance', title: '家庭财务', num: '2', edit: 'financials',
    customBlocks: [createBlock('finance', {
      income: totalIncome,
      debt: Math.round(debt * 100) / 100,
      expense: Math.round(expense * 100) / 100
    })]
  })

  // ======== ③ 保障汇总 ========
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
    key: 'coverage_summary', title: '保障汇总', num: '3',
    unit: '单位：万元',
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
    key: 'premium_calendar', title: '缴费月历', num: '4',
    unit: '单位：元',
    customBlocks: [createBlock('calendar', { items: months })],
    // 下方提示：无列表垂直排列（年保费 → 峰值月），markdown-render 以 <br> 换行
    content: '年总保费 ' + annualPremiumW + '万（占收入 ' + premiumRatio + '%）' + (peakMonth ? '<br>💡 ' + peakMonth + '缴费压力最大，请提前安排资金' : '')
  })

  // ======== ④ 缴费年历和关键节点 ========
  // 设计稿决策：仅展示缴费期满/保障期满（排除每年缴费提醒 payment）
  // 现价回本节点依赖 family.cashValues（getFamily 并行返回，见 dataQuery/family-detail.js）
  var timeline = buildTimeline(policies, members, family.cashValues).filter(function(e) { return e.type !== 'payment' })
  var timelineItems = timeline.map(function(e) {
    var item = { y: e.y, type: e.type, soon: e.soon, label: e.label }
    if (e.type === 'expiry') {
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
    key: 'premium_timeline', title: '保障节点', num: '5',
    customBlocks: [createBlock('timeline', { items: timelineItems })]
  })

  // ======== ⑥ 特别提醒（置信度告警） ========
  // 免责声明已移至页面底部（index.wxml .report-disclaimer），无告警时整章跳过
  var alerts = buildConfidenceAlerts(active)
  if (alerts.length > 0) {
    ch.push({
      key: 'risk_alerts', title: '特别提醒', num: '6',
      customBlocks: [createBlock('risk_alerts', { items: alerts })]
    })
  }

  // ======== ⑦ 附录：保单明细 ========
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
  // 附录不作为编号章节（无 num），仅保留标题 + 保单卡片
  ch.push({
    key: 'appendix_policies', title: '附录：保单明细',
    customBlocks: [createBlock('policy_cards', { groups: groups })],
    // 有效保单数提升至标题右侧（unit 字段渲染于标题旁，原 note 在章底部）
    unit: '有效保单 ' + policyCount + ' 份'
  })

  return ch
}

module.exports = { buildChapters, buildConfidenceAlerts }
