/**
 * gap-engine.js — 保障缺口计算引擎
 *
 * 从 report-builder.js 抽取：buildGaps, buildGapMatrix + 阈值辅助函数。
 * 纯计算模块，不依赖 AI，可独立单测。
 */

// 阈值单一事实源
var _thresholds = null
var _formatThresholdAppendix = null
var _canonCat = null
function _lazyLoad() {
  if (!_thresholds) {
    var t = require('../thresholds')
    _thresholds = t.THRESHOLDS
    _canonCat = t.canonCat
    _formatThresholdAppendix = t.formatThresholdAppendix
  }
}

var _DEFAULT_THRESHOLD = null
function _thresholdFor(cat) {
  _lazyLoad()
  if (!_DEFAULT_THRESHOLD) _DEFAULT_THRESHOLD = require('../thresholds').DEFAULT_THRESHOLD
  return _thresholds[cat] || _DEFAULT_THRESHOLD
}
function _referenceFor(cat, debt, income) {
  var r = _thresholdFor(cat).reference
  return typeof r === 'function' ? r(debt, income) : r
}

// 角色→必需险种（最小版需求模型）
function _neededCats(role) {
  var r = role || ''
  if (r === '子女' || r === '父母') return ['医疗险', '意外险', '重疾险']
  if (r === '本人' || r === '配偶') return ['重疾险', '医疗险', '意外险', '寿险']
  return ['医疗险', '意外险']
}

function _gapPriority(cat, isPillar) {
  if (isPillar && (cat === '寿险' || cat === '重疾险' || cat === '意外险')) return 'high'
  if (isPillar) return 'medium'
  if (cat === '重疾险' || cat === '医疗险') return 'medium'
  return 'low'
}

// 缺口可信度
function _gapReliability(cat, hasIncome, hasDebt) {
  if (cat === '重疾险' || cat === '医疗险') return 'estimated'
  if (cat === '寿险' || cat === '意外险') {
    if (!hasIncome) return 'blocked'
    return hasDebt ? 'confirmed' : 'estimated'
  }
  return 'confirmed'
}

function _basisText(cat, exist, debt, income, rel) {
  if (cat === '重疾险') return '参考50万（治疗费+收入损失），现有' + exist + '万'
  if (cat === '医疗险') return '建议百万医疗，现有' + (exist > 0 ? exist + '万' : '无')
  if (cat === '寿险') {
    if (rel === 'blocked') return '寿险需求=负债+5×年收入，年收入缺失无法计算'
    if (rel === 'estimated') return '寿险需求≈5×年收入' + income + '万（负债缺失暂按0），现有' + exist + '万'
    return '寿险需求=负债' + debt + '万+5×年收入' + income + '万，现有' + exist + '万'
  }
  if (cat === '意外险') {
    if (rel === 'blocked') return '意外险需求=5×年收入或负债取高，年收入缺失无法计算'
    if (rel === 'estimated') return '意外险需求≈5×年收入' + income + '万（负债缺失暂按0），现有' + exist + '万'
    return '意外险需求=max(5×年收入' + income + '万, 负债' + debt + '万)，现有' + exist + '万'
  }
  return '参考' + _referenceFor(cat, debt, income) + '万，现有' + exist + '万'
}

function _completeHint(cat, hasIncome, hasDebt) {
  if (cat === '重疾险' || cat === '医疗险') return ''
  if (!hasIncome) return '补全年收入 → 解锁' + cat + '缺口计算'
  if (!hasDebt) return '补全负债 → ' + cat + '需求计入负债更精确'
  return ''
}

/**
 * 构建结构化保障缺口（前端纯计算，不消耗 AI）
 */
function buildGaps(family) {
  _lazyLoad()
  var policies = (family && family.policies) || []
  var members = (family && family.members) || []
  var active = policies.filter(function(p) { return p.status === 'active' })
  var debt = (family.debt && family.debt.amount) || 0
  var hasDebt = debt > 0
  var pillar = members.find(function(m) { return /本人|经济支柱/.test(m.role || '') }) || members[0] || null
  var hasKids = members.some(function(m) { return (m.role || '') === '子女' })
  var _memberIdToName = {}
  for (var i = 0; i < members.length; i++) {
    var m = members[i]
    if (m.member_id) _memberIdToName[m.member_id] = m.name
  }

  var gaps = []
  for (var j = 0; j < members.length; j++) {
    var mb = members[j]
    var isPillar = !!(pillar && mb.name === pillar.name)
    var familyIncome = parseInt(family.family_income) || 0
    var rawMemIncome = mb.income || 0
    var hasMemIncome = rawMemIncome > 0 || familyIncome > 0
    var isEstimatedIncome = rawMemIncome === 0 && familyIncome > 0
    var memIncome = rawMemIncome > 0 ? rawMemIncome : Math.round(familyIncome / Math.max(1, members.length))
    var existing = {}
    for (var k = 0; k < active.length; k++) {
      var p = active[k]
      var n = (p.member_id && _memberIdToName[p.member_id]) || p.insured_name
      if (n === mb.name) {
        var c = _canonCat(p.insurance_category || '其他')
        existing[c] = (existing[c] || 0) + ((p.sum_assured || 0) / 10000)
      }
    }
    for (var l = 0; l < _neededCats(mb.role).length; l++) {
      var cat = _neededCats(mb.role)[l]
      var exist = existing[cat] || 0
      var relBase = _gapReliability(cat, hasMemIncome, hasDebt)
      var rel = isEstimatedIncome && relBase === 'confirmed' ? 'estimated' : relBase
      var priority = _gapPriority(cat, isPillar)
      var priorityLabel = priority === 'high' ? '高' : (priority === 'medium' ? '中' : '低')
      var reliabilityLabel = rel === 'confirmed' ? '✅ 已确认' : (rel === 'estimated' ? '⚠️ 估算值' : '⚠️ 无法计算')

      if (rel === 'blocked') {
        gaps.push({
          id: mb.name + '_' + cat, member: mb.name, role: mb.role || '', category: cat,
          existing: exist, reference: null, gap: null,
          reliability: rel, reliabilityLabel: reliabilityLabel,
          basis: _basisText(cat, exist, debt, memIncome, rel),
          completeHint: _completeHint(cat, hasMemIncome, hasDebt),
          priority: priority, priorityLabel: priorityLabel, why: ''
        })
        continue
      }
      if (_thresholdFor(cat).statusFn(exist, debt, memIncome)) continue
      var ref = _referenceFor(cat, debt, memIncome)
      var gapAmt = Math.max(0, ref - exist)
      gaps.push({
        id: mb.name + '_' + cat, member: mb.name, role: mb.role || '', category: cat,
        existing: exist, reference: ref, gap: gapAmt,
        reliability: rel, reliabilityLabel: reliabilityLabel,
        basis: _basisText(cat, exist, debt, memIncome, rel),
        completeHint: _completeHint(cat, hasMemIncome, hasDebt),
        priority: priority, priorityLabel: priorityLabel, why: ''
      })
    }
  }
  var order = { high: 0, medium: 1, low: 2 }
  gaps.sort(function(a, b) { return (order[a.priority] - order[b.priority]) || ((b.gap || 0) - (a.gap || 0)) })
  return gaps
}

