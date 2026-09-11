/**
 * policy-write — 保单操作领域
 *
 * 导出：writePolicy / writePoliciesBatch / deletePolicy / updatePolicy / writeCashValue
 * 常量：POLICY_EDITABLE
 *
 * 依赖关系：
 *   - writePolicy / deletePolicy / updatePolicy 调用 fact-write.addFact
 *   - writePoliciesBatch 调用同模块 writePolicy / writeCashValue
 *   - fact-write 不反向依赖 policy-write，无循环依赖，可直接 destructure
 */
const _ = require('wx-server-sdk').database().command
const { detectInjection } = require('./_shared/guard')
const { desensitize } = require('./_shared/pii-rules')
const { normalizeInsurer } = require('./_shared/insurer-normalize')
const { writeSeam } = require('./_shared/writeSeam')
const { logOperation } = require('./_shared/logSeam')
const { locatePolicy } = require('./policy-locate')
const { policyToFacts } = require('./policyToFacts')
const { matchPoliciesToMembers } = require('./_shared/member-matcher')
const { matchCashToPolicies, matchOrphanCashValues } = require('./cash-value-matcher')
const { addFact } = require('./fact-write')

// ---------- 金额输入归一（OCR 审计 H2） ----------
// DB 契约：sum_assured/annual_premium 存元（数字）。OCR 直传已是元数字；人工编辑路径（OCR 确认卡/手填）可能带
// 「万/亿」字（如 "80万"）或千分位（"80,000"）——统一在此数字化，防止字符串/NaN 落库导致报告侧出 NaN。
// 无法解析返回 NaN，由上层 `isNaN ? 0` 兜底。
function _toYuanAmount(v) {
  if (v === null || v === undefined || v === '') return NaN
  const s = String(v).trim().replace(/[,，\s]/g, '')
  if (!s) return NaN
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(万|亿)$/)
  if (m) return Math.round(parseFloat(m[1]) * (m[2] === '亿' ? 100000000 : 10000))
  const n = Number(s)
  return isNaN(n) ? NaN : n
}

// ---------- effective_date 格式规范（OCR 审计 M4） ----------
// DB 契约：effective_date 存 YYYY-MM-DD。OCR/对话多来源偶发中文/斜杠格式（"2024年01月15日"/"2024/1/15"），
// 统一规范；无法解析置空（状态判定按无生效日降级，但不落垃圾日期）。
// updatePolicy 人工编辑仍走严格 400 校验（拒绝而非静默置空，提示更明确）。
function _cleanEffectiveDate(v) {
  const s = String(v || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{4})[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?$/)
  if (m) {
    const pad = n => String(n).padStart(2, '0')
    return m[1] + '-' + pad(m[2]) + '-' + pad(m[3])
  }
  return ''
}

