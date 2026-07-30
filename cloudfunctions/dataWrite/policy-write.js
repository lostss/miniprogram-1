/**
 * policy-write — 保单操作领域
 *
 * 导出：writePolicy / writePoliciesBatch / migratePoliciesToFacts / deletePolicy / updatePolicy / writeCashValue / matchCashValueManual
 * 常量：POLICY_EDITABLE
 *
 * 依赖关系：
 *   - writePolicy / migratePoliciesToFacts / deletePolicy / updatePolicy 调用 fact-write.addFact
 *   - writePoliciesBatch 调用同模块 writePolicy / writeCashValue
 *   - fact-write 不反向依赖 policy-write，无循环依赖，可直接 destructure
 */
const _ = require('wx-server-sdk').database().command
const { detectInjection } = require('./_shared/guard')
const { desensitize } = require('./_shared/ai-gateway')
const { writeSeam } = require('./_shared/writeSeam')
const { logOperation } = require('./_shared/logSeam')
const { loadActivePolicies } = require('./_shared/policy-read')
const { locatePolicy } = require('./policy-locate')
const { policyToFacts } = require('./policyToFacts')
const { matchPoliciesToMembers } = require('./_shared/member-matcher')
const { matchCashToPolicies, matchOrphanCashValues } = require('./cash-value-matcher')
const { addFact } = require('./fact-write')

// ---------- writePolicy ----------
async function writePolicy(db, openid, event) {
  const { familyId, memberId, data } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  // A1 修复：insured_name 为空时回退用 policyholder_name（新华保险投保人=被保人场景）
  if (!data || !(data.insured_name || data.policyholder_name)) return { code: 400, msg: '缺少保单数据（insured_name/policyholder_name）' }
  // P1-3：special_agreement 是自由文本字段，需纳入注入检测（原仅校验 name/category）
  const vals = [data.insured_name, data.product_name, data.insurance_category, data.special_agreement].filter(Boolean)
  if (vals.some(v => detectInjection(String(v)).injected)) return { code: 400, msg: '内容校验未通过' }
  const now = new Date()
  const { product_name, insurance_category, insurance_type, insurance_period, sum_assured, annual_premium, policy_number, insurer, effective_date, policyholder_name, insured_name, beneficiary_name, special_agreement, payment_method, payment_period, id, member_id, memberId: dataMemberId, confidence, field_confidence, confidence_source, auto_confirmed } = data
  // A1 修复：insured_name 为空时回退用 policyholder_name（新华保险投保人=被保人场景）
  const resolvedInsuredName = insured_name || policyholder_name || ''
  // P0-2：special_agreement 入库前脱敏，防止 OCR 提取的身份证/手机号/银行卡号明文落库
  const safeSpecialAgreement = special_agreement ? desensitize(String(special_agreement)) : ''
  // Fork A：对话路径（conversationAI.addPolicy）仅给 insured_name，按姓名解析 member_id；OCR/表单路径已带 memberId
  let resolvedMemberId = memberId || dataMemberId || member_id || ''
  if (!resolvedMemberId) {
    const mRes = await db.collection('members').where({ family_id: familyId, _openid: openid, name: resolvedInsuredName }).limit(1).get()
    if (mRes.data && mRes.data.length > 0) resolvedMemberId = mRes.data[0].member_id
  }
  const doc = {
    product_name: product_name || '', insurance_category: insurance_category || '', insurance_type: insurance_type || '',
    insurance_period: insurance_period || '', sum_assured: sum_assured || 0, annual_premium: annual_premium || 0,
    policy_number: policy_number || '', insurer: insurer || '', effective_date: effective_date || '',
    policyholder_name: policyholder_name || '', insured_name: resolvedInsuredName, beneficiary_name: beneficiary_name || '',
    special_agreement: safeSpecialAgreement, payment_method: payment_method || '', payment_period: payment_period || '',
    id: id || 'pol_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    family_id: familyId, member_id: resolvedMemberId,
    confidence: confidence || 0, field_confidence: field_confidence || {}, confidence_source: confidence_source || '',
    auto_confirmed: !!auto_confirmed, created_at: now
  }
  // writeSeam 接缝：silent 写入 + 末尾统一 triggerHooks（addFact 内部已自带钩子，此处 silent 避免 N 次重复 markFamilyMutated）
  const ws = writeSeam(db, openid, familyId)
  let policyDbId, isExisting = false
  if (doc.policy_number) {
    // policy_number 主键去重（OCR 两次提取同保单，产品名可能略有偏差）
    const exist = await db.collection('policies').where({ policy_number: doc.policy_number, family_id: familyId, _openid: openid }).limit(1).get()
    if (exist.data && exist.data.length > 0) { policyDbId = exist.data[0]._id; isExisting = true }
  } else if (doc.product_name && doc.insured_name) {
    // 无保单号时二级去重：产品名+被保人+投保人
    const exist = await db.collection('policies').where({
      product_name: doc.product_name, insured_name: doc.insured_name,
      policyholder_name: doc.policyholder_name, family_id: familyId, _openid: openid
    }).limit(1).get()
    if (exist.data && exist.data.length > 0) { policyDbId = exist.data[0]._id; isExisting = true }
  }
  if (!policyDbId) { const addRes = await ws.silentAdd('policies', doc); policyDbId = addRes._id }
  if (isExisting) return { code: 200, data: { written: false, skipped: true, policyId: doc.id } }
  // Phase 1：保单入库同步拆解为结构化三元组写入 facts（replace 旧单条 '购买了' 兜底；开放谓词 + policy 节点）
  if (resolvedMemberId && product_name) {
    const factEvents = policyToFacts(doc, {
      memberId: resolvedMemberId, memberName: resolvedInsuredName,
      confidence: doc.confidence, source: 'ocr'
    })
    await Promise.all(factEvents.map(ev => addFact(db, openid, { familyId, ...ev }).catch(e => console.error('[dataWrite] writePolicy addFact 失败:', e.message))))
  }
  await ws.triggerHooks()
  return { code: 200, data: { written: true, policyId: doc.id } }
}