/**
 * 将 gaps[] 转为缺口矩阵
 */
function buildGapMatrix(gaps, members) {
  var seen = {}
  var cats = []
  for (var i = 0; i < members.length; i++) {
    var needed = _neededCats(members[i].role)
    for (var j = 0; j < needed.length; j++) {
      var c = needed[j]
      if (!seen[c]) { seen[c] = true; cats.push(c) }
    }
  }
  for (var k = 0; k < gaps.length; k++) {
    var gc = gaps[k].category
    if (!seen[gc]) { seen[gc] = true; cats.push(gc) }
  }
  var rows = members.map(function(m) {
    var needed = _neededCats(m.role)
    var cells = cats.map(function(cat) {
      if (needed.indexOf(cat) === -1) return { v: '—', s: 'na' }
      var g = null
      for (var i = 0; i < gaps.length; i++) {
        if (gaps[i].member === m.name && gaps[i].category === cat) { g = gaps[i]; break }
      }
      if (!g) return { v: '✅', s: 'ok' }
      if (g.reliability === 'blocked') return { v: '待补', s: 'blocked' }
      var status = g.existing > 0 ? 'partial' : g.reliability
    return { v: g.existing + '万', s: status }
    })
    return { name: m.name, cells: cells }
  })
  return { heads: ['成员'].concat(cats), cats: cats, rows: rows }
}

/**
 * 构建保障覆盖矩阵（设计稿第 2 章）：成员×险种 已有保额（万元），缺失格标红
 * 含每行合计列与底部合计行。纯展示层，不参与缺口判断。
 */
function buildCoverageMatrix(members, policies) {
  var active = (policies || []).filter(function(p) { return p.status === 'active' })
  var memberIdToName = {}
  for (var i = 0; i < members.length; i++) {
    var m = members[i]
    if (m.member_id) memberIdToName[m.member_id] = m.name
  }
  var cats = ['重疾险', '医疗险', '意外险', '寿险']
  var rows = members.map(function(m) {
    var cells = {}
    for (var ci = 0; ci < cats.length; ci++) cells[cats[ci]] = 0
    for (var k = 0; k < active.length; k++) {
      var p = active[k]
      var n = (p.member_id && memberIdToName[p.member_id]) || p.insured_name
      if (n === m.name) {
        var c = _canonCat(p.insurance_category || '其他')
        if (cells[c] !== undefined) cells[c] += (p.sum_assured || 0) / 10000
      }
    }
    return { name: m.name, cells: cells }
  })
  var total = {}
  for (var ci2 = 0; ci2 < cats.length; ci2++) total[cats[ci2]] = 0
  for (var r = 0; r < rows.length; r++) {
    for (var c2 = 0; c2 < cats.length; c2++) total[cats[c2]] += rows[r].cells[cats[c2]]
  }
  function fmt(v) { var x = Math.round(v * 100) / 100; return x === Math.floor(x) ? String(x) : String(x) }
  var out = rows.map(function(row) {
    var rowTotal = 0
    var cells = cats.map(function(c) {
      var v = row.cells[c]
      rowTotal += v
      return v > 0 ? { v: fmt(v), s: 'ok' } : { v: '—', s: 'missing' }
    })
    cells.push({ v: fmt(rowTotal), s: 'total' })
    return { name: row.name, cells: cells }
  })
  var grandCells = cats.map(function(c) {
    var v = total[c]
    return v > 0 ? { v: fmt(v), s: 'ok' } : { v: '—', s: 'missing' }
  })
  var grandTotal = 0
  for (var gt = 0; gt < cats.length; gt++) grandTotal += total[cats[gt]]
  grandCells.push({ v: fmt(grandTotal), s: 'grand' })
  out.push({ name: '合计', cells: grandCells })
  return { heads: ['成员'].concat(cats, ['合计']), cats: cats, rows: out }
}

module.exports = { buildGaps, buildGapMatrix, buildCoverageMatrix }