// ---------- writePolicy ----------
async function writePolicy(db, openid, event) {
  const { familyId, memberId, data } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  // 级联删除审计 #2 竞态防护：家庭已删/删除中 → 拒绝写入，避免删除窗口内 OCR/对话写孤儿保单
  const alive = await db.collection('families').where({ _id: familyId, _openid: openid }).count().catch(() => ({ total: 0 }))
  if (!(alive.total > 0)) return { code: 404, msg: '家庭不存在，无法写入保单' }
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
  // H2：金额数字化 + 万/亿→元（人工编辑路径 "80万"→800000；OCR 直传元数字原样保留；NaN 兜底 0）
  const saYuan = _toYuanAmount(sum_assured)
  const apYuan = _toYuanAmount(annual_premium)
  const doc = {
    product_name: product_name || '', insurance_category: insurance_category || '', insurance_type: insurance_type || '',
    insurance_period: insurance_period || '', sum_assured: isNaN(saYuan) ? 0 : saYuan, annual_premium: isNaN(apYuan) ? 0 : apYuan,
    policy_number: policy_number || '', insurer: normalizeInsurer(insurer), effective_date: _cleanEffectiveDate(effective_date),
    policyholder_name: policyholder_name || '', insured_name: resolvedInsuredName, beneficiary_name: beneficiary_name || '',
    special_agreement: safeSpecialAgreement, payment_method: payment_method || '', payment_period: payment_period || '',
    id: id || 'pol_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    family_id: familyId, member_id: resolvedMemberId,
    confidence: confidence || 0, field_confidence: field_confidence || {}, confidence_source: confidence_source || '',
    auto_confirmed: !!auto_confirmed,
    created_at: now
  }
  // 用户决策（2026-08-30）：识别/表单入库一律默认 active，不做任何自动状态判断；
  // 状态仅由用户在保单编辑中手动变更（updatePolicy），改失效/退保/理赔终止需填失效日期
  doc.status = 'active'
  // writeSeam 接缝：silent 写入 + 末尾统一 triggerHooks（addFact 内部已自带钩子，此处 silent 避免 N 次重复 markFamilyMutated）
  const ws = writeSeam(db, openid, familyId)
  let policyDbId, isExisting = false, exist = null
  if (doc.policy_number) {
    // policy_number 主键去重（P-DUP 修复）：同保单号 + 同产品名才判重（OCR 两次提取同保单同产品）；
    // 同保单号不同产品（主险+附加险）是独立文档，必须各自入库——原单用 policy_number 导致附加险被吞
    exist = await db.collection('policies').where({ policy_number: doc.policy_number, product_name: doc.product_name, family_id: familyId, _openid: openid, status: _.neq('deleted') }).limit(1).get()
    if (exist.data && exist.data.length > 0) { policyDbId = exist.data[0]._id; isExisting = true }
  } else if (doc.product_name && doc.insured_name) {
    // 无保单号时二级去重：产品名+被保人+投保人（同样过滤软删除）
    exist = await db.collection('policies').where({
      product_name: doc.product_name, insured_name: doc.insured_name,
      policyholder_name: doc.policyholder_name, family_id: familyId, _openid: openid,
      status: _.neq('deleted')
    }).limit(1).get()
    if (exist.data && exist.data.length > 0) { policyDbId = exist.data[0]._id; isExisting = true }
  }
  if (!policyDbId) { const addRes = await ws.silentAdd('policies', doc); policyDbId = addRes._id }
  // S2-1 修复：命中重复时返回库中已有保单的真实 id（doc.id 是新生成的，不存在于库中）
  // 否则下游 writePoliciesBatch 用这个 id 写入 p.id，再传给 matchOrphanCashValues，会指向不存在的保单
  // P1-B 修复：exist 提升为外层变量（原 const 块级作用域，dedup 命中时此处引用抛 ReferenceError）；policyId 双 fallback
  if (isExisting) return { code: 200, data: { written: false, skipped: true, policyId: (exist.data[0].id || exist.data[0]._id) || doc.id } }
  // Phase 1：保单入库同步拆解为结构化三元组写入 facts（replace 旧单条 '购买了' 兜底；开放谓词 + policy 节点）
  // K-S2 修复：member_id 为空但有被保人姓名时也写 facts——"拥有保障"边由 addFact 按姓名解析，
  // 保单节点事实（保额/保费等）本就与成员无关；成员不存在时 addFact 返回 404，被下方 catch 兜底不阻断入库
  if ((resolvedMemberId || resolvedInsuredName) && product_name) {
    const factEvents = policyToFacts(doc, {
      memberId: resolvedMemberId, memberName: resolvedInsuredName,
      confidence: doc.confidence, source: 'ocr'
    })
    await Promise.all(factEvents.map(ev => addFact(db, openid, { familyId, ...ev }).catch(e => console.error('[dataWrite] writePolicy addFact 失败:', e.message))))
  }
  await ws.triggerHooks()
  return { code: 200, data: { written: true, policyId: doc.id } }
}

// ---------- writePoliciesBatch / ingestPolicies（候选 3：五步 step 化） ----------
// Bug-1,2 修复：并发竞态 + DB 雪崩。方案：批次内去重 + 限流并发到 3
// Step 契约：每步纯函数化，内部 try/catch 隔离，失败策略集中（跳过继续），行为等价原五步链

