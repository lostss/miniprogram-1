/**
 * _shared/readiness.js — 保障分析前置检查（readiness，2026-08；tier 语义改造 2026-09-06）
 *
 * 纯函数。输入契约对齐 reportAI 入口现成数据：
 *   familyMeta: ctx.familyMeta（保留契约位，本版不消费财务）
 *   members:    ctx.datasets.members（原始成员，age 按 calcAgeYears 口径推导）
 *   finances:   ctx.datasets.finances（原始 finances 文档数组，判"有无"不判"多少"，零数值转换零漂移）
 *   policies:   loadActivePolicies 输出（已滤软删）
 *
 * tier 语义（活报告模型）：
 *   blocked   = 事实层缺失（无成员/支柱缺年龄/无保单）→ 不可生成，422
 *   degraded  = 量化锚点（家庭年收入且无成员收入）缺失 → 放行，产出定性分析（不含量化测算）
 *   ok        = 可量化（warn 项仅降质，不降档）
 *
 * 输出契约：{ ready, blockers, warnings, hasBlockers, dimensions, tier, tierReason, missing }
 *   missing = 非阻断缺失清单（warn/degraded 级）{field,label,fix}，单一事实源，
 *             供 AI 上下文 / 对话采集钩子 / 报告待澄清项同源消费。
 */
const { calcAgeYears } = require('./calc-age')

function _ageOf(m) {
  return m.age || (m.birth_date ? calcAgeYears(m.birth_date) : null)
}

function _dimStatus(items) {
  if (items.some(i => i.severity === 'block')) return 'block'
  if (items.length > 0) return 'warn'
  return 'ok'
}

