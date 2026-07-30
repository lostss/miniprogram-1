/**
 * fact-write — 事实（facts）写入领域
 *
 * 导出：addFact / addMemberFact / updateFactConfidence / deleteFact
 * 常量：FACT_STRATEGIES / DIM_TO_PREDICATE
 *
 * 依赖关系（单向，无循环）：
 *   - fact-write → fact-member-sync（_syncFactToMember，仅反向同步）
 *   - member-write / message-write → fact-write（addMemberFact / DIM_TO_PREDICATE）
 *   架构审计第 13 轮：_writeMemberFact 移回本文件改名 addMemberFact，
 *   fact-member-sync 仅保留 fact→members 反向同步，循环依赖彻底消失，懒加载删除。
 */
const _ = require('wx-server-sdk').database().command
const { writeSeam } = require('./_shared/writeSeam')
const { _syncFactToMember } = require('./fact-member-sync')

// S2：表单路径维度 → 统一谓词（predicate 三元组），使 submitProfiling 写入的 fact 在报告/分析中可见
// 单一事实源：家庭级（收入/负债/固定支出/年保费预算）+ 成员级（职业/健康/教育程度/偏好/年龄/性别）
const DIM_TO_PREDICATE = {
  '收入': '个人年收入', '职业': '职业', '健康': '健康异常', '负债': '负债',
  '固定支出': '固定支出', '教育程度': '教育程度', '偏好': '有偏好',
  '年龄': '年龄', '性别': '性别', '年保费预算': '年保费预算'
}

// ---------- addFact ----------
// S2 统一事实 schema：predicate 三元组（CONTEXT.md 规范）。conversationAI.addFact 经 dataWrite 网关调用
const FACT_STRATEGIES = {
  '配偶': 'dedup', '子女': 'dedup', '父母': 'dedup',
  '拥有保障': 'versioned', '公司提供保障': 'versioned',
  '职业': 'versioned', '个人年收入': 'versioned', '健康异常': 'versioned', '负债': 'versioned',
  '性别': 'versioned', '年龄': 'versioned', '教育程度': 'versioned',
  '持有资产': 'dedup', '未来计划': 'versioned',
  '有偏好': 'versioned', '备注': 'dedup',
  '有特征': 'dedup',
  // 保单级字段（可变更 → versioned）
  '保额': 'versioned', '年缴保费': 'versioned', '险种': 'versioned',
  '生效日': 'versioned', '承保公司': 'versioned', '保障期间': 'versioned',
  '缴费期': 'versioned', '缴费方式': 'versioned', '特殊条款': 'versioned',
  // 家庭财务
  '固定支出': 'versioned', '年保费预算': 'versioned',
  // 保单级唯一字段
  '保单号': 'dedup', '投保': 'dedup'
}
// addFact 重构（全部重构）：
// - 支持直接传入 subjectId/subjectType（结构化路径如保单节点），或仅 subjectName（对话路径按姓名解析 member_id）
// - objectType 支持 'policy'，objectId 可指向保单
// - 开放谓词：未知 predicate 默认 dedup，支持目的驱动提取（不再硬阻断）
// - confidence 可覆盖（OCR 透传真实置信度）
async function addFact(db, openid, event) {
  const {
    familyId,
    subjectName, subjectId, subjectType = 'member',
    predicate,
    objectValue, objectName, objectId = '', objectType = 'literal',
    reasoning, source = 'ai', confidence = 0.9
  } = event
  const conf = Math.max(0, Math.min(1, Number(confidence) || 0))
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!predicate || objectValue == null || objectValue === '') return { code: 400, msg: '缺少 predicate/objectValue' }

  let resolvedSubjectId = subjectId
  let resolvedSubjectType = subjectType
  let resolvedSubjectName = subjectName || ''
  // 对话路径：仅给 subjectName，按姓名解析 member_id（subject_type 默认 member）
  if (!resolvedSubjectId && resolvedSubjectName) {
    const subRes = await db.collection('members').where({ family_id: familyId, _openid: openid, name: resolvedSubjectName }).limit(1).get()
    if (!subRes.data || subRes.data.length === 0) return { code: 404, msg: '未找到主体成员：' + resolvedSubjectName }
    resolvedSubjectId = subRes.data[0].member_id
    resolvedSubjectType = 'member'
  }
  if (!resolvedSubjectId) return { code: 400, msg: '缺少主体标识（subjectId 或 subjectName）' }

  const now = new Date()
  const strategy = FACT_STRATEGIES[predicate] || 'dedup'
  // writeSeam 接缝：silent 写入 + 末尾统一 triggerHooks，避免多次 markFamilyMutated
  const ws = writeSeam(db, openid, familyId)
  if (strategy === 'dedup') {
    const exists = await db.collection('facts').where({ family_id: familyId, _openid: openid, subject_id: resolvedSubjectId, predicate, object_value: objectValue, status: 'active' }).limit(1).get()
    if (exists.data && exists.data.length > 0) return { code: 200, data: { action: 'skipped', reason: '已存在' } }
  }
  if (strategy === 'versioned') {
    // 5.2b：已 agent_confirmed 的事实不被普通事实覆盖（除非新事实也是 agent_confirmed）
    const whereActive = { family_id: familyId, subject_id: resolvedSubjectId, predicate, status: 'active' }
    if (source !== 'agent_confirmed' && _ && typeof _.neq === 'function') whereActive.source = _.neq('agent_confirmed')
    await ws.silentUpdateWhere('facts', whereActive, { status: 'superseded' }).catch(e => { console.error('[dataWrite] addFact versioned supersede 失败:', e.message); throw new Error('旧事实作废失败：' + e.message) })
  }
  let resolvedObjectId = objectId
  if (objectType === 'member' && objectName && !resolvedObjectId) {
    const objRes = await db.collection('members').where({ family_id: familyId, _openid: openid, name: objectName }).limit(1).get()
    if (objRes.data && objRes.data.length > 0) resolvedObjectId = objRes.data[0].member_id
  }
  const addRes = await ws.silentAdd('facts', {
    family_id: familyId,
    subject_type: resolvedSubjectType, subject_id: resolvedSubjectId, subject_name: resolvedSubjectName,
    predicate, object_type: objectType, object_id: resolvedObjectId, object_value: objectValue, object_value_type: 'string',
    confidence: conf, source, status: 'active', reasoning: reasoning || '', created_at: now
  })
  await ws.triggerHooks()
  // 高置信度事实反向同步回 members（健康/职业/收入），覆盖对话路径（表单路径由 _writeMemberFact 同步）
  await _syncFactToMember(db, familyId, openid, resolvedSubjectId, predicate, objectValue, conf)
  return { code: 200, data: { action: strategy === 'dedup' ? 'added' : strategy, factId: addRes._id } }
}

