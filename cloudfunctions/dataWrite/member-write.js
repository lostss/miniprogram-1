/**
 * member-write — 成员操作领域
 *
 * 导出：recordField / writeNote / updateMember / deleteMember
 *
 * 依赖关系（单向，无循环）：
 *   - member-write → fact-write（addFact / DIM_TO_PREDICATE）
 *   - fact-write → fact-member-sync（_syncFactToMember）
 */
const { detectInjection } = require('./_shared/guard')
const { writeSeam } = require('./_shared/writeSeam')
const { ALLOWED_DIMENSIONS, FAMILY_DIMENSIONS_ZH, ZH_TO_EN } = require('./member-dimensions')
const { setMemberField, upsertFinances } = require('./_shared/memberRepo')
const { VALID_ROLES } = require('./constants')
const { addFact, DIM_TO_PREDICATE } = require('./fact-write')

// ---------- recordField ----------
// Plan A：家庭级财务 → finances 集合；成员级字段 → members 集合（唯一真相源）
async function recordField(db, openid, event) {
  const familyId = event.familyId
  let memberId = event.memberId || (event.data && event.data.memberId) || null
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  const data = event.data
  if (!data || !data.dimension || !data.value) return { code: 400, msg: '缺少事实数据（dimension/value）' }
  if (!ALLOWED_DIMENSIONS.has(data.dimension)) return { code: 400, msg: '不支持的维度：' + data.dimension }
  const scope = FAMILY_DIMENSIONS_ZH.has(data.dimension) ? 'family' : 'member'
  if (scope === 'family') memberId = null
  const valueStr = String(data.value)
  if (valueStr.length > 200) return { code: 400, msg: '事实值过长（≤200字）' }
  if (detectInjection(valueStr).injected || detectInjection(data.dimension).injected) {
    return { code: 400, msg: '内容校验未通过' }
  }

  // 家庭级财务维度 → finances 集合
  const FIN_SYNC = { '收入': 'income', '负债': 'debt', '固定支出': 'fixed_expense', '年保费预算': 'annual_premium_budget' }
  if (scope === 'family' && FIN_SYNC[data.dimension]) {
    const patch = {}
    if (data.dimension === '负债') {
      const m = String(data.value).match(/([\d.]+)/)
      patch.debt = m ? (parseFloat(m[1]) || 0) : 0
      const t = String(data.value).match(/[一-龥]+/g)
      patch.debt_type = (t && t.join('')) || ''
    } else {
      const num = Number(data.value)
      patch[FIN_SYNC[data.dimension]] = isNaN(num) ? data.value : num
    }
    await upsertFinances(db, familyId, openid, patch)
    // upsertFinances 内部经 writeSeam 已触发 markMutated + advanceStage，无需重复
    return { code: 200, data: { written: true, scope } }
  }

  // 成员级维度 → members 集合 + facts 集合（双写）
  if (scope === 'member' && memberId) {
    const memberField = ZH_TO_EN[data.dimension]
    if (memberField) {
      const numMatch = String(data.value).match(/(\d+)/)
      const val = data.dimension === '年龄' ? (numMatch ? parseInt(numMatch[1], 10) : data.value) : data.value
      const r = await setMemberField(db, familyId, openid, memberId, memberField, val)
      if (r.code !== 200) return r
    }
  }
  // 无论家庭/成员维度，同步写入 facts 集合（portrait 消费源）
  const pred = DIM_TO_PREDICATE[data.dimension]
  if (pred) {
    await addFact(db, openid, { familyId, subjectId: memberId || '', subjectType: memberId ? 'member' : 'family', subjectName: '', predicate: pred, objectValue: valueStr, source: 'user_form', confidence: 1 })
    // addFact 内部经 writeSeam 已触发 markMutated + advanceStage，无需重复
    // setMemberField 用 silent 模式未触发钩子，此处补一次确保成员字段变更也触发
    if (scope === 'member' && memberId && memberField) {
      const ws = writeSeam(db, openid, familyId)
      await ws.triggerHooks()
    }
    return { code: 200, data: { written: true, scope } }
  }
  // 仅 setMemberField（无 facts 同步）→ 手动触发钩子
  const ws = writeSeam(db, openid, familyId)
  await ws.triggerHooks()
  return { code: 200, data: { written: true, scope } }
}

