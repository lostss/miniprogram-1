/**
 * cash-value-matcher — 现价表与保单双向懒匹配（dataWrite 内部模块）
 *
 * 架构审计第 10 轮：从 cloudfunctions/_shared/ 迁移至 dataWrite 同级目录。
 *   原因：仅 dataWrite/policy-write.js 引用，单调用方不应占用 _shared 心智模型。
 *
 * 架构审计第 13 轮候选 #2 + #3：
 *   - 删除 fixStaleCashValueRefs 死代码（已被 matchOrphanCashValues 取代，零调用方）
 *   - matchOrphanCashValues 内的 4 处裸 db.collection().update() 改走 writeSeam 接缝，
 *     恢复 updated_at 审计字段注入 + markFamilyMutated 钩子（insight_stale 自动标记）
 *
 * 策略：无论上传顺序，写入端触发匹配扫描
 *   - 现价表入库 → matchCashToPolicies（查已有保单）
 *   - 保单入库   → matchOrphanCashValues（查未匹配现价表）
 */
const { writeSeam } = require('./_shared/writeSeam')
const { logOperation } = require('./_shared/logSeam')

/** 产品名模糊匹配：去括号/公司后缀/空格，取前8字核心名称 */
function _fuzzyProductName(s1, s2) {
  const clean = s => (s || '')
    .replace(/[（(].*$/, '')
    .replace(/(保险|股份|有限|分公司|公司)/g, '')
    .replace(/\s+/g, '')
    .substring(0, 8)
  return clean(s1) === clean(s2)
}

/**
 * 现价表匹配保单
 * @param {object} db
 * @param {string} familyId
 * @param {string} openid
 * @param {object} cashDoc - { product_name, insured_name, policy_number }
 * @returns {{ policyId: string|null, matched: boolean, candidates: array }}
 */
async function matchCashToPolicies(db, familyId, openid, cashDoc) {
  const policies = db.collection('policies')
  const base = { family_id: familyId, _openid: openid }

  // 1. 保单号精确匹配
  if (cashDoc.product_name && cashDoc.policy_number) {
    const res = await policies.where({ ...base, policy_number: cashDoc.policy_number, product_name: cashDoc.product_name }).get()
    if (res.data && res.data.length === 1) {
      return { policyId: res.data[0].id, matched: true, candidates: [] }
    }
  }

  // 2. 产品名 + 被保人模糊匹配
  if (cashDoc.product_name && cashDoc.insured_name) {
    const res = await policies
      .where({ ...base, insured_name: cashDoc.insured_name })
      .get()
    const matched = (res.data || []).filter(p => _fuzzyProductName(p.product_name, cashDoc.product_name))
    if (matched.length === 1) {
      return { policyId: matched[0].id, matched: true, candidates: [] }
    }
    if (matched.length > 1) {
      logOperation(db, {
        openid, familyId, action: 'match_cash_value',
        result: { status: 'fail', summary: '现价表匹配多候选歧义' },
        meta: { product_name: cashDoc.product_name, insured_name: cashDoc.insured_name, matchCount: matched.length }
      }).catch(() => {})
      return { policyId: null, matched: false, candidates: matched.map(p => ({
        policy_id: p.id, product_name: p.product_name || '', insured_name: p.insured_name || '',
        category: p.insurance_category || ''
      })) }
    }
  }

  // 3. 未匹配 → 返回长期险候选列表（供手动选择），记录日志
  logOperation(db, {
    openid, familyId, action: 'match_cash_value',
    result: { status: 'fail', summary: '现价表未匹配到保单' },
    meta: { product_name: cashDoc.product_name, insured_name: cashDoc.insured_name, policy_number: cashDoc.policy_number }
  }).catch(() => {})
  const all = await policies.where(base).get()
  const longTerm = (all.data || []).filter(p =>
    ['寿险', '重疾', '年金'].includes(p.insurance_category || '')
  )
  return {
    policyId: null, matched: false,
    candidates: longTerm.map(p => ({
      policy_id: p.id, product_name: p.product_name || '', insured_name: p.insured_name || '',
      category: p.insurance_category || ''
    }))
  }
}

/**
 * 保单入库后反向匹配孤儿现价表
 *
 * 架构审计第 13 轮候选 #3：所有写入经 writeSeam.silentUpdateDoc/silentUpdateWhere，
 * 末尾统一 triggerHooks 触发 markFamilyMutated（insight_stale=true 让报告自动重生成）。
 *
 * @param {object} db
 * @param {string} familyId
 * @param {string} openid
 * @param {Array} newPolicies - 本次写入的保单
 */
async function matchOrphanCashValues(db, familyId, openid, newPolicies) {
  const cashColl = db.collection('policy_cash_values')
  const orphans = await cashColl.where({ family_id: familyId, _openid: openid, matched: false }).get()
  if (!orphans.data || !orphans.data.length) return

  const ws = writeSeam(db, openid, familyId)
  let matchedCount = 0

  for (const cash of orphans.data) {
    let matched = null

    // 保单号精确
    if (cash.policy_number) {
      matched = newPolicies.find(p => p.policy_number === cash.policy_number)
    }
    // 产品名 + 被保人模糊
    if (!matched && cash.product_name && cash.insured_name) {
      matched = newPolicies.find(p =>
        p.insured_name === cash.insured_name && _fuzzyProductName(p.product_name, cash.product_name)
      )
    }

    if (matched) {
      // 经 writeSeam.silentUpdateDoc：自动注入 _openid 校验 + updated_at
      await ws.silentUpdateDoc('policy_cash_values', cash._id, {
        policy_id: matched.id, matched: true, matched_by: 'auto', matched_at: new Date()
      })
      // 经 writeSeam.silentUpdateWhere：自动注入 _openid + updated_at
      await ws.silentUpdateWhere('policies', { id: matched.id }, {
        cash_value_available: true,
        latest_cash_value: cash.cash_values[cash.cash_values.length - 1]?.v || 0
      })
      matchedCount++
    }
  }

  // 任意匹配成功 → 标记家庭脏数据（报告需重生成）
  if (matchedCount > 0) await ws.triggerHooks()
}

module.exports = { matchCashToPolicies, matchOrphanCashValues }