// ---------- writePoliciesBatch ----------
// Bug-1,2 修复：并发竞态 + DB 雪崩。方案：批次内去重 + 限流并发到 3
async function writePoliciesBatch(db, openid, event) {
  const { familyId, policies } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!policies || !Array.isArray(policies) || policies.length === 0) return { code: 400, msg: '缺少参数 policies' }
  if (policies.length > 50) return { code: 400, msg: '单次最多写入 50 条保单' }

  // 批次内去重：同 policy_number + product_name 只保留首条（修复 Bug-1 并发竞态根因）
  const seen = new Set()
  const dedupedPolicies = []
  let dedupSkipped = 0
  for (const p of policies) {
    const key = (p.policy_number || '') + '|' + (p.product_name || '')
    if (p.policy_number && seen.has(key)) { dedupSkipped++; continue }
    if (p.policy_number) seen.add(key)
    dedupedPolicies.push(p)
  }

  // 限流并发：最多 3 个 writePolicy 同时执行（修复 Bug-2 DB 雪崩）
  const CONCURRENCY = 3
  const results = new Array(dedupedPolicies.length)
  let cursor = 0
  async function worker() {
    while (cursor < dedupedPolicies.length) {
      const idx = cursor++
      const p = dedupedPolicies[idx]
      try {
        const res = await writePolicy(db, openid, { familyId, data: p, memberId: p.member_id || p.memberId })
        if (res.code === 200 && res.data && res.data.policyId) {
          p.id = res.data.policyId
        }
        results[idx] = res.code === 200
          ? { policyId: (res.data && res.data.policyId) || '', ok: true }
          : (function () {
              logOperation(db, {
                openid, familyId, action: 'write_policy',
                result: { status: 'fail', summary: 'writePolicy 返回非200', errorCode: res.code },
                meta: { product_name: p.product_name, msg: res.msg }
              }).catch(function () {})
              return { ok: false, error: res.msg || '写入失败' }
            })()
      } catch (e) {
        logOperation(db, {
          openid, familyId, action: 'write_policy',
          result: { status: 'fail', summary: '单条保单写入异常', errorCode: 'write_exception' },
          meta: { product_name: p.product_name, error: e.message }
        }).catch(() => {})
        results[idx] = { ok: false, error: e.message }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dedupedPolicies.length) }, () => worker()))

  // 入库后对未匹配 member_id 的保单做统一成员匹配，修复首页 OCR 路径无 familyId 导致的关联断裂（P1-5）
  // 注意：已带 member_id 的保单（ocrSingle 已匹配）会被 matchPoliciesToMembers 尊重，不重复处理
  // 使用 dedupedPolicies：重复项未设 id，不应参与匹配
  try {
    await matchPoliciesToMembers({ db, familyId, openid, allPolicies: dedupedPolicies })
  } catch (e) {
    logOperation(db, {
      openid, familyId, action: 'match_member',
      result: { status: 'fail', summary: 'OCR入库后成员匹配失败', errorCode: 'member_match_error' },
      meta: { error: e.message }
    }).catch(function () {})
  }

  // 反向匹配孤儿现价表
  try {
    await matchOrphanCashValues(db, familyId, openid, dedupedPolicies)
  } catch (e) {
    logOperation(db, {
      openid, familyId, action: 'match_orphan_cash',
      result: { status: 'fail', summary: '孤儿现价表反向匹配失败', errorCode: 'orphan_cash_error' },
      meta: { error: e.message }
    }).catch(function () {})
  }

  // 现价表入库（串行，在 orphan 匹配之后）
  const cashValues = event.cash_values
  if (cashValues && cashValues.length > 0) {
    for (const cv of cashValues) {
      try {
        await writeCashValue(db, openid, { familyId, cash_value: cv })
      } catch (e) {
        logOperation(db, {
          openid, familyId, action: 'write_cash_value',
          result: { status: 'fail', summary: '现价表批量写入异常', errorCode: 'cash_value_write_error' },
          meta: { product_name: cv.product_name, error: e.message }
        }).catch(function () {})
      }
    }
  }

  // writePolicy / writeCashValue 内部已通过 writeSeam 触发 markMutated + advanceStage，此处无需重复
  return { code: 200, data: { written: results.filter(r => r.ok).length, total: policies.length, dedupSkipped, results } }
}

