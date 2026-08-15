/**
 * v2-context — 场景化上下文组装（5 集合并行查询）
 *
 * 接口契约（v2）：
 *   - markdown:    AI 消费的主上下文（场景化裁剪）
 *   - familyMeta:  节流/引用用元数据（不暴露整个 family 记录，避免调用方依赖原始 schema）
 *   - birthMap:    派生数据 memberId → birth_date（保单年龄解析用，仅 report/tool 场景填充）
 *   - datasets:    场景化原始数据集（仅 report 场景暴露 facts/cashValues 给 _buildStructuredCoverage）
 *
 * 不再返回 raw 字段：调用方依赖原始集合记录结构 = 接口泄漏。
 * 派生数据由本模块统一计算，调用方只消费显式契约字段。
 */
const { calcAge } = require('./calc-age')
const { safeQuery, getFamily } = require('./db-helpers')
const { buildPortrait, renderPortraitMarkdown } = require('./familyPortrait')
const { yuanToWan } = require('./amount')

function _memberTable(members) {
  if (!members || members.length === 0) return ''
  // 先算所有人年龄，找本人作为推断基准
  const enriched = members.filter(m => m.status !== 'deleted').map(m => ({
    m, age: calcAge(m.birth_date) || 0
  }))
  const self = enriched.find(e => (e.m.role || '') === '本人')
  const selfAge = self ? self.age : 0
  // role 归一化：本人→经济支柱；家庭成员按与本人年龄差推断
  function _normRole(role, age) {
    if (role === '本人') return '经济支柱'
    if (['配偶', '子女', '父母', '经济支柱'].indexOf(role) !== -1) return role
    if (role === '家庭成员' && selfAge > 0) {
      const diff = age - selfAge
      if (diff >= 20) return '父母'
      if (diff <= -15) return '子女'
      if (Math.abs(diff) <= 15) return '配偶'
      return '其他'
    }
    return role || '其他'
  }
  const rows = ['| memberId | 姓名 | 角色 | 年龄 | 性别 | 健康 | 职业 | 个人年收入 |', '|----------|------|------|------|------|------|------|----------|']
  for (const e of enriched) {
    const m = e.m, age = e.age || '-'
    const role = _normRole(m.role || '-', e.age)
    const inc = m.income ? m.income + '万' : (m.income === 0 ? '0（待补全）' : '待补全')
    rows.push('|' + [m.member_id || m._id, m.name || '-', role, age, m.gender || '-', m.health || '-', m.occupation || '-', inc].join('|') + '|')
  }
  return rows.join('\n')
}

function _financeTable(finances, snap) {
  let income = '-', debt = '-', expense = '-', debtType = '-'
  if (finances && finances.length > 0) {
    const f = finances[0]
    // 数值审计 #2：finances 统一存元（annual_income/total_debt/fixed_annual_expense），此处 ÷10000 转万显示；
    // 兼容旧数据（income/debt/fixed_expense 万键直读）
    income = f.annual_income != null ? _wan(f.annual_income) : (f.income != null ? f.income : income)
    debt = f.total_debt != null ? _wan(f.total_debt) : (f.debt != null ? f.debt : debt)
    expense = f.fixed_annual_expense != null ? _wan(f.fixed_annual_expense) : (f.fixed_expense != null ? f.fixed_expense : expense)
    debtType = f.debt_type || debtType
  }
  // financial_snapshot 优先级更高（与前端 dataQuery/getFamily 口径一致）
  if (snap) {
    if (snap.income) income = snap.income
    if (snap.debt) {
      const d = typeof snap.debt === 'object' ? snap.debt : { amount: snap.debt }
      debt = d.amount != null ? d.amount : debt
      debtType = d.type || debtType
    }
  }
  if (income === '-' && debt === '-' && expense === '-' && debtType === '-') return ''
  const rows = ['| 年收入(万) | 总负债(万) | 固定支出(万) | 负债类型 |', '|--------|--------|----------|----------|']
  rows.push('|' + [income, debt, expense, debtType].join('|') + '|')
  return rows.join('\n')
}

/** 元 → 万（数值审计 #1/#2 共用，round 到 2 位防浮点噪音；换算核心走金额契约 amount.js） */
function _wan(v) {
  const n = Number(v)
  return isNaN(n) ? '-' : yuanToWan(n)
}

/**
 * 派生 familyMeta — 仅暴露节流/引用/财务快照字段，不泄露整个 family 记录
 */
function _deriveFamilyMeta(family) {
  if (!family) return null
  return {
    family_id: family._id,
    family_name: family.family_name || '',
    last_analysis_at: family.last_analysis_at || null,
    last_summary: family.last_summary || '',
    last_conclusion: family.last_conclusion || '',
    financial_snapshot: family.financial_snapshot || null,
    engagement_stage: family.engagement_stage || ''
  }
}

/**
 * 派生 birthMap — memberId → birth_date，供保单年龄解析用
 */
function _deriveBirthMap(members) {
  const map = new Map()
  for (const m of (members || [])) {
    if (m.birth_date) map.set(m.member_id || m._id, m.birth_date)
  }
  return map
}

/**
 * @param {object} db - cloud.database()
 * @param {string} familyId
 * @param {string} openid
 * @param {string} scene - list | conversation | analysis | report | tool
 * @returns {{
 *   markdown: string,
 *   familyMeta: object|null,
 *   birthMap: Map<string, string>,
 *   datasets: { facts?: array, cashValues?: array, members?: array, finances?: array }
 * }}
 */