// Step 1：批次内去重（P1-4 空保单号场景；P-DUP 修复：同保单号多产品=主险+附加险不互相去重）
//   - 有 policy_number：按 policy_number + product_name 去重（OCR 两次提取同保单同产品才重复；
//     同保单不同产品如附加险是独立文档，不能用 policy_number 单键否则附加险被吞）
//   - 无 policy_number：按 product_name + insured_name + policyholder_name 去重
function _dedupPolicies(policies) {
  const seen = new Set()
  const dedupedPolicies = []
  let dedupSkipped = 0
  for (const p of policies) {
    const key = p.policy_number
      ? ('pn:' + p.policy_number + '|' + (p.product_name || ''))
      : ('nm:' + (p.product_name || '') + '|' + (p.insured_name || '') + '|' + (p.policyholder_name || ''))
    if (seen.has(key)) { dedupSkipped++; continue }
    seen.add(key)
    dedupedPolicies.push(p)
  }
  return { dedupedPolicies, dedupSkipped }
}

// 通用限流并发执行器（Bug-2 DB 雪崩防护）：items 按 CONCURRENCY 并发跑 fn
// fn(item) 返回结果（含 ok 标志）；fn 抛错走 onError 并记为 { ok:false, error }
async function _runConcurrent(items, CONCURRENCY, fn, onError) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++
      const item = items[idx]
      try {
        results[idx] = await fn(item, idx)
      } catch (e) {
        if (onError) onError(e, item)
        results[idx] = { ok: false, error: e.message }
      }
    }
  }
  if (items.length > 0) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()))
  }
  return results
}

// Step 2：限流并发写保单（每单 writePolicy 自身 try/catch 非 200 分支）
function _writePolicyStep(db, openid, familyId) {
  return async function (p) {
    const res = await writePolicy(db, openid, { familyId, data: p, memberId: p.member_id || p.memberId })
    if (res.code === 200 && res.data && res.data.policyId) {
      p.id = res.data.policyId
    }
    if (res.code === 200) {
      // 全链路审计 S1：透出 skipped 标志（命中库中重复项）——重复项 member_id 已正确落库，
      // 若参与成员匹配会被 match sync 无条件覆盖污染正确值，调用方须排除
      const skipped = !!(res.data && res.data.skipped)
      return { policyId: (res.data && res.data.policyId) || '', ok: true, skipped }
    }
    // S2-2 修复：writePolicy 返回非 200（如重复命中）记为失败并留痕
    logOperation(db, {
      openid, familyId, action: 'write_policy',
      result: { status: 'fail', summary: 'writePolicy 返回非200', errorCode: res.code },
      meta: { product_name: p.product_name, msg: res.msg }
    }).catch(function () {})
    return { ok: false, error: res.msg || '写入失败' }
  }
}

function _writePolicyErrorLog(db, openid, familyId) {
  return function (e, p) {
    logOperation(db, {
      openid, familyId, action: 'write_policy',
      result: { status: 'fail', summary: '单条保单写入异常', errorCode: 'write_exception' },
      meta: { product_name: p.product_name, error: e.message }
    }).catch(() => {})
  }
}

// Step 3：入库后统一成员匹配（P1-5：首页 OCR 无 familyId 的关联断裂）
async function _matchMembersStep(db, openid, familyId, dedupedPolicies) {
  try {
    await matchPoliciesToMembers({ db, familyId, openid, allPolicies: dedupedPolicies })
  } catch (e) {
    logOperation(db, {
      openid, familyId, action: 'match_member',
      result: { status: 'fail', summary: 'OCR入库后成员匹配失败', errorCode: 'member_match_error' },
      meta: { error: e.message }
    }).catch(function () {})
  }
}

// Step 4：反向匹配孤儿现价表
async function _matchOrphanCashStep(db, openid, familyId, dedupedPolicies) {
  try {
    await matchOrphanCashValues(db, familyId, openid, dedupedPolicies)
  } catch (e) {
    logOperation(db, {
      openid, familyId, action: 'match_orphan_cash',
      result: { status: 'fail', summary: '孤儿现价表反向匹配失败', errorCode: 'orphan_cash_error' },
      meta: { error: e.message }
    }).catch(function () {})
  }
}

