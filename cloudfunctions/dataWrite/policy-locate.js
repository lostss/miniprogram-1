/**
 * policy-locate — 保单三级定位接缝
 *
 * 按 policyId → policy_number → product_name+insured_name 顺序回退定位保单。
 *
 * 接口：
 *   locatePolicy(db, openid, familyId, opts) → Promise<policy | null>
 *     opts.policyId        精确 ID 定位（优先级 1）
 *     opts.policy_number   保单号定位（优先级 2）
 *     opts.product_name    产品名定位（优先级 3，配合 insured_name 过滤）
 *     opts.insured_name    被保人姓名（仅 product_name 层级生效）
 *     opts.excludeDeleted  默认 false，与 deletePolicy 语义一致（允许重新定位已 deleted 的）
 *                          true 时各层级查询都过滤 status='deleted'（与 updatePolicy 语义一致）
 *
 * 架构审计第 16 轮候选 #3：deletePolicy + updatePolicy 12 行 × 2 份的
 * 三级回退定位模式集中到本接缝。定位不变量（_openid 注入 + 三级回退 +
 * insured_name 过滤）集中在一处。
 *
 * 注意：product_name 层级在 excludeDeleted=false 时，仍会优先选择非 deleted
 * 的保单（与 deletePolicy 原逻辑一致，避免重复软删）。
 */
async function locatePolicy(db, openid, familyId, opts = {}) {
  const { policyId, policy_number, product_name, insured_name, excludeDeleted = false } = opts
  const baseWhere = { family_id: familyId, _openid: openid }
  if (excludeDeleted) {
    baseWhere.status = db.command.neq('deleted')
  }

  // 优先级 1：policyId 精确定位
  if (policyId) {
    const r = await db.collection('policies').where({ ...baseWhere, id: policyId }).limit(1).get()
    if (r.data && r.data.length) return r.data[0]
  }

  // 优先级 2：policy_number 定位
  if (policy_number) {
    const r = await db.collection('policies').where({ ...baseWhere, policy_number }).limit(1).get()
    if (r.data && r.data.length) return r.data[0]
  }

  // 优先级 3：product_name + insured_name 模糊定位
  if (product_name) {
    const r = await db.collection('policies').where({ ...baseWhere, product_name }).limit(20).get()
    const list = (r.data || []).filter(p => !insured_name || p.insured_name === insured_name)
    if (list.length) {
      // deletePolicy 兼容：即使 excludeDeleted=false，仍优先选非 deleted 的（避免重复软删）
      if (!excludeDeleted) {
        return list.find(p => p.status !== 'deleted') || list[0]
      }
      return list[0]
    }
  }

  return null
}

module.exports = { locatePolicy }