// ---------- writeNote ----------
// 自由文本事实：用于记录无法结构化的描述性信息（如"全家都有百万医疗""客户偏好外资险企"）
async function writeNote(db, openid, event) {
  const familyId = event.familyId
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  const data = event.data
  if (!data || !data.content || !data.content.trim()) return { code: 400, msg: '缺少备注内容' }
  const content = data.content.trim().substring(0, 500)
  if (detectInjection(content).injected) return { code: 400, msg: '内容校验未通过' }
  let noteSubject = ''
  if (data.memberId) {
    const nmRes = await db.collection('members').where({ family_id: familyId, _openid: openid, member_id: data.memberId }).limit(1).get()
    if (nmRes.data && nmRes.data.length > 0) noteSubject = nmRes.data[0].name || ''
  }
  // S2-3 修复：用 addFact 返回的 factId 直接更新，消除 where+orderBy 重查的竞态
  // 原实现：并发 writeNote（同内容）各自重查拿到对方刚写入的 factId，category 写到错的 fact 上
  const addRes = await addFact(db, openid, {
    familyId,
    subjectId: data.memberId || '',
    subjectType: data.memberId ? 'member' : 'family',
    subjectName: noteSubject,
    predicate: '备注',
    objectValue: content,
    source: 'user_form',
    confidence: data.confidence || 1
  })
  // 补充备注特有字段（addFact 不处理 content/category）
  if (data.category && addRes.code === 200 && addRes.data && addRes.data.factId) {
    const ws = writeSeam(db, openid, familyId, { advanceStageHook: false })
    await ws.updateDoc('facts', addRes.data.factId, { content, category: data.category }).catch(e => console.error('[dataWrite] writeNote category 更新失败:', e.message))
  }
  // addFact 已触发 markFamilyMutated，无需重复
  return { code: 200, data: { written: true } }
}

// ---------- updateMember ----------
// Plan A：直接修改 members 集合中某个成员的指定字段
async function updateMember(db, openid, event) {
  const { familyId, memberId, field, value, data } = event
  const memId = memberId || (data && data.memberId)
  const fld = field || (data && data.field)
  const val = value !== undefined ? value : (data && data.value)
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!memId) return { code: 400, msg: '缺少参数 memberId' }
  if (!fld) return { code: 400, msg: '缺少参数 field' }

  const ALLOWED_MEMBER_FIELDS = ['name', 'age', 'gender', 'role', 'health', 'occupation', 'income']
  if (!ALLOWED_MEMBER_FIELDS.includes(fld)) return { code: 400, msg: '不允许修改成员字段：' + fld }

  // 校验值
  let safeValue = val
  if (fld === 'age' || fld === 'income') {
    const n = Number(val)
    if (isNaN(n)) return { code: 400, msg: fld + ' 必须为数字' }
    safeValue = fld === 'age' ? Math.floor(n) : n
  } else if (fld === 'gender') {
    if (!['男', '女'].includes(String(val))) return { code: 400, msg: 'gender 必须为"男"或"女"' }
    safeValue = String(val)
  } else if (fld === 'role') {
    if (!VALID_ROLES.includes(String(val))) return { code: 400, msg: 'role 必须为：' + VALID_ROLES.join('/') }
    safeValue = String(val)
  } else {
    safeValue = String(val)
    if (safeValue.length > 100) return { code: 400, msg: fld + ' 过长（≤100字）' }
    if (detectInjection(safeValue).injected) return { code: 400, msg: '内容校验未通过' }
  }

  const r = await setMemberField(db, familyId, openid, memId, fld, safeValue)
  if (r.code !== 200) return r
  // B2: 成员字段变更 → 经 writeSeam 统一触发 markMutated + advanceStage（setMemberField 内部 silent 未触发）
  const ws = writeSeam(db, openid, familyId)
  await ws.triggerHooks()
  return { code: 200, data: { updated: true, memberId: memId, field: fld, value: safeValue } }
}

// ---------- deleteMember ----------
// 单成员删除：移除 members 文档 + 级联软删该成员相关事实（subject_type:'member'）
async function deleteMember(db, openid, event) {
  const { familyId, memberId, memberName } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!memberId && !memberName) return { code: 400, msg: '缺少 memberId 或 memberName' }
  let target = null
  if (memberId) {
    const r = await db.collection('members').where({ family_id: familyId, _openid: openid, member_id: memberId }).limit(1).get()
    if (r.data && r.data.length) target = r.data[0]
  }
  if (!target && memberName) {
    const r = await db.collection('members').where({ family_id: familyId, _openid: openid, name: memberName }).limit(1).get()
    if (r.data && r.data.length) target = r.data[0]
  }
  if (!target) return { code: 404, msg: '未找到该成员' }
  const mid = target.member_id
  const ws = writeSeam(db, openid, familyId)
  // S2-4 修复：不再静默吞错，失败时聚合标记返回 partial，让用户知道删除未完成
  const failures = []
  await ws.silentRemoveDoc('members', target._id).catch(e => { console.error('[dataWrite] deleteMember 失败:', e.message); failures.push('members') })
  await ws.silentUpdateWhere('facts', { subject_type: 'member', subject_id: mid, status: 'active' }, { status: 'superseded' }).catch(e => { console.error('[dataWrite] deleteMember supersede 失败:', e.message); failures.push('facts') })
  await ws.triggerHooks()
  if (failures.length > 0) return { code: 207, partial: true, msg: '部分删除失败：' + failures.join(','), data: { deleted: failures.length === 0, memberId: mid, name: target.name } }
  return { code: 200, data: { deleted: true, memberId: mid, name: target.name } }
}

module.exports = { recordField, writeNote, updateMember, deleteMember }