async function buildFamilyContext(db, familyId, openid, scene) {
  // 基础层：所有场景加载
  const [family, members, finances] = await Promise.all([
    getFamily(db, familyId, openid).then(f => f || {}),
    safeQuery(db, 'members', { family_id: familyId }, openid).then(r => r.data || []),
    safeQuery(db, 'finances', { family_id: familyId }, openid).then(r => r.data || [])
  ])
  const familyMeta = _deriveFamilyMeta(family)
  const birthMap = _deriveBirthMap(members)
  // datasets 按场景填充：默认空，仅场景需要时暴露原始数据集
  const datasets = {}

  if (scene === 'list') {
    // 首页：仅展示成员名+角色
    return {
      markdown: _memberTable(members.map(m => ({ _id: m._id, member_id: m.member_id, name: m.name, role: m.role }))),
      familyMeta,
      birthMap,
      datasets
    }
  }

  const parts = []
  parts.push('# 家庭保障档案')
  // last_conclusion 注入：conversation/tool 场景用带标签结论块（AI 识别为可引用回答缺口问题），其余场景保留裸 quote
  if (scene !== 'conversation' && scene !== 'tool' && family.last_conclusion) parts.push('> ' + family.last_conclusion + '\n')

  // 经济状况表始终注入（家庭级年收入/负债，画像不覆盖）
  const ft = _financeTable(finances, family.financial_snapshot)
  if (ft) parts.push('## 经济状况\n' + ft)

  if (scene === 'conversation') {
    // Phase 2：读统一画像（精简版）；画像已聚合全部 active facts，无需重复回流原始三元组
    const [facts] = await Promise.all([
      safeQuery(db, 'facts', { family_id: familyId, status: 'active' }, openid).then(r => r.data || [])
    ])
    const portrait = buildPortrait(members, facts)
    const pm = renderPortraitMarkdown(portrait, { compact: true })
    if (pm) parts.push(pm)
    // 报告结论带标签注入（审计改法 3）：A 通道据此回答缺口类问题（"上次检视"标注防 stale 误导）
    if (family.last_conclusion) parts.push('## 报告结论（上次检视，回答缺口类问题可引用）\n' + family.last_conclusion)
    return { markdown: parts.join('\n\n'), familyMeta, birthMap, datasets }
  }

  if (scene === 'report') {
    // Phase 2：统一画像取代「保单列表 + 全部事实」两张表
    // 成员表已由画像覆盖（画像已合并 members 表字段，B3 以 facts 为准），不再单独渲染原始成员表
    const [facts, cashValues] = await Promise.all([
      safeQuery(db, 'facts', { family_id: familyId, status: 'active' }, openid).then(r => r.data || []),
      safeQuery(db, 'policy_cash_values', { family_id: familyId, matched: true }, openid).then(r => r.data || [])
    ])
    // report 场景业务逻辑（_buildStructuredCoverage）需要 facts/cashValues 原始数据集
    datasets.facts = facts
    datasets.cashValues = cashValues
    // prompt 工程审计：缺口矩阵需识别"无保单成员"，暴露 members
    datasets.members = members
    const portrait = buildPortrait(members, facts)
    const pm = renderPortraitMarkdown(portrait, { compact: false })
    if (pm) parts.push(pm)
    if (cashValues && cashValues.length > 0) {
      parts.push('## 保单现价数据\n')
      for (const cv of cashValues) {
        const latest = cv.cash_values && cv.cash_values[cv.cash_values.length - 1]
        const cvRows = (cv.cash_values || []).slice(0, 5).map(r => `  ${r.y}年: ${r.v}元`).join('\n')
        parts.push(`- ${cv.product_name || '未知产品'}（${cv.insured_name || '-'}）：第${cv.total_years || 0}年现价 ${latest?.v || 0}元`)
        if ((cv.cash_values || []).length > 5) parts.push(`  （共${cv.cash_values.length}行，前5行:）\n${cvRows}\n  ...`)
        else if (cvRows) parts.push(`\n${cvRows}`)
      }
    }
    return { markdown: parts.join('\n\n'), familyMeta, birthMap, datasets }
  }

  if (scene === 'tool') {
    // conversationAI 工具上下文专用：画像 + 原始成员表（冲突检测用）+ 财务表 + 报告结论摘要
    // 复用 v2-context 内部已查询的 members/finances，避免 conversationAI 重复查询
    const [facts] = await Promise.all([
      safeQuery(db, 'facts', { family_id: familyId, status: 'active' }, openid).then(r => r.data || [])
    ])
    const portrait = buildPortrait(members, facts)
    const pm = renderPortraitMarkdown(portrait, { compact: true })
    if (pm) parts.push(pm)
    // 工具上下文需要"未合并的成员表"用于冲突检测（与画像视图互补）
    const activeMembers = (members || []).filter(m => m.status !== 'deleted')
    const mt = _memberTable(activeMembers)
    if (mt) parts.push('## 成员数据（冲突检测用）\n' + mt)
    // 报告结论摘要（供 AI 引用，禁止照抄）
    if (familyMeta) {
      const sumParts = []
      if (familyMeta.last_summary) sumParts.push('**摘要**：' + familyMeta.last_summary)
      if (familyMeta.last_conclusion) sumParts.push('**结论**：' + familyMeta.last_conclusion)
      if (sumParts.length > 0) parts.push('## 报告结论（供引用，禁止照抄）\n' + sumParts.join('\n'))
    }
    // 暴露 members/finances 给 conversationAI 复用（避免重复查询）
    datasets.members = activeMembers
    datasets.finances = finances
    return { markdown: parts.join('\n\n'), familyMeta, birthMap, datasets }
  }

  // 默认（analysis 等未明确场景）：仅基础 markdown
  return { markdown: parts.join('\n\n'), familyMeta, birthMap, datasets }
}

module.exports = { buildFamilyContext }
