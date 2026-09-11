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
const { yuanToWan } = require('./_shared/amount')
const { evaluateCoverage } = require('./_shared/gap-core')

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
  // income 为万口径（finances 元 → yuanToWan 转万），保费元 → 元 = income × 10000
  const premiumRatio = income > 0 ? (totalPremium / (income * 10000) * 100).toFixed(1) : '-'
  const totalSumAssured = activePolicies.reduce((s, p) => s + (p.sum_assured || 0), 0)
  const expiredCount = (policies || []).filter(p => p.status === 'expired').length

  const lines = ['## 保单汇总数据（系统预计算，直接引用）', '']
  // 收入缺失时不输出比率占位（曾泄漏 '-'/'（-%）' 给 AI 照抄），改为显式缺失说明
  lines.push(income > 0
    ? `- 年保费合计：${totalPremium}元（占家庭年收入 ${premiumRatio}%）`
    : `- 年保费合计：${totalPremium}元（家庭年收入未填写，不计算占收入比）`)
  lines.push(`- 有效保单总保额：${Number((totalSumAssured / 10000).toFixed(1))}万`)
  lines.push(`- 有效保单：${activePolicies.length}份 | 已失效/过期：${expiredCount}份`)
  if (s.debt) {
    const d = s.debt
    const dVal = d && typeof d === 'object' ? ((d.amount || 0) + (d.type ? '（' + d.type + '）' : '')) : d
    lines.push(`- 家庭负债：${dVal}`)
  }
  // 口径修复（2026-09-06）：曾误标"固定月支出"致 AI 把年支出写成"每月 X 万"。
  // 数值（真实 finances 路径 _financeSnap 元→万年口径）标"（年）…万"；字符串（历史/带单位）原样透出，不硬标月/年避免误导
  if (s.fixed_expense) {
    const fe = s.fixed_expense
    lines.push(typeof fe === 'number' ? `- 固定支出（年）：${fe}万` : `- 固定支出：${fe}`)
  }
  return lines.join('\n')
}

/**
 * 保障缺口矩阵（**系统预计算**：AI 只引用结论不自行重算。矩阵「依据」列为权威阈值文本，
 * reportAI/prompts.js 不硬编码阈值数字，引用此列）
 *
 * 2026-09-11「业务规则双实现」根因治理：算法上移 _shared/gap-core.js 单一事实源。
 * 本函数此前与前端 miniprogram/utils/report/gap-engine.js 各实现一遍——且是前端的**降级复刻**
 * （固定 4 险种不分角色、无三态可信度、无补全提示），结构上不可能自动一致，口径已分裂 2 次
 * （2026-09-05 P1-A 收入基数 / 2026-09-10 P1-2 未跟上前端修复）。现前端页面矩阵与本矩阵调用
 * 同一个 evaluateCoverage（经 sync-shared.js 跨树契约同步，改算法只改 _shared/gap-core.js），
 * 同算法 → 同数字。本函数自此只做 Markdown 格式化，不做任何计算。
 *
 * @param {array} policies - 已 ensureStatus 的保单数组
 * @param {object} snap - 财务快照 { income(万), debt(万|{amount,type}), fixed_expense }
 * @param {array} members - 家庭成员列表（含 name/role/income(万)）
 * @returns {string}
 */
