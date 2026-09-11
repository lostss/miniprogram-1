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
 * 保障缺口矩阵（数值审计 #3 + P1-P2 修正 2026-09-05：口径与前端 gap-engine / thresholds.js 单一事实源对齐，
 * 医疗险 >=100 万及格线（原 >0 存在性判覆盖与前端不一致）；矩阵每行「依据」列为权威阈值文本，
 * reportAI/prompts.js 不再硬编码阈值数字，引用此列。本快照为系统预计算，AI 只引用结论不自行重算）
 *
 * 2026-09-10 两项修复：
 *   P1-2 寿险/意外需求基数改按成员个人收入——前端 gap-engine 已在 P1-A（2026-09-05）改为
 *        「成员个人收入优先 → 支柱个人收入缺失用家庭年收入全额兜底 → 非支柱缺失按 0」，
 *        本函数此前对所有成员一律用家庭收入 → AI 报告缺口数字与页面矩阵对不上。
 *        同时对收入缺失成员输出 ⚠️ 无法计算（对齐前端 blocked 三态），不再用假 0 收入算出需求。
 *   P2-1 保单缺 member_id 时按「姓名 → member_id」归位，修复同一成员既「✅ 已覆盖」又「❌ 无任何保障」的矛盾行。
 * @param {array} policies - 已 ensureStatus 的保单数组
 * @param {object} snap - 财务快照 { income(万), debt(万|{amount,type}), fixed_expense }
 * @param {array} members - 家庭成员列表（含 name/role/income(万)）
 * @returns {string}
 */
function buildGapSnapshot(policies, snap, members) {
  const s = snap || {}
  const familyIncome = parseFloat(s.income) || 0
  const debtVal = s.debt && typeof s.debt === 'object' ? (s.debt.amount || 0) : (s.debt || 0)
  const debt = parseFloat(debtVal) || 0
  const active = (policies || []).filter(p => p.status === 'active' || !p.status)
  const memberList = Array.isArray(members) ? members : []

  // P2-1：成员键归一——成员有 member_id 用其 id，否则用 'name:姓名' 兜底；保单侧同规则，
  // 使「保单聚合」与「无保单成员判定」用同一个键（原实现一侧用 member_id、一侧可能落到姓名）
  const _memberKey = m => (m && (m.member_id || 'name:' + m.name)) || ''
  const nameToKey = {}
  for (const m of memberList) {
    if (m && m.name) nameToKey[m.name] = _memberKey(m)
  }
  const _policyKey = p => {
    if (p.member_id) return p.member_id
    if (p.insured_name && nameToKey[p.insured_name]) return nameToKey[p.insured_name]
    return p.insured_name ? 'name:' + p.insured_name : 'unknown'
  }

  const byMember = {}
  for (const p of active) {
    const k = _policyKey(p)
    if (!byMember[k]) byMember[k] = { name: p.insured_name || '未署名', key: k, sums: {} }
    const cat = p.insurance_category || ''
    byMember[k].sums[cat] = (byMember[k].sums[cat] || 0) + (p.sum_assured || 0)
  }

  const cats = ['重疾险', '医疗险', '寿险', '意外险']
  // 全空家庭：members 与 policies 均无 → 单行声明，保证 AI 有矩阵依据可引用而非编造
  if (!Object.keys(byMember).length && !memberList.length) {
    return '## 保障缺口矩阵（系统预计算，review/analysis 直接引用结论，禁止自行重算或引用缺口金额）\n\n| 成员 | 险种 | 覆盖状态 | 依据 |\n|------|------|---------|------|\n| 全体 | - | ❌ 无任何保障 | 该家庭暂无任何保单，所有成员均无保障 |'
  }

  // P1-2：成员级收入口径（对齐前端 gap-engine 的 memIncome 计算）
  const pillar = memberList.find(m => m && /本人|经济支柱/.test(m.role || '')) || memberList[0] || null
  const _incomeOf = key => {
    const m = memberList.find(x => x && _memberKey(x) === key)
    if (!m) return { income: familyIncome, hasIncome: familyIncome > 0, estimated: true }
    const own = parseFloat(m.income) || 0
    if (own > 0) return { income: own, hasIncome: true, estimated: false }
    if (pillar && _memberKey(pillar) === key && familyIncome > 0) return { income: familyIncome, hasIncome: true, estimated: true }
    return { income: 0, hasIncome: false, estimated: false }
  }
  // 2026-09-10（P1-2 同源问题）：矩阵行改为「成员维度」主循环——前端 gap-engine 对每个成员（含名下无保单者）
  // 都逐险种输出缺口金额（无保单即 existing=0、缺口为全额），原实现只对有保单的成员输出逐险种行、无保单成员
  // 仅一行「无任何保障」概括 → AI 报告与页面矩阵信息粒度不一致（页面有具体金额，AI 只有笼统结论）。
  // 保单中未能匹配到任何成员者（insured_name 不在成员名单）仍单独成行，保证不丢数据。
  const memberRows = memberList.filter(Boolean).map(m => ({
    name: m.name || '成员',
    key: _memberKey(m),
    sums: (byMember[_memberKey(m)] && byMember[_memberKey(m)].sums) || {}
  }))
  for (const k of Object.keys(byMember)) {
    if (!memberList.some(m => m && _memberKey(m) === k)) memberRows.push({ name: byMember[k].name, key: k, sums: byMember[k].sums })
  }

  const lines = ['## 保障缺口矩阵（系统预计算，review/analysis 直接引用结论，禁止自行重算或引用缺口金额）', '', '| 成员 | 险种 | 覆盖状态 | 依据 |', '|------|------|---------|------|']
  for (const r of memberRows) {
    const inc = _incomeOf(r.key)
    for (const cat of cats) {
      const existing = yuanToWan(r.sums[cat] || 0)
      let ok = false, basis = ''
      if (cat === '重疾险') { ok = existing >= 50; basis = ok ? `已覆盖${existing}万(参考50万)` : `缺口：现有${existing}万<50万` }
      else if (cat === '医疗险') { ok = existing >= 100; basis = ok ? `已覆盖${existing}万(百万医疗及格线100万)` : `缺口：现有${existing}万<100万` }
      else {
        // 寿险/意外：收入缺失 → 无法计算（对齐前端 blocked，不再按 0 收入编造需求）
        if (!inc.hasIncome) {
          basis = (cat === '寿险' ? '寿险需求=负债+5×年收入' : '意外险需求=max(5×年收入,负债)') + '，该成员年收入缺失无法计算（待补全）'
          lines.push(`| ${r.name} | ${cat} | ⚠️ 无法计算 | ${basis} |`)
          continue
        }
        const est = inc.estimated ? '（个人收入缺失，按家庭年收入估算）' : ''
        if (cat === '寿险') { const need = Math.round(debt + 5 * inc.income); ok = existing >= need; basis = `需求=负债${debt}万+5×收入${inc.income}万=${need}万${est}，现有${existing}万` }
        else { const need = Math.round(Math.max(5 * inc.income, debt)); ok = existing >= need; basis = `需求=max(5×收入${inc.income}万,负债${debt}万)=${need}万${est}，现有${existing}万` }
      }
      lines.push(`| ${r.name} | ${cat} | ${ok ? '✅ 已覆盖' : '❌ 有缺口'} | ${basis} |`)
    }
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
