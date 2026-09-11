/**
 * gap-engine.js — 保障缺口展示层
 *
 * 2026-09-11「业务规则双实现」治理：**计算核心已上移** cloudfunctions/_shared/gap-core.js，
 * 经 sync-shared.js 的 CONTRACT_FILES 跨树契约同步为 ../gap-core.js —— 前端页面矩阵与
 * 后端 AI 报告（reportAI/report-context）现调用同一份算法（此前各实现一遍，且后端是简化复刻，
 * 口径分裂 2 次：2026-09-05 P1-A 收入基数、2026-09-10 P1-2）。
 *
 * 本文件只保留**展示层**：gaps 的筛选与排序、缺口矩阵、覆盖矩阵的形状。
 * 改算法请改 cloudfunctions/_shared/gap-core.js（改本文件副本 = 下次 sync 被覆盖）。
 */
const { evaluateCoverage, neededCats } = require('../gap-core')
const { canonCat } = require('../thresholds')
const { yuanToWan } = require('../amount')

/**
 * 构建结构化保障缺口（前端纯计算，不消耗 AI）
 * 展示语义：只保留**未满足**项（含 blocked 待补项，其 satisfied=false）
 */
function buildGaps(family) {
  const rows = evaluateCoverage({
    members: (family && family.members) || [],
    policies: (family && family.policies) || [],
    familyIncomeWan: Number(family && family.family_income) || 0,
    debtWan: (family && family.debt && family.debt.amount) || 0
  })
  const gaps = rows.filter(function(r) { return !r.satisfied })
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
    var needed = neededCats(members[i].role)
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
    var needed = neededCats(m.role)
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
 * 含底部险种合计行（各险种跨成员汇总）；右侧成员合计列已移除（单成员多险种相加无意义）。
 * 纯展示层，不参与缺口判断。
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
        var c = canonCat(p.insurance_category || '其他')
        if (cells[c] !== undefined) cells[c] += yuanToWan(p.sum_assured || 0)
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
    var cells = cats.map(function(c) {
      var v = row.cells[c]
      return v > 0 ? { v: fmt(v), s: 'ok' } : { v: '—', s: 'missing' }
    })
    return { name: row.name, cells: cells }
  })
  var grandCells = cats.map(function(c) {
    var v = total[c]
    return v > 0 ? { v: fmt(v), s: 'ok' } : { v: '—', s: 'missing' }
  })
  out.push({ name: '合计', cells: grandCells })
  return { heads: ['成员'].concat(cats), cats: cats, rows: out }
}

module.exports = { buildGaps, buildGapMatrix, buildCoverageMatrix }