// ---------- migratePoliciesToFacts ----------
// 一次性迁移：将历史保单补提取为结构化三元组。addFact dedup 保证可重复执行。
async function migratePoliciesToFacts(db, openid, event) {
  const { familyId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  // 架构审计第 16 轮候选 #1：读取走 loadActivePolicies 接缝（_openid 注入 + 过滤 deleted）
  const policies = await loadActivePolicies(db, familyId, openid, { ensureStatus: false, limit: 1000 })
  let factsCreated = 0, skipped = 0
  const warnings = []
  const factPromises = []
  for (const p of policies) {
    const missing = ['insurance_period', 'effective_date', 'sum_assured'].filter(k => !p[k])
    if (missing.length) {
      warnings.push(`${p.product_name || p._id}: 缺关键字段 [${missing.join(', ')}]，状态/保额可能退化为待确认`)
    }
    const events = policyToFacts(p, { memberId: p.member_id || '', memberName: p.insured_name, confidence: p.confidence, source: 'ocr' })
    for (const ev of events) {
      factPromises.push(addFact(db, openid, { familyId, ...ev }).then(r => {
        if (r.code === 200 && r.data && r.data.action === 'skipped') skipped++
        else if (r.code === 200) factsCreated++
      }).catch(e => console.error('[dataWrite] migratePoliciesToFacts addFact 失败:', e.message)))
    }
  }
  await Promise.all(factPromises)
  return { code: 200, data: { policies_scanned: policies.length, facts_created: factsCreated, skipped, warnings } }
}

// ---------- deletePolicy ----------
// 双写同步删除：软删 policies（status:'deleted'）+ supersede 对应 facts（拥有保障边 + policy 节点）+ 留决策备注（facts 层可追溯，供报告据 facts 优先判定）
// Bug-3 修复：调整级联顺序，先 supersede facts 再软删保单，避免"幽灵保单"（已删但 facts 仍 active 导致报告误显示保障）
async function deletePolicy(db, openid, event) {
  const { familyId, policyId, policy_number, product_name, insured_name, reason } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!policyId && !policy_number && !product_name) return { code: 400, msg: '缺少保单标识（policyId/policy_number/product_name）' }

  // 架构审计第 16 轮候选 #3：三级定位走 locatePolicy 接缝（12 行 → 1 行）
  // excludeDeleted=false：允许重新软删已 deleted 的保单（覆盖式删除语义）
  const target = await locatePolicy(db, openid, familyId, {
    policyId, policy_number, product_name, insured_name, excludeDeleted: false
  })
  if (!target) return { code: 404, msg: '未找到要删除的保单' }

  const ws = writeSeam(db, openid, familyId)
  const pid = target.id

  // 步骤 1：先 supersede facts（若失败则保单未删，用户可重试，不会产生幽灵保单）
  await ws.silentUpdateWhere('facts', { subject_type: 'policy', subject_id: pid, status: 'active' }, { status: 'superseded' }).catch(e => { console.error('[dataWrite] deletePolicy policy supersede 失败:', e.message); throw new Error('保单事实作废失败：' + e.message) })
  await ws.silentUpdateWhere('facts', { predicate: _.in(['拥有保障', '公司提供保障', '投保']), object_id: pid, status: 'active' }, { status: 'superseded' }).catch(e => { console.error('[dataWrite] deletePolicy coverage supersede 失败:', e.message); throw new Error('保障/投保边事实作废失败：' + e.message) })

  // 步骤 2：facts 已作废，现在软删保单（此时即使失败也只是"active 保单 + 已作废 facts"，报告安全降级）
  await ws.silentUpdateDoc('policies', target._id, {
    status: 'deleted', deleted_reason: reason || '对话确认作废'
  }).catch(e => { console.error('[dataWrite] deletePolicy 软删失败:', e.message); throw new Error('保单删除失败：' + e.message) })

  // 步骤 3：facts 层留决策备注（source=user_form 视为客户确认，报告据 facts 优先判定为已删除）
  await addFact(db, openid, {
    familyId, subjectId: '', subjectType: 'family', subjectName: '',
    predicate: '备注',
    objectValue: `删除保单决策：${target.product_name || ''}（被保人：${target.insured_name || '—'}）${reason ? '，原因：' + reason : '，客户确认作废'}`,
    source: 'user_form', confidence: 1
  }).then(r => {
    if (r.code === 200 && r.data && r.data.factId) {
      ws.silentUpdateDoc('facts', r.data.factId, { category: 'policy_decision' }).catch(e => console.error('[dataWrite] deletePolicy 备注 category 更新失败:', e.message))
    }
  })
  // 步骤 4：清理关联现价表（解除 policy_id 指向已删除保单）
  ws.silentUpdateWhere('policy_cash_values', { policy_id: pid }, { policy_id: '', matched: false, matched_by: null, matched_at: null }).catch(e => console.error('[dataWrite] deletePolicy 现价表清理失败:', e.message))

  // addFact 已触发钩子，此处无需重复 triggerHooks
  return { code: 200, data: { deleted: true, policyId: pid, product_name: target.product_name } }
}