// Step 5：现价表并发入库（P1-1：限流 3，避免串行逼近 20s 超时）
function _cashValueStep(db, openid, familyId) {
  return async function (cv) {
    await writeCashValue(db, openid, { familyId, cash_value: cv })
    return { ok: true }
  }
}
function _cashValueErrorLog(db, openid, familyId) {
  return function (e, cv) {
    logOperation(db, {
      openid, familyId, action: 'write_cash_value',
      result: { status: 'fail', summary: '现价表批量写入异常', errorCode: 'cash_value_write_error' },
      meta: { product_name: cv.product_name, error: e.message }
    }).catch(function () {})
  }
}

// 编排：五步顺序执行，部分失败跳过继续（失败策略集中于此）
async function ingestPolicies(db, openid, event) {
  const { familyId, policies, cash_values } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!policies || !Array.isArray(policies) || policies.length === 0) return { code: 400, msg: '缺少参数 policies' }
  if (policies.length > 50) return { code: 400, msg: '单次最多写入 50 条保单' }

  // Step 1：去重
  const { dedupedPolicies, dedupSkipped } = _dedupPolicies(policies)
  // 全链路审计 S2：记录匹配前的 member_id 状态，供 Step 3 后判断"匹配才获得 member_id"的新保单补写 facts
  for (const p of dedupedPolicies) p._hadMember = !!(p.member_id || p.memberId)
  // Step 2：限流并发写保单（并发 3）
  const results = await _runConcurrent(dedupedPolicies, 3, _writePolicyStep(db, openid, familyId), _writePolicyErrorLog(db, openid, familyId))
  // 全链路审计 S1：命中库中重复的保单排除出成员匹配（其 member_id 已正确落库，match sync 无条件覆盖会污染正确值）
  const matchTargets = dedupedPolicies.filter((p, i) => !(results[i] && results[i].skipped))
  // Step 3：成员匹配（尊重已带 member_id 的保单）
  await _matchMembersStep(db, openid, familyId, matchTargets)
  // 全链路审计 S2：匹配后才获得 member_id 的新保单补写 facts（writePolicy 在 member_id 为空时不写 facts，
  // 导致保单在 policies 有 member_id 但 facts 无记录 → 报告据 facts 判定时该保单不可见）
  for (const p of matchTargets) {
    if (p.member_id && !p._hadMember && p.id) {
      const factEvents = policyToFacts(p, { memberId: p.member_id, memberName: p.insured_name, confidence: p.confidence || 0, source: 'ocr' })
      for (const ev of factEvents) {
        await addFact(db, openid, { familyId, ...ev }).catch(e => console.error('[dataWrite] match 后补写 facts 失败:', e.message))
      }
    }
  }
  // Step 4：孤儿现价表反向匹配
  await _matchOrphanCashStep(db, openid, familyId, dedupedPolicies)
  // Step 5：现价表并发入库
  const cv = cash_values || []
  if (cv.length > 0) {
    await _runConcurrent(cv, 3, _cashValueStep(db, openid, familyId), _cashValueErrorLog(db, openid, familyId))
  }

  // writePolicy / writeCashValue 内部已通过 writeSeam 触发 markMutated + advanceStage，此处无需重复
  return { code: 200, data: { written: results.filter(r => r.ok).length, total: policies.length, dedupSkipped, results } }
}

