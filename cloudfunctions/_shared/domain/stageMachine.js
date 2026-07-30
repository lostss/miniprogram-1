/**
 * domain/stageMachine — 纯函数，零依赖
 * 评估当前阶段 → 返回下一个阶段
 */
const STAGES = ['onboarding', 'profiling', 'analyzing', 'reporting']

function evaluateStage(family, policyCount) {
  const current = family.engagement_stage || 'onboarding'
  if (current === 'reporting') return current  // manual only

  if (current === 'onboarding' && policyCount >= 1) return 'profiling'
  if (current === 'profiling') {
    const score = family.completeness_score || 0
    if (score >= 80) return 'analyzing'
  }
  return current
}

module.exports = { STAGES, evaluateStage }
