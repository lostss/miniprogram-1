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

var { buildChapters, buildGaps, buildCoverageMatrix, buildTimeline, normalizeFamilyData } = require('./report/index')

/**
 * buildReportView — 报告聚合入口深模块（候选 2）
 * 页面只调一个接口拿全部视图数据，报告结构知识收拢此处（可单测）
 * @param {object} family
 * @param {object} report — AI 报告（可空；基础版仅用 conclusion/disclaimer/hints）
 * @returns {{ chapters, hero, summaryCards, gaps, hints }}
 */
function buildReportView(family, report, opts) {
  report = report || {}
  opts = opts || {}
  const gaps = buildGaps(family)
  const chapters = buildChapters(family, report, gaps, opts)
  const hints = makeHints(report, family)
  // Hero 结论先行：规则版覆盖检查（警示列表 + 总结 + 优先建议），AI conclusion 仅供分享标题
  const heroView = buildHero(family, gaps, opts)
  const hero = Object.assign(heroView, { conclusion: String(report.conclusion || '') })
  const norm = normalizeFamilyData(family)
  // 保障人数：有至少一份有效保单的去重成员数（按 member_id 优先、insured_name 兜底；无归属保单不计入）
  const coveredIds = new Set()
  for (const p of norm.active) {
    const key = p.member_id || p.insured_name || ''
    if (key) coveredIds.add(key)
  }
  const summaryCards = {
    premium: String(norm.annualPremiumW),
    coverage: String(norm.totalCoverage),
    // 审计·顾问视角（2026-09-04）：一年期短险单独标注（摘要卡 caption，防总保额虚高误导）
    short: norm.shortTermCoverage > 0 ? String(Math.round(norm.shortTermCoverage * 10) / 10) : '',
    count: coveredIds.size
  }
  return { chapters: chapters, hero: hero, summaryCards: summaryCards, gaps: gaps, hints: hints, deep: buildDeepAnalysis(report) }
}

/**
 * 深度分析视图（reportAI 输出 → 4 段式专家解读，纯展示无操作入口）
 * 数据源：report.review（保障点评）/ analysis（根因）/ plan（方案）/ suggestions（行动清单，含优先级占位符）/ core_insights
 * @param {object} report — families.report（AI 深度分析结果，可空）
 * @returns {object|null} null 表示无深度分析
 */
function buildDeepAnalysis(report) {
  report = report || {}
  const has = !!(report.portrait || report.review || report.analysis || report.plan || report.suggestions || (report.core_insights && report.core_insights.length))
  if (!has) return null
  return {
    insights: Array.isArray(report.core_insights) ? report.core_insights : [],
    // 审计 C2（2026-09-02）：AI 家庭画像补入 deep 首段（保障点评前），补齐画像→点评→根因→方案→行动闭环
    portrait: report.portrait || '',
    review: report.review || '',
    analysis: report.analysis || '',
    plan: report.plan || '',
    // 行动清单：占位符 → 优先级前缀（【立即】/【近期】/【中期】），保持有序列表结构
    suggestions: _fmtSuggestions(report.suggestions)
  }
}

// suggestions 占位符替换（REPORT_PROMPT 契约：{{URGENT}}/{{NEAR}}/{{MID}}）
function _fmtSuggestions(raw) {
  if (!raw) return ''
  return String(raw)
    .replace(/\{\{URGENT\}\}/g, '【立即】')
    .replace(/\{\{NEAR\}\}/g, '【近期】')
    .replace(/\{\{MID\}\}/g, '【中期】')
}

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
function buildHero(family, gaps, opts) {
  var members = (family && family.members) || []
  var shared = !!(opts && opts.view === 'shared')
  gaps = gaps || []
  // 2026-09-10 三态修复：原实现只按 g.gap > 0 判缺口，而 blocked（收入缺失致寿险/意外无法计算）
  // 的 gap 为 null 被过滤 → 该类成员被判"保障覆盖完整"（绿点）并计入完整数。未知 ≠ 完整。
  var alerts = members.map(function(m) {
    var mine = gaps.filter(function(g) { return g.member === m.name })
    var missing = mine.filter(function(g) { return g.gap > 0 }).map(function(g) { return _shortCatName(g.category) })
    var unknown = mine.filter(function(g) { return g.reliability === 'blocked' }).map(function(g) { return _shortCatName(g.category) })
    return {
      name: m.name,
      role: m.role || '',
      missing: missing,
      unknown: unknown,
      // ok = 既无确切缺口、也无无法计算的项（否则绿点会掩盖未知状态）
      ok: missing.length === 0 && unknown.length === 0,
      // blocked 态：无确切缺口但有待补数据项 → 前端渲染黄点
      blocked: missing.length === 0 && unknown.length > 0,
      // 客户版中性措辞：不列"缺少XX"式恐吓文案，只标"保障待完善"
      display: missing.length > 0
        ? (shared ? '保障待完善' : ('缺少' + missing.join('、') + '保障'))
        : (unknown.length > 0
          ? (shared ? '部分保障待确认' : (unknown.join('、') + '保障情况待确认'))
          : '保障覆盖完整')
    }
  })
  var missingCount = alerts.filter(function(a) { return a.missing.length > 0 }).length
  var unknownCount = alerts.filter(function(a) { return a.blocked }).length
  var summary = shared
    ? '本次检视覆盖' + members.length + '位成员，' + ((missingCount + unknownCount) > 0
        ? (missingCount > 0 ? missingCount + '位保障待完善' : '') +
          (unknownCount > 0 ? (missingCount > 0 ? '、' : '') + unknownCount + '位部分保障待确认' : '')
        : '保障覆盖完整')
    : members.length + '位成员中，' + missingCount + '位存在缺口' + (unknownCount > 0 ? '，' + unknownCount + '位数据待补' : '')
  var top = null
  var order = { high: 0, medium: 1, low: 2 }
  for (var i = 0; i < gaps.length; i++) {
    var g = gaps[i]
    if (g.gap > 0 && (!top || (order[g.priority] < order[top.priority]))) top = g
  }
  var topAdvice = top ? (shared ? '建议关注' + top.member + '的' + top.category + '保障' : '建议优先为' + top.member + '补充' + top.category) : ''
  return { alerts: alerts, summary: summary, topAdvice: topAdvice }
}

module.exports = {
  buildChapters: buildChapters,
  buildGaps: buildGaps,
  buildCoverageMatrix: buildCoverageMatrix,
  buildTimeline: buildTimeline,
  makeHints: makeHints,
  assessDataCompleteness: assessDataCompleteness,
  buildHero: buildHero,
  buildReportView: buildReportView,
  buildDeepAnalysis: buildDeepAnalysis
}
