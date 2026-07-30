/**
 * _shared/completeness.js — 统一完整度算法
 */
function calcCompletenessScore(family, policiesOverride) {
  const members = family.members || []
  const policies = policiesOverride || []
  const fs = family.financial_snapshot || {}
  let score = 0
  if (members.length > 0) { score += 20; const completeMembers = members.filter(m => m.name && m.role && m.gender && m.age).length; if (completeMembers === members.length) score += 20 }
  if (policies.length > 0) score += 20
  if (fs.income) score += 15
  if (fs.debt && fs.debt.amount) score += 15
  if (fs.fixed_expense) score += 10
  return Math.min(100, score)
}

module.exports = { calcCompletenessScore }