// ---------- updatePolicy ----------
// 修改已录入保单字段（白名单），保额/保费变化同步"拥有保障"事实边
const POLICY_EDITABLE = ['product_name', 'insurer', 'sum_assured', 'annual_premium', 'insurance_category', 'insurance_type', 'effective_date', 'premium_term', 'coverage_term', 'policyholder_name', 'beneficiary_name', 'insured_name', 'policy_number']
async function updatePolicy(db, openid, event) {
  const { familyId, policyId, policy_number, product_name, insured_name, data } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) return { code: 400, msg: '缺少要更新的字段 data' }
  if (!policyId && !policy_number && !product_name) return { code: 400, msg: '缺少保单标识（policyId/policy_number/product_name）' }
  // 架构审计第 16 轮候选 #3：三级定位走 locatePolicy 接缝（12 行 → 1 行）
  // excludeDeleted=true：已 deleted 的保单不允许修改（与原 updatePolicy 语义一致）
  const target = await locatePolicy(db, openid, familyId, {
    policyId, policy_number, product_name, insured_name, excludeDeleted: true
  })
  if (!target) return { code: 404, msg: '未找到要修改的保单' }
  const patch = {}
  for (const k of Object.keys(data)) {
    if (!POLICY_EDITABLE.includes(k)) continue
    let v = data[k]
    if (['sum_assured', 'annual_premium', 'premium_term', 'coverage_term'].includes(k) && v !== undefined && v !== '') v = Number(v)
    patch[k] = v
  }
  if (Object.keys(patch).length === 0) return { code: 400, msg: '没有可更新的合法字段' }
  const ws = writeSeam(db, openid, familyId)
  await ws.silentUpdateDoc('policies', target._id, patch).catch(e => { console.error('[dataWrite] updatePolicy 失败:', e.message); throw new Error('保单更新失败：' + e.message) })
  const hasFieldChange = patch.sum_assured !== undefined || patch.annual_premium !== undefined
  const hasNameChange = patch.product_name !== undefined || patch.insured_name !== undefined
  if (hasFieldChange || hasNameChange) {
    // 构建合并后的完整保单文档（字段级 patch 合并到 target）
    var updated = {}; for (var k in target) updated[k] = target[k]; for (var k2 in patch) updated[k2] = patch[k2]
    const factEvents = policyToFacts(updated, {
      memberId: updated.member_id || '', memberName: updated.insured_name,
      confidence: 1, source: 'agent_edit'
    })
    // 单条写入：addFact 内部 versioned 策略已处理 supersede
    for (var i = 0; i < factEvents.length; i++) {
      await addFact(db, openid, { familyId, ...factEvents[i] }).catch(function(e) { console.error('[dataWrite] updatePolicy addFact 失败:', e.message) })
    }
  } else {
    await ws.triggerHooks()
  }
  // addFact 已触发钩子，无需重复
  return { code: 200, data: { updated: true, policyId: target.id, fields: Object.keys(patch) } }
}

