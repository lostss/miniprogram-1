/**
 * chapter-builder.js — 报告章节编排
 *
 * 调用 gap-engine / timeline-builder / data-normalizer，
 * 将 AI 报告数据组装为章节卡片数组。
 */

var { normalizeFamilyData, createNumbering } = require('./data-normalizer')
var { buildGaps, buildGapMatrix } = require('./gap-engine')
var { buildTimeline, parseMilestonesToTimeline } = require('./timeline-builder')
var { THRESHOLDS, DEFAULT_THRESHOLD, canonCat, formatThresholdAppendix } = require('../thresholds')
var createBlock = require('../custom-blocks').create
var parseExpiry = require('../parse-expiry').parseExpiry

function _trimSentences(text, n) {
  var s = String(text || '').trim()
  if (!s) return ''
  var sent = s.replace(/\s*\n\s*/g, '。').split(/[。！？!?]/)
  return sent.slice(0, Math.min(n, sent.length)).join('。') + '。'
}

function _extractUrgentShort(raw) {
  var s = String(raw || '').trim()
  if (!s) return null
  var lines = s.split(/\n/).filter(function(l) { return l.trim().length > 0 })
  var bullet = null
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].replace(/^[-*•>\s]+/, '').trim()
    if (l.length >= 12 && l.length <= 60) { bullet = l; break }
  }
  if (!bullet) bullet = lines[0].replace(/^[-*•>\s]+/, '').trim().substring(0, 80)
  return bullet || null
}

function _replacePlaceholders(md, data) {
  return String(md || '').replace(/\{(\w+)\}/g, function(_, k) { return data[k] !== undefined ? data[k] : '{' + k + '}' })
}

/**
 * 构建所有报告章节（主报告 + 附录）
 */
