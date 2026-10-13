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
// 2026-09-22 全面审计 P2-6：operation_logs.meta 脱敏（保单号/被保人姓名不得明文留存 90 天）
const { desensitize } = require('./_shared/pii-rules')

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
  // 2026-09-22 全面审计 P2：所有匹配查询都必须排除软删保单。
  // deletePolicy 只置 status:'deleted'，原实现不过滤 → 已删保单仍可能被现价表**重新匹配**并回写
  // cash_value_available / latest_cash_value（policy-write.js 的自动匹配路径），
  // 候选列表也会把已删保单展示给用户。注意同文件 linkCashValue 是显式挡 deleted 的，此处对齐。
  const base = { family_id: familyId, _openid: openid, status: db.command.neq('deleted') }

  // 0. 同图直连（2026-09-12）：mixed 图（保单正页 + 现价表同屏）提取的现价表携带来源保单键
  //    （ocr-core.extractOne 写入 from_policy）。同图是比"产品名模糊"更强的信号——
  //    模糊匹配可能命中同被保人的同系列产品，而同图必然是同一份合同。
  //    多候选/未命中时**不武断**，继续走下方通用匹配（保持既有行为）。
  const fp = cashDoc.from_policy
  if (fp && (fp.policy_number || (fp.product_name && fp.insured_name))) {
    let hits = []
    if (fp.policy_number) {
      const r = await policies.where({ ...base, policy_number: fp.policy_number }).get()
      hits = r.data || []
    }
    if (!hits.length && fp.product_name && fp.insured_name) {
      const r = await policies.where({ ...base, insured_name: fp.insured_name }).get()
      hits = (r.data || []).filter(p => _fuzzyProductName(p.product_name, fp.product_name))
    }
    if (hits.length === 1) {
      return { policyId: hits[0].id, matched: true, matchedBy: 'same_image', candidates: [] }
    }
  }

  // 1. 保单号精确匹配
  if (cashDoc.product_name && cashDoc.policy_number) {
    const res = await policies.where({ ...base, policy_number: cashDoc.policy_number, product_name: cashDoc.product_name }).get()
    if (res.data && res.data.length === 1) {
      return { policyId: res.data[0].id, matched: true, matchedBy: 'auto', candidates: [] }
    }
  }

  // 2. 产品名 + 被保人模糊匹配
  if (cashDoc.product_name && cashDoc.insured_name) {
    const res = await policies
      .where({ ...base, insured_name: cashDoc.insured_name })
      .get()
    const matched = (res.data || []).filter(p => _fuzzyProductName(p.product_name, cashDoc.product_name))
    if (matched.length === 1) {
      return { policyId: matched[0].id, matched: true, matchedBy: 'auto', candidates: [] }
    }
    if (matched.length > 1) {
      logOperation(db, {
        openid, familyId, action: 'match_cash_value',
        result: { status: 'fail', summary: '现价表匹配多候选歧义' },
        // 2026-09-22 全面审计 P2-6：operation_logs.meta 保留期 90 天，不得落明文 PII ——
        // insured_name 在分享视图里是被掩码的敏感字段；policy_number 同理（下方第 2 处日志）。
        meta: { product_name: cashDoc.product_name, insured_name: desensitize(String(cashDoc.insured_name || '')), matchCount: matched.length }
      }).catch(() => {})
      return { policyId: null, matched: false, matchedBy: null, candidates: matched.map(p => ({
        policy_id: p.id, product_name: p.product_name || '', insured_name: p.insured_name || '',
        category: p.insurance_category || ''
      })) }
    }
  }

  // 3. 未匹配 → 返回长期险候选列表（供手动选择），记录日志
  logOperation(db, {
    openid, familyId, action: 'match_cash_value',
    result: { status: 'fail', summary: '现价表未匹配到保单' },
    meta: {
      product_name: cashDoc.product_name,
      insured_name: desensitize(String(cashDoc.insured_name || '')),
      policy_number: desensitize(String(cashDoc.policy_number || ''))
    }
  }).catch(() => {})
  const all = await policies.where(base).get()
  // 2026-09-28 全面审计 P3（枚举漂移，与 09-22 的 '年金险' 同一类）：原写裸词 `'重疾'`，
  // 而保单库/契约里的规范值是 `'重疾险'`（fact-vocab.STANDARD_COVERAGE、AI schema 枚举、
  // thresholds.CANON_CAT 都归一为 '重疾险'；报告页自己的 LONG_TERM 用的也是 '重疾险'）
  // → 候选列表里**永远不含重疾险保单**。当前无消费方（报告页自建候选），属潜在缺陷。
  const longTerm = (all.data || []).filter(p =>
    ['寿险', '重疾险', '年金'].includes(p.insurance_category || '')
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