function evaluateReadiness({ familyMeta, members, finances, policies }) {
  const blockers = []
  const warnings = []
  const missing = []
  const memberItems = []
  const financeItems = []
  const coverageItems = []

  const activeMs = (Array.isArray(members) ? members : []).filter(m => m.status !== 'deleted')
  const ps = Array.isArray(policies) ? policies : []
  // finances 集合唯一真相源；新旧键兼容：元键 annual_income 等 / 旧万键 income 等
  const fin = (Array.isArray(finances) && finances[0]) || {}

  // ---- 成员维度 ----
  if (activeMs.length === 0) {
    blockers.push('请先添加家庭成员')
    memberItems.push({ field: 'members', label: '尚未添加家庭成员', severity: 'block', fix: { mode: 'addMember' } })
  } else {
    for (const m of activeMs) {
      const name = m.name || '未命名成员'
      const isPillar = m.role === '本人' || m.role === '经济支柱'
      const mid = m.member_id || m._id
      if (_ageOf(m) == null) {
        memberItems.push({ field: 'member.' + name + '.age', label: name + '缺年龄', severity: isPillar ? 'block' : 'warn', fix: { mode: 'member', id: mid } })
        if (isPillar) blockers.push('经济支柱「' + name + '」缺年龄，风险分层失锚')
        else {
          warnings.push('成员「' + name + '」缺年龄')
          missing.push({ field: 'member.' + name + '.age', label: name + '缺年龄', fix: { mode: 'member', id: mid } })
        }
      }
      // 2026-09-19 修（流程审计 P2-1 后半）：这三项原先只进 warnings/missing，**不进 dimensions.items**
      // → 弹层写着「N 个建议」但可操作行数少于 N（用户找不到该补什么）。
      // 现与 age 同规则进 items（severity=warn），使「计数」与「清单」同源。
      if (!m.gender) {
        warnings.push('成员「' + name + '」缺性别')
        memberItems.push({ field: 'member.' + name + '.gender', label: name + '缺性别', severity: 'warn', fix: { mode: 'member', id: mid } })
        missing.push({ field: 'member.' + name + '.gender', label: name + '缺性别', fix: { mode: 'member', id: mid } })
      }
      if (!m.occupation) {
        warnings.push('成员「' + name + '」缺职业')
        memberItems.push({ field: 'member.' + name + '.occupation', label: name + '缺职业', severity: 'warn', fix: { mode: 'member', id: mid } })
        missing.push({ field: 'member.' + name + '.occupation', label: name + '缺职业', fix: { mode: 'member', id: mid } })
      }
      if (!m.health) {
        warnings.push('成员「' + name + '」缺健康信息')
        memberItems.push({ field: 'member.' + name + '.health', label: name + '缺健康信息', severity: 'warn', fix: { mode: 'member', id: mid } })
        missing.push({ field: 'member.' + name + '.health', label: name + '缺健康信息', fix: { mode: 'member', id: mid } })
      }
    }
  }

  // ---- 财务维度 ----
  const hasFamilyIncome = fin.annual_income != null || fin.income != null
  const hasMemberIncome = activeMs.some(m => m.income != null && Number(m.income) > 0)
  // 量化锚点缺失（degraded）：无家庭收入且无成员收入 → 降档不阻断（放行定性分析）
  const incomeAnchorMissing = !hasFamilyIncome && !hasMemberIncome
  if (!hasFamilyIncome) {
    financeItems.push({ field: 'finance.annual_income', label: '家庭年收入未填写', severity: 'warn', degraded: incomeAnchorMissing, fix: { mode: 'financials' } })
    missing.push({ field: 'finance.annual_income', label: '家庭年收入未填写', fix: { mode: 'financials' } })
    warnings.push(incomeAnchorMissing ? '家庭年收入未填写（量化测算受限，可先行生成定性分析）' : '家庭年收入未填写（已有成员收入可部分推导）')
  }
  if (!(fin.total_debt != null || fin.debt != null)) {
    warnings.push('总负债未填写')
    financeItems.push({ field: 'finance.total_debt', label: '家庭总负债未填写', severity: 'warn', fix: { mode: 'financials' } })
    missing.push({ field: 'finance.total_debt', label: '家庭总负债未填写', fix: { mode: 'financials' } })
  }
  // 2026-09-12 字段治理：固定支出检查已移除——该字段不参与任何计算或结论，
  // 仅让用户被建议去补一个不影响结果的值（见 v2-context/_missingInfo 同步清理）
  // 2026-09-19 字段治理（流程审计 P2-1）：**年度保费预算检查已移除**，与 2026-09-12 移除「固定支出」
  // 同一理由——该字段不参与任何计算或结论（全仓检索：无消费方，仅写入 + 被本函数提示），
  // 却把用户引向一个补不了的字段（编辑 Sheet 无输入项）→ 任务死路。
  // 字段本身仍保留：对话「年保费预算20万」经 member-write.FIN_SYNC 可正常落库。
  // 若将来确实要采集，应连同"消费它的计算/结论"一起加，而不是先加提示。
  // 【2026-09-20 产品确认】维持现状（不加输入项、不删字段）：字段继续可经对话落库，但不主动提示。
  // 若将来要做「预算 vs 实际保费」这类消费方，再连同输入项与单位口径一起加。
  // （原实现：warnings / missing / financeItems 各推一条"年度保费预算未填写"）

  // ---- 保障维度 ----
  if (ps.length === 0) {
    blockers.push('请先添加保单（无有效保障可分析）')
    coverageItems.push({ field: 'policies', label: '无有效保单', severity: 'block', fix: { mode: 'upload' } })
  } else {
    for (const p of ps) {
      const pname = p.product_name || p.policy_name || '未命名保单'
      const pid = p._id || p.id
      if (!p.sum_assured) {
        warnings.push('保单「' + pname + '」缺保额')
        coverageItems.push({ field: 'policy.' + pname + '.sum_assured', label: pname + '缺保额', severity: 'warn', fix: { mode: 'policy', id: pid } })
        missing.push({ field: 'policy.' + pname + '.sum_assured', label: pname + '缺保额', fix: { mode: 'policy', id: pid } })
      }
      if (!p.member_id && !p.insured_name) {
        warnings.push('保单「' + pname + '」缺被保人')
        coverageItems.push({ field: 'policy.' + pname + '.insured', label: pname + '缺被保人', severity: 'warn', fix: { mode: 'policy', id: pid } })
        missing.push({ field: 'policy.' + pname + '.insured', label: pname + '缺被保人', fix: { mode: 'policy', id: pid } })
      }
    }
  }

  const hasBlockers = blockers.length > 0
  const tier = hasBlockers ? 'blocked' : (incomeAnchorMissing ? 'degraded' : 'ok')

  return {
    ready: !hasBlockers,
    blockers: Array.from(new Set(blockers)),
    warnings: Array.from(new Set(warnings)),
    hasBlockers,
    tier,
    tierReason: tier === 'degraded' ? '家庭年收入未填写（量化测算受限）' : '',
    missing,
    dimensions: [
      { key: 'members', label: '家庭成员', status: _dimStatus(memberItems), items: memberItems },
      { key: 'finance', label: '家庭财务', status: _dimStatus(financeItems), items: financeItems },
      { key: 'coverage', label: '已有保障', status: _dimStatus(coverageItems), items: coverageItems }
    ]
  }
}

module.exports = { evaluateReadiness }
