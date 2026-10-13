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
  // 2026-09-12 字段治理：固定支出/年支出已从数据模型移除（不参与任何计算/结论，仅制造待补全项），
  // 其原占 10 分权重一并删除。满分由 100 调整为 90（40 成员 + 20 保单 + 15 收入 + 15 负债），
  // stageMachine 的 80 分阈值仍可达，但不再由无用字段凑分。
  return Math.min(100, score)
}

module.exports = { calcCompletenessScore }
