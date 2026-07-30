/**
 * policyToFacts — 将一条保单记录拆解为结构化三元组（facts）。
 *
 * 架构审计第 13 轮候选 #6：从 _shared 迁至 dataWrite/。
 * 仅 dataWrite/policy-write.js 调用，伪共享清理后避免被 sync-shared 同步到不需要的云函数。
 *
 * 设计要点：
 * - subject 支持两类图节点：member（被保人/投保人）、policy（保单自身）
 * - predicate 用语义化封闭集：保单结构天然适合封闭谓词，便于报告确定性消费，
 *   与对话路径的开放谓词（目的驱动）互补
 * - confidence 透传 OCR 真实置信度（非硬编码 1.0）；表单写入 confidence=0 视作用户确认→按 1 处理
 * - 纯函数、无 db 依赖，返回 addFact 可直接消费的事件数组
 *
 * @param {Object} policy 保单文档（含 id / product_name / insurance_category / ...）
 * @param {Object} opts { memberId, memberName, confidence, source }
 * @returns {Array} addFact 事件数组
 */
function formatAmount(amount) {
  if (amount == null || amount === '') return '待确认'
  const n = Number(amount)
  if (!isFinite(n)) return String(amount)
  if (n >= 10000) {
    const wan = n / 10000
    return `${Number.isInteger(wan) ? wan : wan.toFixed(1)}万`
  }
  return `${n}元`
}

function policyToFacts(policy, opts = {}) {
  const { memberId = '', memberName = '', confidence, source = 'ocr' } = opts
  const id = policy.id || policy._id || ''
  if (!id || !policy.product_name) return []

  const productRef = `${policy.product_name}(${String(id).slice(-6)})`
  const conf = (typeof confidence === 'number' && confidence > 0) ? confidence : 1

  const facts = []

  // 被保人拥有这份保障（member → policy）
  if (memberId && memberName) {
    facts.push({
      subjectType: 'member', subjectId: memberId, subjectName: memberName,
      predicate: '拥有保障', objectType: 'policy', objectId: id, objectValue: productRef,
      source, confidence: conf
    })
  }

  // 保单节点自身属性（policy → literal）
  const lit = (predicate, value) => {
    if (value == null || value === '') return
    facts.push({
      subjectType: 'policy', subjectId: id, subjectName: productRef,
      predicate, objectType: 'literal', objectValue: String(value),
      source, confidence: conf
    })
  }
  lit('险种', policy.insurance_category)
  if (policy.sum_assured) lit('保额', formatAmount(policy.sum_assured))
  if (policy.annual_premium) lit('年缴保费', formatAmount(policy.annual_premium))
  lit('生效日', policy.effective_date)
  lit('保障期间', policy.insurance_period)
  lit('缴费期', policy.payment_period)
  lit('缴费方式', policy.payment_method)
  lit('特殊条款', policy.special_agreement)
  lit('承保公司', policy.insurer)
  lit('保单号', policy.policy_number)

  // 投保人（不同于被保人时）
  if (policy.policyholder_name && memberName && policy.policyholder_name !== memberName) {
    facts.push({
      subjectType: 'member', subjectId: '', subjectName: policy.policyholder_name,
      predicate: '投保', objectType: 'policy', objectId: id, objectValue: productRef,
      source, confidence: conf
    })
  }

  return facts
}

module.exports = { policyToFacts, formatAmount }
