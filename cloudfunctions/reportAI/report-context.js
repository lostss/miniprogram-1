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
  const prevMd = buildPrevReportMd(familyMeta)

  return [
    v2ctx && v2ctx.markdown,
    summaryMd,
    structuredMd,
    hintsMd,
    prevMd
  ].filter(Boolean).join('\n\n')
}

module.exports = { buildSummaryMd, buildPrevReportMd, buildReportContext }
