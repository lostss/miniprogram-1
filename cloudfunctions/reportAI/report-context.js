/**
 * report-context.js — 报告 AI 上下文构建（3 段整合）
 *
 * 解决问题：reportAI/index.js 的 enrichedContext 拼接逻辑分散在主流程 20+ 行，
 * 混杂保单汇总预计算、结构化清单调用、上一版参考 3 段独立关注点。
 *
 * 设计：纯函数 + 显式入参，不依赖 db/cloud
 *  - buildSummaryMd(policies, snap)      → 保单汇总预计算（禁止 AI 自行推算）
 *  - buildPrevReportMd(familyMeta)       → 上一版结论/摘要参考（禁止照抄）
 *  - buildReportContext({ v2ctx, policies, facts, cashValues, familyMeta })
 *                                       → 整合 v2.markdown + summary + structured + hints + prev
 *
 * 依赖：buildStructuredCoverage 已抽到 report-coverage.js，本模块仅组合调用。
 */
const { buildStructuredCoverage } = require('./report-coverage')

/**
 * 保单汇总数据预计算 Markdown（禁止 AI 自行推算）
 * @param {array} policies - 保单数组（已 ensureStatus）
 * @param {object} snap - financial_snapshot { income, debt, fixed_expense }
 * @returns {string}
 */
function buildSummaryMd(policies, snap) {
  const activePolicies = (policies || []).filter(p => p.status === 'active' || !p.status)
  const totalPremium = activePolicies.reduce((s, p) => s + (p.annual_premium || 0), 0)
  const s = snap || {}
  const income = s.income ? parseFloat(s.income) : 0
  const premiumRatio = income > 0 ? (totalPremium / (income * 10000) * 100).toFixed(1) : '-'
  const totalSumAssured = activePolicies.reduce((s, p) => s + (p.sum_assured || 0), 0)
  const expiredCount = (policies || []).filter(p => p.status === 'expired').length

  const lines = ['## 保单汇总数据（系统预计算，直接引用）', '']
  lines.push(`- 年保费合计：${totalPremium}元（占家庭年收入 ${premiumRatio}%）`)
  lines.push(`- 有效保单总保额：${Number((totalSumAssured / 10000).toFixed(1))}万`)
  lines.push(`- 有效保单：${activePolicies.length}份 | 已失效/过期：${expiredCount}份`)
  if (s.debt) lines.push(`- 家庭负债：${s.debt}`)
  if (s.fixed_expense) lines.push(`- 固定月支出：${s.fixed_expense}`)
  return lines.join('\n')
}

/**
 * 保障缺口矩阵（数值审计 #3：与前端 gap-engine 阈值同源复刻，注入 AI 上下文统一两侧口径——
 * 前端 hero 按阈值判缺口，AI 画像按存在性判覆盖，两者不一致导致报告内矛盾。
 * 本快照为系统预计算，AI 只引用结论不自行重算）
 * @param {array} policies - 已 ensureStatus 的保单数组
 * @param {object} snap - financial_snapshot { income, debt, fixed_expense }
 * @param {array} members - 家庭成员列表（识别无保单成员；prompt 工程审计，空家庭须有显式矩阵依据）
 * @returns {string}
 */
