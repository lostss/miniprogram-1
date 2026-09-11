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

/**
 * 待关联现价表（matched=false）——供报告页「待关联」入口展示（2026-09-11）。
 * 背景：自动匹配（产品名模糊 + 被保人）不中的现价表会永久停在 matched=false，
 * 而报告只读 matched:true → 数据在库里但从不展示、用户也无从补救。
 * 投影最小字段：只需辨识用（产品名/被保人/保单号）+ 一份人工选择所需的信息。
 */
async function loadUnmatchedCashValues(db, familyId, openid) {
  const res = await db.collection('policy_cash_values')
    .where({ family_id: familyId, _openid: openid, matched: false })
    .field({ _id: true, product_name: true, insured_name: true, policy_number: true, total_years: true, latest_value: true })
    .limit(50)
    .get()
  return (res && res.data) || []
}

module.exports = { loadCashValues, loadUnmatchedCashValues }