// ---------- addMemberFact ----------
// 成员级事实统一写入（predicate 三元组 + status 标记，供 buildPortrait 消费）
// 架构审计第 13 轮：从 fact-member-sync 移回，预设 subjectType:'member' + source:'user_form'，
// 消除 fact-write ↔ fact-member-sync 循环依赖根因。
async function addMemberFact(db, openid, { familyId, memberId, memberName, predicate, value, confidence = 1 }) {
  if (!memberId || !predicate) return
  return addFact(db, openid, {
    familyId, subjectId: memberId, subjectType: 'member', subjectName: memberName,
    predicate, objectValue: String(value), source: 'user_form', confidence
  })
}

// ---------- updateFactConfidence ----------
// 5.2a：代理人确认低置信度事实后，将其置信度升级为 1.0 并标记 agent_confirmed（受 5.2b 防降级/防覆盖保护）
// Bug-4 修复：重新激活已 superseded 的事实前，先 supersede 同 subject+predicate 的其他 active 事实，避免多 active
async function updateFactConfidence(db, openid, event) {
  const { familyId, factId, confidence = 1, source = 'agent_confirmed' } = event
  if (!familyId || !factId) return { code: 400, msg: '缺少 familyId/factId' }
  const cur = await db.collection('facts').doc(factId).get().catch(() => ({ data: null }))
  const rec = cur.data
  if (!rec || rec._openid !== openid || rec.family_id !== familyId) return { code: 404, msg: '未找到该事实或无权修改' }
  const ws = writeSeam(db, openid, familyId)
  // 重新激活前，先 supersede 同 subject+predicate 的其他 active 事实（避免多 active 并存）
  if (rec.subject_id && rec.predicate) {
    const _ = db.command
    await ws.silentUpdateWhere('facts', {
      family_id: familyId, _openid: openid,
      subject_id: rec.subject_id, predicate: rec.predicate,
      status: 'active', _id: _.neq(factId)
    }, { status: 'superseded' }).catch(e => console.error('[fact-write] updateFactConfidence supersede 失败:', e.message))
  }
  await ws.updateDoc('facts', factId, { confidence, source, status: 'active' })
  return { code: 200, data: { factId, confidence, source } }
}

// ---------- deleteFact ----------
// 软删事实（status:'superseded'），保留可追溯
async function deleteFact(db, openid, event) {
  const { familyId, factId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!factId) return { code: 400, msg: '缺少 factId' }
  const r = await db.collection('facts').where({ _id: factId, family_id: familyId, _openid: openid }).limit(1).get()
  if (!r.data || !r.data.length) return { code: 404, msg: '未找到该事实' }
  const ws = writeSeam(db, openid, familyId, { advanceStageHook: false })
  await ws.updateDoc('facts', r.data[0]._id, { status: 'superseded' }).catch(e => { console.error('[dataWrite] deleteFact 失败:', e.message); throw new Error('事实删除失败：' + e.message) })
  return { code: 200, data: { deleted: true, factId } }
}

module.exports = { addFact, addMemberFact, updateFactConfidence, deleteFact, FACT_STRATEGIES, DIM_TO_PREDICATE }