function buildGapSnapshot(policies, snap, members) {
  const s = snap || {}
  const income = parseFloat(s.income) || 0
  const debtVal = s.debt && typeof s.debt === 'object' ? (s.debt.amount || 0) : (s.debt || 0)
  const debt = parseFloat(debtVal) || 0
  const active = (policies || []).filter(p => p.status === 'active' || !p.status)
  const byMember = {}
  for (const p of active) {
    const k = p.member_id || p.insured_name || 'unknown'
    if (!byMember[k]) byMember[k] = { name: p.insured_name || '未署名', sums: {} }
    const cat = p.insurance_category || ''
    byMember[k].sums[cat] = (byMember[k].sums[cat] || 0) + (p.sum_assured || 0)
  }
  const cats = ['重疾险', '医疗险', '寿险', '意外险']
  // 无保单成员兜底：成员名单中存在但无任何 active 保单者 → 显式"无保障"行
  // 全空家庭：members 与 policies 均无 → 单行声明，保证 AI 有矩阵依据可引用而非编造
  const memberList = Array.isArray(members) ? members : []
  const noPolicyMembers = memberList.filter(m => m && !byMember[m.member_id])
  if (!Object.keys(byMember).length && !noPolicyMembers.length) {
    return '## 保障缺口矩阵（系统预计算，review/analysis 直接引用结论，禁止自行重算或引用缺口金额）\n\n| 成员 | 险种 | 覆盖状态 | 依据 |\n|------|------|---------|------|\n| 全体 | - | ❌ 无任何保障 | 该家庭暂无任何保单，所有成员均无保障 |'
  }
  const lines = ['## 保障缺口矩阵（系统预计算，review/analysis 直接引用结论，禁止自行重算或引用缺口金额）', '', '| 成员 | 险种 | 覆盖状态 | 依据 |', '|------|------|---------|------|']
  for (const k of Object.keys(byMember)) {
    const m = byMember[k]
    for (const cat of cats) {
      const existing = (m.sums[cat] || 0) / 10000
      let ok = false, basis = ''
      if (cat === '重疾险') { ok = existing >= 50; basis = ok ? `已覆盖${existing}万(参考50万)` : `缺口：现有${existing}万<50万` }
      else if (cat === '医疗险') { ok = existing > 0; basis = ok ? '已覆盖' : '无医疗险' }
      else if (cat === '寿险') { const need = Math.round(debt + 5 * income); ok = existing >= need; basis = `需求=负债${debt}万+5×收入${income}万=${need}万，现有${existing}万` }
      else { const need = Math.round(Math.max(5 * income, debt)); ok = existing >= need; basis = `需求=max(5×收入${income}万,负债${debt}万)=${need}万，现有${existing}万` }
      lines.push(`| ${m.name} | ${cat} | ${ok ? '✅ 已覆盖' : '❌ 有缺口'} | ${basis} |`)
    }
  }
  for (const m of noPolicyMembers) {
    lines.push(`| ${m.name || '成员'} | - | ❌ 无任何保障 | 该成员名下无任何有效保单 |`)
  }
  return lines.join('\n')
}

/**
 * 上一版报告参考 Markdown（禁止照抄，以当前数据为准重新生成）
 * @param {object} familyMeta - 家庭元数据（含 last_conclusion / last_summary）
 * @returns {string}
 */
function buildPrevReportMd(familyMeta) {
  const fm = familyMeta || {}
  const prev = []
  if (fm.last_conclusion) prev.push('**上一版结论**：' + fm.last_conclusion)
  if (fm.last_summary) prev.push('**上一版摘要**：' + fm.last_summary)
  if (!prev.length) return ''
  return '## 上一版报告结论（参考，禁止照抄，以当前数据为准重新生成）\n' + prev.join('\n')
}

/**
 * 整合 3 段上下文 + v2.markdown 为最终 AI 消费的字符串
 * @param {object} opts
 *   - v2ctx: buildV2Context 返回值（用其 markdown + datasets.facts + datasets.cashValues + familyMeta）
 *   - policies: 已 ensureStatus 的保单数组
 *   - familyMeta: 家庭元数据（用于 prev 报告，独立传入便于测试）
 * @returns {string} enrichedContext
 */
function buildReportContext(opts) {
  const { v2ctx, policies, familyMeta } = opts
  const facts = (v2ctx && v2ctx.datasets && v2ctx.datasets.facts) || []
  const cashValues = (v2ctx && v2ctx.datasets && v2ctx.datasets.cashValues) || []
  const snap = (familyMeta && familyMeta.financial_snapshot) || {}

  const { structuredMd, hintsMd } = buildStructuredCoverage(policies, facts, cashValues)
  const summaryMd = buildSummaryMd(policies, snap)
  const members = (v2ctx && v2ctx.datasets && v2ctx.datasets.members) || []
  const gapMd = buildGapSnapshot(policies, snap, members)
  const prevMd = buildPrevReportMd(familyMeta)

  return [
    v2ctx && v2ctx.markdown,
    summaryMd,
    gapMd,
    structuredMd,
    hintsMd,
    prevMd
  ].filter(Boolean).join('\n\n')
}

module.exports = { buildSummaryMd, buildGapSnapshot, buildPrevReportMd, buildReportContext }
