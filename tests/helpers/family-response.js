/**
 * family-response — 「getFamily / getSharedFamily 响应形状」的测试工厂（唯一出口）。
 *
 * 为什么存在（流程审计 2026-09-18 P1-3 的机制修复）：
 *   报告类测试此前**各自手写 fixture 仿造** getFamily 的返回形状。其中一份缺了 `family_income`
 *   兼容字段（真实 API 会补 `fs.income || 0`），于是：
 *     - 生产：前端拿到 `family_income = 0` → 把"缺失"当"已填"
 *     - 测试：fixture 没有该字段 → 前端拿到 undefined → 判成"未填"
 *   两边形状不同 → 「测试全绿、线上恒失效」的接线缺陷上线。
 *
 * 本工厂的关键不是"多写几个默认字段"，而是**直接复用生产实现** `applyFamilyCompat`
 * （云函数 getFamilyDetail / getSharedFamily 同款）→ 只要生产形状变了，fixture 立刻同步变，
 * 不可能再出现"测试的响应 ≠ 真实的响应"。
 *
 * 用法：
 *   const { familyResponse } = require('./helpers/family-response')
 *   mockGetCustomer(familyResponse({ members: [...], policies: [...] }))
 *
 * 参数 doc 可含：family_name / members / policies / cashValues / unmatchedCashValues /
 *   financial_snapshot / readiness_tier / report（后者为便捷直给；真实响应由 last_* 派生）
 */
const { applyFamilyCompat } = require('../../cloudfunctions/_shared/family-compat')
const { toReadReport } = require('../../cloudfunctions/_shared/report-fields')

/** 构造 getFamily 风格响应 data：先聚合子集合、再挂 report、最后补兼容字段（与 handler 同序） */
function familyResponse(doc) {
  const src = doc || {}
  const f = Object.assign({ _id: 'cid', family_name: 't', members: [], policies: [] }, src)
  f.policies = f.policies || []
  f.cashValues = f.cashValues || []
  f.unmatchedCashValues = f.unmatchedCashValues || []
  f.report = src.report || toReadReport(f)
  return applyFamilyCompat(f)
}

module.exports = { familyResponse }