// ---------- writeCashValue ----------
async function writeCashValue(db, openid, event) {
  const { familyId, cash_value: cv } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!cv || !cv.cash_values || !cv.cash_values.length) return { code: 400, msg: '缺少现金价值数据' }

  // 尝试匹配保单
  const { policyId, matched, candidates } = await matchCashToPolicies(db, familyId, openid, cv)

  const now = new Date()
  const cashDoc = {
    family_id: familyId,
    policy_id: policyId || '',
    product_name: cv.product_name || '',
    insured_name: cv.insured_name || '',
    policy_number: cv.policy_number || '',
    insurance_type: cv.insurance_type || '',
    cash_values: cv.cash_values || [],
    total_years: (cv.cash_values || []).length,
    latest_value: cv.cash_values && cv.cash_values.length ? cv.cash_values[cv.cash_values.length - 1].v : 0,
    matched,
    matched_by: matched ? 'auto' : null,
    matched_at: matched ? now : null,
    confidence: cv.overall_confidence || 0,
    source: 'ocr',
    created_at: now
  }

  if (cv.overall_confidence < 0.8) cashDoc.status = 'pending_review'

  const ws = writeSeam(db, openid, familyId)
  // upsert：按产品名+被保人作为主键（policy_id 跨批次可变，不可靠）
  const existing = (await db.collection('policy_cash_values').where({
    family_id: familyId,
    _openid: openid,
    product_name: cv.product_name || '',
    insured_name: cv.insured_name || ''
  }).limit(1).get()).data

  // Bug-5 修复：人工匹配保护需要与 policies 回写一致
  // - 保留人工匹配时：cash 记录 policy_id 指向人工保单，policies 回写也必须指向同一保单
  // - 不能用自动匹配的 policyId 回写 policies，否则 cash 与 policies 标记错位
  let effectivePolicyId = policyId
  let effectiveMatched = matched
  if (existing && existing.length) {
    var prev = existing[0]
    var { created_at, ...updateFields } = cashDoc
    // 保留人工匹配状态：手动匹配后 OCR 重写同名现价表不覆盖 matched_by
    if (prev.matched_by === 'manual') {
      updateFields.matched_by = 'manual'
      updateFields.matched = true
      updateFields.matched_at = prev.matched_at
      updateFields.policy_id = prev.policy_id
      // 人工匹配优先：policies 回写以人工 policy_id 为准
      effectivePolicyId = prev.policy_id
      effectiveMatched = true
    }
    await ws.silentUpdateDoc('policy_cash_values', prev._id, updateFields)
  } else {
    await ws.silentAdd('policy_cash_values', cashDoc)
  }

  // 回写保单标记：使用 effectivePolicyId 保证 cash 与 policies 指向同一保单
  if (effectiveMatched && effectivePolicyId) {
    await ws.silentUpdateWhere('policies', { id: effectivePolicyId }, { cash_value_available: true, latest_cash_value: cashDoc.latest_value })
  }

  await ws.triggerHooks()
  return { code: 200, data: { matched: effectiveMatched, policyId: effectivePolicyId, candidates } }
}

// ---------- matchCashValueManual ----------
async function matchCashValueManual(db, openid, event) {
  const { familyId, cashValueId, policyId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!cashValueId || !policyId) return { code: 400, msg: '缺少参数 cashValueId/policyId' }

  const r1 = await db.collection('policy_cash_values').where({ _id: cashValueId, family_id: familyId, _openid: openid }).limit(1).get()
  if (!r1.data || !r1.data.length) return { code: 404, msg: '未找到该现价记录' }
  const cashDoc = r1.data[0]

  const r2 = await db.collection('policies').where({ id: policyId, family_id: familyId, _openid: openid }).limit(1).get()
  if (!r2.data || !r2.data.length) return { code: 404, msg: '未找到该保单' }

  const ws = writeSeam(db, openid, familyId)
  await ws.silentUpdateDoc('policy_cash_values', cashDoc._id, {
    policy_id: policyId, matched: true, matched_by: 'manual', matched_at: new Date()
  })
  await ws.silentUpdateWhere('policies', { id: policyId }, {
    cash_value_available: true, latest_cash_value: cashDoc.latest_value || 0
  })
  await ws.triggerHooks()
  return { code: 200, data: { matched: true, policyId } }
}

module.exports = { writePolicy, writePoliciesBatch, migratePoliciesToFacts, deletePolicy, updatePolicy, writeCashValue, matchCashValueManual, POLICY_EDITABLE }