// 向后兼容入口：测试与外部调用仍用 writePoliciesBatch
async function writePoliciesBatch(db, openid, event) {
  return ingestPolicies(db, openid, event)
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
  // 安全审计 M7：reason 注入检测（防提示词注入产物写入 deleted_reason 留二次注入）
  let delReason = reason || '对话确认作废'
  if (typeof delReason === 'string' && detectInjection(delReason).injected) delReason = '对话确认作废'
  await ws.silentUpdateDoc('policies', target._id, {
    status: 'deleted', deleted_reason: delReason
  }).catch(e => { console.error('[dataWrite] deletePolicy 软删失败:', e.message); throw new Error('保单删除失败：' + e.message) })

  // 步骤 3：facts 层留决策备注（source=user_form 视为客户确认，报告据 facts 优先判定为已删除）
  // S2-5 修复：.then 内 silentUpdateDoc 必须 return 才能 await；否则云函数返回后上下文冻结，category 更新可能不执行
  await addFact(db, openid, {
    familyId, subjectId: '', subjectType: 'family', subjectName: '',
    predicate: '备注',
    objectValue: `删除保单决策：${target.product_name || ''}（被保人：${target.insured_name || '—'}）${reason ? '，原因：' + reason : '，客户确认作废'}`,
    source: 'user_form', confidence: 1
  }).then(r => {
    if (r.code === 200 && r.data && r.data.factId) {
      return ws.silentUpdateDoc('facts', r.data.factId, { category: 'policy_decision' }).catch(e => console.error('[dataWrite] deletePolicy 备注 category 更新失败:', e.message))
    }
    return null
  })
  // 步骤 4：清理关联现价表（解除 policy_id 指向已删除保单）
  // S2-5 修复：加 await，防止云函数返回后上下文冻结导致现价表清理丢失
  await ws.silentUpdateWhere('policy_cash_values', { policy_id: pid }, { policy_id: '', matched: false, matched_by: null, matched_at: null }).catch(e => console.error('[dataWrite] deletePolicy 现价表清理失败:', e.message))

  // addFact 已触发钩子，此处无需重复 triggerHooks
  return { code: 200, data: { deleted: true, policyId: pid, product_name: target.product_name } }
}

// ---------- updatePolicy ----------
// 修改已录入保单字段（白名单），保额/保费变化同步"拥有保障"事实边
// 业务员可手动变更的保单状态；到期终止(expired)由系统自动判断，不在此白名单
const POLICY_STATUS_CHANGEABLE = ['active', 'lapsed', 'surrendered', 'claim_terminated', 'cancelled']
const POLICY_STATUS_META = ['status_reason', 'status_effective_date']
const POLICY_EDITABLE = ['product_name', 'insurer', 'sum_assured', 'annual_premium', 'insurance_category', 'insurance_type', 'effective_date', 'insurance_period', 'payment_period', 'payment_method', 'premium_term', 'coverage_term', 'policyholder_name', 'beneficiary_name', 'insured_name', 'policy_number', 'status', ...POLICY_STATUS_META]

function _isActivePolicyStatus(status) {
  return !status || status === 'active' || status === 'unknown'
}