function buildChapters(family, report) {
  var norm = normalizeFamilyData(family)
  var active = norm.active
  var debt = norm.debt
  var totalIncome = norm.totalIncome
  var annualPremium = norm.annualPremium
  var annualPremiumW = norm.annualPremiumW
  var premiumRatio = norm.premiumRatio
  var memberMap = norm.memberMap
  var members = norm.members
  var policies = norm.policies
  var memberIdToName = norm.memberIdToName

  var gaps = buildGaps(family)
  var matrix = buildGapMatrix(gaps, members)
  var placeholders = {}
  var gapByCatMember = {}
  for (var gi = 0; gi < gaps.length; gi++) {
    var g = gaps[gi]
    gapByCatMember[g.member + '|' + g.category] = g
    if (g.gap > 0) {
      placeholders[g.category + 'Gap'] = g.gap
      placeholders[g.category + 'Ref'] = g.reference
    }
  }
  var _g = createNumbering()
  var ch = []

  // 占位符
  placeholders.debtW = debt / 10000
  placeholders.incomeW = totalIncome
  placeholders.annualPremiumW = annualPremiumW
  placeholders.premiumRatio = premiumRatio
  placeholders.memberList = members.map(function(m) { return m.name }).join('、')
  placeholders.viewDate = new Date().toISOString().substring(0, 10)

  // ======== 主报告 ========

  // ① 保障概览
  var dashboardBlocks = []
  var familyPlan = {}
  for (var mi = 0; mi < members.length; mi++) {
    var mb = members[mi]
    var mc = memberMap[mb.name] || { name: mb.name, items: [] }
    familyPlan[mb.name] = {
      role: mb.role || '',
      birthday: mb.birth_date ? mb.birth_date : '',
      items: mc.items,
      gaps: {
        high: gaps.filter(function(g) { return g.member === mb.name && g.priority === 'high' && g.gap > 0 }),
        medium: gaps.filter(function(g) { return g.member === mb.name && g.priority === 'medium' && g.gap > 0 })
      }
    }
  }
  var matrixData = { heads: matrix.heads, rows: matrix.rows }
  dashboardBlocks.push(createBlock('dashboard', { familyPlan: familyPlan, matrix: matrixData }, ''))
  ch.push({ key: 'overview', title: '保障概览', num: _g(), customBlocks: dashboardBlocks })

  // ② 紧急行动
  var urgentShort = report.urgent_actions ? _extractUrgentShort(report.urgent_actions) : null
  var hasUrgent = report.urgent_actions && String(report.urgent_actions).trim().length > 30
  if (hasUrgent) {
    ch.push({
      key: 'urgent_actions', title: '紧急行动', num: _g(),
      content: _replacePlaceholders(String(report.urgent_actions), placeholders),
      pre: urgentShort
    })
  }

  // ③ 保障规划建议
  if (report.gap_plan && String(report.gap_plan).trim().length > 20) {
    ch.push({
      key: 'plan', title: '保障规划建议', num: _g(),
      content: _replacePlaceholders(String(report.gap_plan), placeholders)
    })
  }

  // ④ 行动建议
  if (report.suggestions && String(report.suggestions).trim().length > 20) {
    ch.push({
      key: 'suggestions', title: '行动建议', num: _g(),
      content: _replacePlaceholders(String(report.suggestions), placeholders)
    })
  }

  // ⑤ 关键发现
  if (report.core_insights && String(report.core_insights).trim().length > 10) {
    ch.push({
      key: 'core_insights', title: '关键发现', num: _g(),
      content: _replacePlaceholders(String(report.core_insights), placeholders)
    })
  }

  // ⑥ 深度分析
  if (report.raw_analysis && String(report.raw_analysis).trim().length > 15) {
    ch.push({
      key: 'analysis', title: '深度分析', num: _g(),
      collapsible: true, defaultCollapsed: false,
      pre: report.portrait ? _trimSentences(String(report.portrait).replace(/\\n/g, '\n'), 2) : '',
      customBlocks: [createBlock('panorama', { heads: matrix.heads, cats: matrix.cats, rows: matrix.rows })],
      content: _replacePlaceholders(String(report.raw_analysis), placeholders)
    })
  }

  // ======== 附录（独立编号） ========
  var appendixNum = createNumbering()

  var mons = (function() {
    var months = []
    for (var i = 0; i < 12; i++) {
      var t = active.reduce(function(s, p) {
        var mo = -1
        var dt = p.contract_effective_date || p.effective_date || ''
        if (dt) { var d = new Date(dt); if (!isNaN(d.getTime())) mo = d.getMonth() }
        return mo === i ? s + (p.annual_premium || 0) : s
      }, 0)
      months.push({ m: i + 1, v: t > 0 ? t + '元' : '-', h: t > 0 })
    }
    return months
  })()

  var timeline = buildTimeline(policies, members).filter(function(e) { return e.type !== 'payment' })

  // 保障关键时点
  if (timeline.length > 0) ch.push({
    key: 'appendix_timeline', title: '保障关键时点', num: appendixNum(),
    customBlocks: [createBlock('timeline', { items: timeline })]
  })

  // 缴费月历
  if (mons.length > 0) ch.push({
    key: 'appendix_calendar', title: '缴费月历', num: appendixNum(),
    customBlocks: [createBlock('calendar', { items: mons }, '年保费 ' + annualPremiumW + '万 · 占收入 ' + premiumRatio + '%')]
  })

  // 保单列表
  var sorted = [].concat(policies).sort(function(a, b) {
    var order = { expired: 0, suspicious: 1, active: 2 }
    return (order[a.status] || 9) - (order[b.status] || 9)
  })
  var policyMd = '| 产品 | 险种 | 保额 | 保费 | 被保人 | 生效日 | 状态 |\n|------|------|------|------|--------|--------|------|\n'
  for (var pi = 0; pi < sorted.length; pi++) {
    var p = sorted[pi]
    var eff = p.contract_effective_date || p.effective_date || ''
    var effStr = eff ? eff.substring(0, 10) : '--'
    var status = p.status === 'expired' ? '❌已过期' : (p.status === 'suspicious' ? '⚠️异常' : (p.status || '有效'))
    var suspicious = (p.sum_assured === 0 || !p.sum_assured) && p.annual_premium > 0 ? '⚠️' : ''
    policyMd += '| ' + suspicious + (p.product_name || '未知') + ' | ' + canonCat(p.insurance_category || '--') + ' | ' + Number(((p.sum_assured || 0) / 10000).toFixed(1)) + '万 | ' + (p.annual_premium || 0) + '元 | ' + (p.insured_name || '--') + ' | ' + effStr + ' | ' + status + ' |\n'
  }
  ch.push({ key: 'appendix_policies', title: '保单列表', num: appendixNum(), content: policyMd })

  // 引用说明
  ch.push({ key: 'appendix_refs', title: '引用说明', num: appendixNum(),
    content: formatThresholdAppendix() + '\n\n5. 保费占比 = 年保费 / 年收入，合理区间 5%-15%\n\n6. 配置顺序：先大人后小孩，先保障后理财；优先级：重疾险 → 医疗险 → 意外险 → 寿险' })

  // 术语解释
  ch.push({ key: 'appendix_terms', title: '术语解释', num: appendixNum(),
    content: '| 术语 | 含义 |\n|------|------|\n| 等待期 | 保单生效后，在此期间出险不赔付，重疾通常90-180天 |\n| 宽限期 | 续期保费到期后的一段缓冲期，通常60天，期内保障继续有效 |\n| 现金价值 | 退保时可拿回的钱，前期通常远低于已缴保费 |\n| 豁免条款 | 发生约定事故后，后续保费不再需要缴纳，保障继续有效 |\n| 免赔额 | 保险赔付的起付线，低于此金额需自费 |\n| 保证续保 | 保险公司承诺到期后必须续保，不会因健康状况拒保 |\n| 社保目录 | 国家医保报销范围内的药品和治疗项目清单 |\n| 需求分析法 | 根据家庭负债+收入损失计算寿险保额的方法 |' })

  // 免责声明
  if (report.disclaimer) ch.push({
    key: 'appendix_disclaimer', title: '免责声明', num: appendixNum(),
    content: report.disclaimer + '\n\n*🤖 本报告由AI基于保单数据自动生成，仅供参考。具体方案请以保险代理人专业意见为准。*' })

  return ch
}

module.exports = { buildChapters }
