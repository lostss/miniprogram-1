/**
 * family-compat.js — getFamily / getSharedFamily 响应中「向后兼容字段」的单一事实源。
 *
 * 为什么存在（流程审计 2026-09-18 P1-3 的机制修复）：
 *   报告页读 `c.name` / `c.debt` / `c.family_income`，但这三个都**不是 families 文档的原生字段**：
 *     - families 存 `family_name`，`name` 是读取时补的
 *     - 财务在 `financial_snapshot`（含万口径的 `income`），`family_income` 是补的兼容键
 *   原先这段合成分别写在 `dataQuery/family-detail.js` 与 `dataQuery/share.js` 两处，
 *   而测试各自手写 fixture 仿造响应形状 —— 其中一份 fixture 缺 `family_income`，
 *   于是「前端按合成后的形状重推 tier、后端按原始形状判定」的不一致**在全绿测试下上了线**
 *   （缺失收入被 `|| 0` 抹平 ⇒ 前端恒判 ok、定性模式披露永不出现）。
 *
 * 现抽为唯一实现，三方共用：
 *   - `dataQuery/family-detail.js`（owner 读）
 *   - `dataQuery/share.js`（客户版读，合成后再脱敏）
 *   - `tests/helpers/family-response.js`（测试工厂 —— 复用同一函数，fixture 无法再漂移）
 *
 * 注意：`family_income` 的 `|| 0` 是**兼容层语义**（前端多处按"0 即未填"消费不了），
 * 它会把"缺失"与"显式填 0"抹平。需要区分二者的场景（如定性模式判定）**必须读原始字段**
 * （`financial_snapshot.income` 或 reportAI 落库的 `readiness_tier`），不要依赖本函数的结果。
 */

/** 补齐前端依赖的向后兼容字段（原地修改并返回 family；family 为空时原样返回） */
function applyFamilyCompat(family) {
  if (!family) return family
  const fs = family.financial_snapshot || {}
  if (!family.debt) family.debt = fs.debt || { amount: 0, type: '' }
  if (family.family_income == null) family.family_income = fs.income || 0
  if (!family.name) family.name = family.family_name || ''
  return family
}

module.exports = { applyFamilyCompat }
