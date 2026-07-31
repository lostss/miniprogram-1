/**
 * report-builder.js — 向后兼容 barrel
 *
 * 核心逻辑已拆分到 utils/report/ 各子模块：
 *   - data-normalizer.js  公共数据预处理
 *   - gap-engine.js       保障缺口计算
 *   - timeline-builder.js  时间轴构建
 *   - chapter-builder.js  章节编排
 *
 * 本文件负责 re-export + 保留未迁移的小型导出函数。
 */

var { buildChapters, buildGaps, buildGapMatrix, buildCoverageMatrix, buildConfidenceAlerts, buildTimeline, parseMilestonesToTimeline } = require('./report/index')

/**
 * 根据报告数据生成追问建议
 */
function makeHints(report, family) {
  var h = []
  if (report.hints && report.hints.length > 0) {
    for (var i = 0; i < report.hints.length; i++) {
      if (report.hints[i] && report.hints[i].text) {
        h.push({ text: report.hints[i].text, q: report.hints[i].q || report.hints[i].text })
      }
    }
  }
  return h
}

/**
 * 评估数据完整度（返回结构化对象以兼容旧调用方）
 */
function assessDataCompleteness(family) {
  var members = (family && family.members) || []
  var items = []
  var okCount = 0; var totalCount = 0
  function _check(name, ok, hint) { items.push({ name: name, ok: ok, hint: hint || '' }); if (ok) okCount++; totalCount++ }

  _check('家庭成员', members.length > 0, members.length === 0 ? '请添加至少一个家庭成员' : '')
  var hasPolicy = (family && family.policies && family.policies.length > 0)
  _check('保单', hasPolicy, hasPolicy ? '' : '请导入至少一份保单')

  // 按成员检查（兼容旧测试：name = '年收入' 不带成员名前缀）
  var hasIncome = members.some(function(m) { return m.income > 0 }) || parseInt(family && family.family_income) > 0
  _check('年收入', hasIncome, hasIncome ? '' : '收入缺失将影响寿险/意外险缺口计算')
  var hasBirth = members.some(function(m) { return !!m.birth_date })
  _check('出生日期', hasBirth, hasBirth ? '' : '用于判断年龄阶段（成年/老年）')
  var hasRole = members.some(function(m) { return !!m.role })
  _check('角色身份', hasRole, hasRole ? '' : '角色决定保险需求类型（本人/配偶/子女/父母）')

  var completePercent = totalCount > 0 ? Math.min(100, Math.round(okCount / totalCount * 100)) : 0
  return { complete: okCount === totalCount, items: items }
}

// 险种短名（与 chapter-builder 一致：寿险保留全称）
function _shortCatName(cat) {
  var s = String(cat || '')
  if (s.length > 1 && s.charAt(s.length - 1) === '险') {
    var t = s.slice(0, -1)
    if (t.length >= 2) return t
  }
  return s
}

/**
 * 构建 Hero 保障覆盖检查（设计稿：结论先行警示列表）
 * @param {object} family
 * @param {array} gaps — buildGaps 结果
 * @returns {{ alerts: [{name, missing[], ok}], summary, topAdvice }}
 */
function buildHero(family, gaps) {
  var members = (family && family.members) || []
  gaps = gaps || []
  var alerts = members.map(function(m) {
    var missing = gaps.filter(function(g) { return g.member === m.name && g.gap > 0 }).map(function(g) { return _shortCatName(g.category) })
    return {
      name: m.name,
      role: m.role || '',
      missing: missing,
      ok: missing.length === 0,
      display: missing.length > 0 ? ('缺少' + missing.join('、') + '保障') : '保障覆盖完整'
    }
  })
  var missingCount = alerts.filter(function(a) { return !a.ok }).length
  var summary = members.length + '位成员中，' + missingCount + '位存在缺口'
  var top = null
  var order = { high: 0, medium: 1, low: 2 }
  for (var i = 0; i < gaps.length; i++) {
    var g = gaps[i]
    if (g.gap > 0 && (!top || (order[g.priority] < order[top.priority]))) top = g
  }
  var topAdvice = top ? '建议优先为' + top.member + '补充' + top.category : ''
  return { alerts: alerts, summary: summary, topAdvice: topAdvice }
}

/**
 * 计算报告元信息
 */
function computeReportMeta(family) {
  var d = new Date()
  var dateStr = d.getFullYear() + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + ('0' + d.getDate()).slice(-2)
  return { date: dateStr, no: (family.report_no || ''), version: family.report_version || 1 }
}

module.exports = {
  buildChapters: buildChapters,
  buildGaps: buildGaps,
  buildGapMatrix: buildGapMatrix,
  buildCoverageMatrix: buildCoverageMatrix,
  buildConfidenceAlerts: buildConfidenceAlerts,
  buildTimeline: buildTimeline,
  parseMilestonesToTimeline: parseMilestonesToTimeline,
  makeHints: makeHints,
  assessDataCompleteness: assessDataCompleteness,
  computeReportMeta: computeReportMeta,
  buildHero: buildHero
}