function buildGapSnapshot(policies, snap, members) {
  const s = snap || {}
  const debtVal = s.debt && typeof s.debt === 'object' ? (s.debt.amount || 0) : (s.debt || 0)
  const memberList = Array.isArray(members) ? members : []
  const active = (policies || []).filter(p => p.status === 'active' || !p.status)

  const rows = evaluateCoverage({
    members: memberList,
    policies: active,
    familyIncomeWan: parseFloat(s.income) || 0,
    debtWan: parseFloat(debtVal) || 0
  })

  const header = '## 保障缺口矩阵（系统预计算，review/analysis 直接引用结论，禁止自行重算或引用缺口金额）'
  // 全空家庭：无成员 → 单行声明，保证 AI 有矩阵依据可引用而非编造
  if (!rows.length) {
    return header + '\n\n| 成员 | 险种 | 覆盖状态 | 依据 |\n|------|------|---------|------|\n| 全体 | - | ❌ 无任何保障 | 该家庭暂无任何保单，所有成员均无保障 |'
  }

  const lines = [header, '', '| 成员 | 险种 | 覆盖状态 | 依据 |', '|------|------|---------|------|']
  for (const r of rows) {
    const status = r.reliability === 'blocked' ? '⚠️ 无法计算' : (r.satisfied ? '✅ 已覆盖' : '❌ 有缺口')
    lines.push(`| ${r.member} | ${r.category} | ${status} | ${r.basis} |`)
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
 * 财务快照组装（审计 P1-4，2026-09-02）：
 * 写侧唯一真相源已迁至 finances 集合（存元）；families.financial_snapshot 已不再维护（新家庭为 null）。
 * 此处优先从 v2ctx.datasets.finances 取数并转万（对齐 familyView.getFinance 口径），
 * 仅当无 finances 记录时兜底旧 financial_snapshot（万口径残留/历史数据）。
 */
function _financeSnap(v2ctx, familyMeta) {
  const fin = (v2ctx && v2ctx.datasets && v2ctx.datasets.finances && v2ctx.datasets.finances[0]) || {}
  const has = fin && (fin.annual_income != null || fin.income != null || fin.total_debt != null || fin.debt != null || fin.fixed_annual_expense != null || fin.fixed_expense != null)
  if (!has) return (familyMeta && familyMeta.financial_snapshot) || {}
  // 元键（annual_income 等）→ 万；旧万键（income 等）原样
  const wan = function (newVal, fallbackVal) {
    if (newVal != null) { const n = Number(newVal); return isNaN(n) ? 0 : yuanToWan(n) }
    if (fallbackVal != null) { const n = Number(fallbackVal); return isNaN(n) ? 0 : n }
    return 0
  }
  const snap = {}
  if (fin.annual_income != null || fin.income != null) snap.income = wan(fin.annual_income, fin.income)
  if (fin.total_debt != null || fin.debt != null) snap.debt = { amount: wan(fin.total_debt, fin.debt), type: fin.debt_type || '' }
  if (fin.fixed_annual_expense != null || fin.fixed_expense != null) snap.fixed_expense = wan(fin.fixed_annual_expense, fin.fixed_expense)
  return snap
}

/**
 * 数据口径说明（2026-09-10 上下文审计 P2）：置于上下文最前，让模型在读数据前先建立口径与权威顺序。
 * 背景：家庭级/成员级收入、多方预计算结论的取用规则此前分散在 prompts.js 各条硬约束里，模型需自行归纳；
 * 把「数据是什么、以谁为准」前移到数据侧，降低误用概率（prompt 侧规则保持不动，二者同向不冲突）。
 */
const CONTEXT_PREAMBLE = [
  '## 数据口径说明（系统生成，读下方数据前先读本节）',
  '- 权威顺序：保单覆盖现状以「结构化保单清单」为准；保障缺口的结论与阈值以「保障缺口矩阵」为准，禁止自行重算。',
  '- 收入口径：三处收入含义不同——「经济状况」为家庭级年收入（用于保费占比）；画像是成员个人年收入；缺口矩阵中寿险/意外的需求基数按成员个人年收入计算（仅支柱个人收入缺失时系统用家庭年收入兜底，并在依据列标注）。',
  '- 保单状态、保障到期、已缴年、累计保费、现价、回本均为系统预计算值，直接引用，不要自行推断。',
  '- 保单是否有覆盖一律以「结构化保单清单」的 status 列为准：一年期产品（含一年期附加险）即使「保障到期」日期已过，也**默认有效、照常计入保障**，禁止据此扣减保额或判定失效。'
].join('\n')

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
  const snap = _financeSnap(v2ctx, familyMeta)

  const { structuredMd, hintsMd } = buildStructuredCoverage(policies, facts, cashValues)
  const summaryMd = buildSummaryMd(policies, snap)
  const members = (v2ctx && v2ctx.datasets && v2ctx.datasets.members) || []
  const gapMd = buildGapSnapshot(policies, snap, members)
  const prevMd = buildPrevReportMd(familyMeta)

  return [
    CONTEXT_PREAMBLE,
    v2ctx && v2ctx.markdown,
    summaryMd,
    gapMd,
    structuredMd,
    hintsMd,
    prevMd
  ].filter(Boolean).join('\n\n')
}

module.exports = { buildSummaryMd, buildGapSnapshot, buildPrevReportMd, buildReportContext }