function _statusDecisionText(target, newStatus, reason) {
  const labelMap = {
    active: '恢复有效',
    lapsed: '失效',
    surrendered: '退保',
    claim_terminated: '理赔终止',
    cancelled: '退保'
  }
  const action = labelMap[newStatus] || newStatus
  const targetName = (target && target.product_name) || '保单'
  const insured = (target && target.insured_name) ? `（被保人：${target.insured_name}）` : ''
  return `变更保单状态：${targetName}${insured} → ${action}${reason ? `，原因：${reason}` : ''}`
}
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
  // 状态白名单校验：不允许业务员手动设置"到期终止/已删除"等系统态
  if (data.status !== undefined && !POLICY_STATUS_CHANGEABLE.includes(data.status)) {
    return { code: 400, msg: `不允许手动设置该保单状态: ${data.status}` }
  }
  const patch = {}
  for (const k of Object.keys(data)) {
    if (!POLICY_EDITABLE.includes(k)) continue
    let v = data[k]
    // 安全审计 M7：字符串字段注入检测（防提示词注入产物回写保单字段成二次注入载体）
    if (typeof v === 'string' && detectInjection(v).injected) { console.warn('[dataWrite] updatePolicy 注入拦截:', k); continue }
    // 金额字段：与 writePolicy 同规则（万/亿→元 + 数字化），其余数值字段 Number
    if (['sum_assured', 'annual_premium'].includes(k) && v !== undefined && v !== '') v = _toYuanAmount(v)
    if (['premium_term', 'coverage_term'].includes(k) && v !== undefined && v !== '') v = Number(v)
    // 保险公司简称统一收敛（与 writePolicy 同规则，防编辑写入新变体）
    if (k === 'insurer' && typeof v === 'string') v = normalizeInsurer(v)
    // 生效日期严格格式校验：防 AI 把保障期间/缴费期限误填进 effective_date（如"1年"）
    if (k === 'effective_date' && typeof v === 'string' && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return { code: 400, msg: `生效日期格式应为 YYYY-MM-DD（收到: ${v}），保障期间/缴费期限请填 insurance_period/payment_period` }
    }
    patch[k] = v
  }
  if (Object.keys(patch).length === 0) return { code: 400, msg: '没有可更新的合法字段' }
  // 被保人变更 → 同步重挂 member_id（2026-09-06：防"insured_name 与 member_id 漂移"错配固化）
  // member_id 不在 POLICY_EDITABLE：按新被保人姓名在成员中精确解析（含软删成员复用），
  // 命中重挂；未命中清空旧关联并告警（避免旧 member_id 继续把保单错挂他人）
  if (patch.insured_name !== undefined && String(patch.insured_name || '').trim() !== String(target.insured_name || '').trim()) {
    const newInsured = String(patch.insured_name || '').trim()
    const memRes = await db.collection('members').where({ _openid: openid, family_id: familyId, name: newInsured }).limit(5).get()
    const membersHit = memRes.data || []
    const hit = membersHit.find(x => x.status !== 'deleted') || membersHit[0]
    if (hit && hit.member_id) {
      patch.member_id = hit.member_id
    } else {
      patch.member_id = ''
      console.warn('[dataWrite] updatePolicy 被保人不在成员列表，已解除原关联:', target.product_name, newInsured)
    }
  }
  const ws = writeSeam(db, openid, familyId)
    const statusChanged = patch.status !== undefined && patch.status !== target.status
    const oldActive = _isActivePolicyStatus(target.status)
    const newActive = patch.status === 'active'

    // 用户决策（2026-08-30）：从有效改为失效/退保/理赔终止必须填写失效日期（status_effective_date）
    if (statusChanged && oldActive && !newActive && !patch.status_effective_date) {
      return { code: 400, msg: '请填写失效日期' }
    }

    // 离开 active → 先作废 facts，避免"已失效保单仍显示保障"的幽灵保单
    if (statusChanged && oldActive && !newActive) {
      await ws.silentUpdateWhere('facts', { subject_type: 'policy', subject_id: target.id, status: 'active' }, { status: 'superseded' }).catch(e => { console.error('[dataWrite] updatePolicy policy supersede 失败:', e.message); throw new Error('保单事实作废失败：' + e.message) })
      await ws.silentUpdateWhere('facts', { predicate: _.in(['拥有保障', '公司提供保障', '投保']), object_id: target.id, status: 'active' }, { status: 'superseded' }).catch(e => { console.error('[dataWrite] updatePolicy coverage supersede 失败:', e.message); throw new Error('保障/投保边事实作废失败：' + e.message) })
    }

  await ws.silentUpdateDoc('policies', target._id, patch).catch(e => { console.error('[dataWrite] updatePolicy 失败:', e.message); throw new Error('保单更新失败：' + e.message) })

    // 恢复 active → 重建保障 facts（先更新保单，再重建，避免失败时出现"active 保单无保障"）
    if (statusChanged && !oldActive && newActive) {
      const restored = { ...target, ...patch }
      const factEvents = policyToFacts(restored, {
        memberId: restored.member_id || '', memberName: restored.insured_name,
        confidence: 1, source: 'agent_edit'
      })
      for (let ri = 0; ri < factEvents.length; ri++) {
        await addFact(db, openid, { familyId, ...factEvents[ri] }).catch(function(e) { console.error('[dataWrite] updatePolicy 恢复 active addFact 失败:', e.message) })
      }
    }

    // 状态变更留痕：facts 层写一条可追溯的保单决策备注
    if (statusChanged) {
      await addFact(db, openid, {
        familyId, subjectId: '', subjectType: 'family', subjectName: '',
        predicate: '备注', objectValue: _statusDecisionText(target, patch.status, patch.status_reason),
        source: 'user_form', confidence: 1
      }).then(r => {
        if (r.code === 200 && r.data && r.data.factId) {
          return ws.silentUpdateDoc('facts', r.data.factId, { category: 'policy_decision' }).catch(e => console.error('[dataWrite] updatePolicy 状态备注 category 更新失败:', e.message))
        }
        return null
      })
    }
    const finalActive = statusChanged ? newActive : oldActive


  const hasFieldChange = patch.sum_assured !== undefined || patch.annual_premium !== undefined
  const hasNameChange = patch.product_name !== undefined || patch.insured_name !== undefined
  if ((hasFieldChange || hasNameChange) && finalActive) {
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
  } else if (!statusChanged && !hasFieldChange && !hasNameChange) {
    await ws.triggerHooks()
  }
  // addFact 已触发钩子，无需重复
  return { code: 200, data: { updated: true, policyId: target.id, fields: Object.keys(patch) } }
}

