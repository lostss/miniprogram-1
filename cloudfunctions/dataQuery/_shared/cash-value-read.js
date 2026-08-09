/**
 * cash-value-read — 现金价值表读取接缝（保障节点回本计算数据源）
 *
 * policy_cash_values 集合：{ family_id, _openid, policy_id, product_name, cash_values: [{y,v}], latest_value, matched }
 * 只返回 matched=true 且投影最小字段（减 getFamily 响应体）。
 */
async function loadCashValues(db, familyId, openid) {
  const res = await db.collection('policy_cash_values')
    .where({ family_id: familyId, _openid: openid, matched: true })
    .field({ policy_id: true, product_name: true, cash_values: true })
    .limit(100)
    .get()
  return (res && res.data) || []
}

module.exports = { loadCashValues }