// ---------- changePolicyStatus ----------
// 保单状态变更的显式入口（UI/对话工具均可调用）。
// 内部复用 updatePolicy 的状态同步逻辑，避免事实作废/重建两套实现。
async function changePolicyStatus(db, openid, event) {
  const { familyId, policyId, policy_number, product_name, insured_name, status, reason, effectiveDate } = event
  if (!familyId || !status) return { code: 400, msg: '缺少参数 familyId/status' }
  if (!POLICY_STATUS_CHANGEABLE.includes(status)) {
    return { code: 400, msg: `不允许手动设置该保单状态: ${status}` }
  }
  const data = { status }
  if (reason !== undefined) data.status_reason = reason
  if (effectiveDate !== undefined) data.status_effective_date = effectiveDate
  return updatePolicy(db, openid, {
    familyId,
    policyId,
    policy_number,
    product_name,
    insured_name,
    data
  })
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

// ---------- 人工关联现价表（2026-09-11 补闭环）----------
/**
 * 把孤儿现价表（matched=false）人工关联到指定保单。
 *
 * 背景（加载现价表的历史坑）：自动匹配靠"产品名去后缀取前 8 字 + 被保人"模糊比对，
 * 匹配不中即 matched=false 永久躺在库里——报告只读 matched:true，于是数据在库但不展示，
 * 用户也无从补救；前端还长期提示"现价表已保存，可手动关联保单"却没有关联入口。
 * 而 matched_by='manual' 虽在 writeCashValue 中有人工优先保护逻辑（OCR 重写不覆盖），
 * 却从无写入路径——是个从未被激活的预留状态。本 handler 补上这一环。
 *
 * @param {string} event.familyId
 * @param {string} event.cashValueId - policy_cash_values 文档 _id
 * @param {string} event.policyId - 目标保单业务 id（policies.id）
 */
async function linkCashValue(db, openid, event) {
  const { familyId, cashValueId, policyId } = event
  if (!familyId || !cashValueId || !policyId) {
    return { code: 400, msg: '缺少参数（familyId/cashValueId/policyId）' }
  }
  // 归属校验：现价表与目标保单都必须属于该家庭（_openid 防越权读取/写入）
  const [cvRes, pRes] = await Promise.all([
    db.collection('policy_cash_values').where({ _id: cashValueId, family_id: familyId, _openid: openid }).limit(1).get(),
    db.collection('policies').where({ id: policyId, family_id: familyId, _openid: openid }).limit(1).get()
  ])
  const cash = (cvRes.data || [])[0]
  const policy = (pRes.data || [])[0]
  if (!cash) return { code: 404, msg: '现价表不存在或无权访问' }
  if (!policy) return { code: 404, msg: '保单不存在或无权访问' }
  if (policy.status === 'deleted') return { code: 400, msg: '目标保单已删除，无法关联' }

  const rows = cash.cash_values || []
  const ws = writeSeam(db, openid, familyId)
  await ws.silentUpdateDoc('policy_cash_values', cashValueId, {
    policy_id: policyId, matched: true, matched_by: 'manual', matched_at: new Date()
  })
  // 与自动匹配同口径回写保单上的现价标记，使报告「现价 / 回本」列与保障节点立即生效
  await ws.silentUpdateWhere('policies', { id: policyId }, {
    cash_value_available: true,
    latest_cash_value: rows.length ? (rows[rows.length - 1].v || 0) : 0
  })
  await ws.triggerHooks()
  return { code: 200, data: { matched: true, policyId, product_name: policy.product_name || '' } }
}

module.exports = { writePolicy, writePoliciesBatch, ingestPolicies, _dedupPolicies, _runConcurrent, deletePolicy, updatePolicy, changePolicyStatus, writeCashValue, linkCashValue, POLICY_EDITABLE, POLICY_STATUS_CHANGEABLE }
