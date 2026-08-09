/**
 * family-write — 家庭 CRUD + 阶段设置领域
 *
 * 导出：createFamily / updateFamilyHandler / deleteFamilyHandler / setStage
 * 私有（同模块内使用）：_updateFamilyHandleUpdateData / _syncMembers / _updateCompletenessAsync / _updateFamilyDelete
 *
 * 依赖关系：
 *   - createFamily 调用 memberRepo.createMembersForFamily（成员批量创建）
 *   - _syncMembers 调用 memberRepo.createMembersForFamily（diff 同步新增成员）
 *   - _updateFamilyDelete 用 writeSeam.batchRemove 级联删除（members 亦纳入 batchTx，strict 失败可感知）
 *   - 不依赖 fact-write / member-write / policy-write / message-write
 */
const _ = require('wx-server-sdk').database().command
const { getFamily, updateFamily, deleteFamily, safeQuery } = require('./_shared/db-helpers')
const { writeSeam, advanceStage, markFamilyMutated } = require('./_shared/writeSeam')
const { calcCompletenessScore } = require('./_shared/completeness')
const { ALLOWED_FIELDS, isSafeKey } = require('./constants')
const { STAGES } = require('./_shared/domain/stageMachine')
const { upsertFinances, createMembersForFamily } = require('./_shared/memberRepo')
const { loadFamilyView } = require('./_shared/familyView')
const { wrapError } = require('./_shared/errorHandler')

// ---------- createFamily ----------
// Plan A：先建 families 文档，成员写入 members 集合（不再内嵌 families.members）
async function createFamily(db, openid, event) {
  const { family_name, family_structure, members } = event
  if (!family_name || family_name.trim() === '') return { code: 400, msg: '家庭名称不能为空' }
  if (!members || !Array.isArray(members) || members.length === 0) return { code: 400, msg: '至少需要一个家庭成员' }
  const dupCount = await db.collection('families').where({ family_name: family_name.trim(), _openid: openid, status: _.neq('deleted') }).count()
  if (dupCount.total > 0) return { code: 409, msg: '已存在同名家庭：' + family_name.trim() }
  const now = new Date()
  const ws = writeSeam(db, openid) // 无 familyId，不触发钩子（新建家庭）
  const result = await ws.silentAdd('families', { family_name: family_name.trim(), family_structure: { roles: [], member_count: members.length, created_with_roles: family_structure || [] }, confirmed_health: null, health_confirmed: false, has_portrait: false, completeness_score: 0, engagement_stage: 'onboarding', memo: '', status: 'active', profile_state: 'collecting', created_at: now, updated_at: now })
  const familyId = result._id
  const created = await createMembersForFamily(db, familyId, openid, members)
  const structure = { roles: created.map(m => m.role), member_count: created.length, created_with_roles: family_structure || created.map(m => m.role) }
  try { await updateFamily(db, familyId, openid, { family_structure: structure }) } catch (e) { console.error('[dataWrite] createFamily 结构更新失败:', e.message) }
  const lockedMembers = created.map(m => ({ member_id: m.member_id, name: m.name, gender: m.gender, age: m.age, role: m.role, occupation: m.occupation, health: m.health, income: m.income }))
  return { code: 200, msg: '创建成功', data: { _id: familyId, family_name: family_name.trim(), members: lockedMembers, family_structure: structure } }
}

// ---------- updateFamily ----------
// 注意：本地 handler 重命名为 updateFamilyHandler，避免与 db-helpers 导入的 updateFamily 冲突
async function updateFamilyHandler(db, openid, event) {
  const { familyId, field, value, operator = 'set', updateData: updateDataInput, subAction } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (updateDataInput && typeof updateDataInput === 'object') return _updateFamilyHandleUpdateData(db, familyId, openid, updateDataInput)
  if (!field) return { code: 400, msg: '缺少参数 field' }
  if (!ALLOWED_FIELDS.includes(field)) return { code: 400, msg: '不允许更新字段：' + field }
  try {
    const updateData = {}
    switch (operator) {
      case 'set': updateData[field] = value; break; case 'push': updateData[field] = db.command.push(Array.isArray(value) ? value : [value]); break
      case 'pull': updateData[field] = db.command.pull(value); break; case 'inc': updateData[field] = db.command.inc(value); break
      default: updateData[field] = value
    }
    if (field === 'members' || field === 'financial_snapshot') {
      return { code: 400, msg: '请使用对应写接口修改成员/财务' }
    }
    const ws = writeSeam(db, openid, familyId, { advanceStageHook: false })
    const updated = await ws.updateWhere('families', { _id: familyId }, updateData)
    if (updated === 0) return { code: 404, msg: '记录不存在或无权修改' }
    return { code: 200, msg: '更新成功', data: { updated } }
  } catch (e) { return wrapError('更新', e) }
}

async function _updateFamilyHandleUpdateData(db, familyId, openid, updateDataInput) {
  const updateData = {}; let needCompletenessCalc = false
  for (const key of Object.keys(updateDataInput)) {
    if (key === 'updated_at') { updateData[key] = new Date(); continue }
    if (key === 'financial_snapshot') {
      // 家庭财务 → finances 集合（唯一真相源，数值审计 #2：统一存元键——表单输入为万，×10000 转元）
      const snap = updateDataInput[key] || {}
      const patch = {}
      if (snap.income !== undefined) patch.annual_income = Number(snap.income) * 10000
      if (snap.debt !== undefined) patch.total_debt = Number(typeof snap.debt === 'object' ? (snap.debt.amount != null ? snap.debt.amount : 0) : snap.debt) * 10000
      if (snap.debt && snap.debt.type !== undefined) patch.debt_type = snap.debt.type
      if (snap.fixed_expense !== undefined) patch.fixed_annual_expense = Number(snap.fixed_expense) * 10000
      if (snap.annual_premium_budget !== undefined) patch.annual_premium_budget = snap.annual_premium_budget
      if (Object.keys(patch).length > 0) await upsertFinances(db, familyId, openid, patch)
      needCompletenessCalc = true
      continue
    }
    if (key === 'members') {
      // 按成员 diff 同步（保留 member_id，避免破坏 policies/facts 跨集合关联）
      await _syncMembers(db, familyId, openid, updateDataInput[key] || [])
      needCompletenessCalc = true
      continue
    }
    const topKey = key.indexOf('.') > -1 ? key.substring(0, key.indexOf('.')) : key
    if (!ALLOWED_FIELDS.includes(topKey) && !ALLOWED_FIELDS.includes(key)) { console.warn('[dataWrite] updateFamily 忽略不允许的字段:', key); continue }
    if (!isSafeKey(key)) { console.warn('[dataWrite] updateFamily 忽略不安全的嵌套键:', key); continue }
    updateData[key] = updateDataInput[key]
    if (topKey === 'soft_profile') { needCompletenessCalc = true; Object.assign(updateData, { insight_stale: true, updated_at: new Date() }) }
  }
  if (Object.keys(updateData).length > 0) {
    const ws = writeSeam(db, openid, familyId, { advanceStageHook: false })
    const updated = await ws.updateWhere('families', { _id: familyId }, updateData)
    if (updated === 0) return { code: 404, msg: '记录不存在或无权修改' }
  }
  if (needCompletenessCalc) await _updateCompletenessAsync(db, familyId, openid)
  return { code: 200, msg: '更新成功', data: { updated: 1 } }
}

// 按成员 diff 同步：现有成员按 member_id 原地更新（保留 _id/member_id，避免 policies/facts 关联断裂）；
// 新成员（member_id 不在库中）创建；库中存在但不在 incoming 列表的成员软删除。
async function _syncMembers(db, familyId, openid, incoming) {
  const existing = await safeQuery(db, 'members', { family_id: familyId }, openid)
  // R-2 修复：原 50% 阈值会误拦正常批量删除；改为仅拦截 incoming 为空导致的整表误清空
  const existingActive = (existing.data || []).filter(m => m.status !== 'deleted')
  if (existingActive.length > 0 && incoming.length === 0) {
    throw new Error('成员列表为空，请确认后重试')
  }
  const existingMap = new Map()
  for (const m of (existing.data || [])) {
    if (m.member_id) existingMap.set(m.member_id, m)
  }
  const now = new Date()
  const incomingIds = new Set()
  // _syncMembers 是事务中途的批量写入，silent 模式避免 N 次重复钩子；末尾统一 triggerHooks
  const ws = writeSeam(db, openid, familyId, { markMutated: false, advanceStageHook: false })
  for (const m of incoming) {
    let mid = m.member_id
    if (!mid) {
      // 新增成员无 member_id 时主动生成 mem_ 前缀 id，走创建路径
      mid = 'mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)
    }
    incomingIds.add(mid)
    const ex = existingMap.get(mid)
    if (ex) {
      // 原地更新（仅写传入字段，保留 _id 与 member_id）
      const patch = { updated_at: now }
      // S3-6 修复：重添同 member_id 的已软删成员时恢复 status='active'
      // 原实现不写 status，用户重新添加后得到"更新成功"但成员仍处于 deleted 状态，前端列表看不到
      if (ex.status === 'deleted') patch.status = 'active'
      if (m.name !== undefined) patch.name = m.name
      if (m.age !== undefined) patch.age = Number(m.age) || 0
      if (m.income !== undefined) patch.income = Number(m.income) || 0
      if (m.role !== undefined) patch.role = m.role
      if (m.gender !== undefined) patch.gender = m.gender
      if (m.occupation !== undefined) patch.occupation = m.occupation
      if (m.health !== undefined) patch.health = m.health
      if (m.birth_date !== undefined) patch.birth_date = m.birth_date
      await ws.silentUpdateDoc('members', ex._id, patch)
    } else {
      // 新成员 → 创建（member_id 非 mem_ 前缀则生成，防前端 m_ 临时 id 入库）
      const newId = mid.indexOf('mem_') === 0 ? mid : ('mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6))
      await createMembersForFamily(db, familyId, openid, [{ ...m, member_id: newId }])
    }
  }
  // 库中存在但不在 incoming 列表的成员 → 软删除（保留文档以维持历史事实关联）
  for (const ex of (existing.data || [])) {
    if (ex.member_id && !incomingIds.has(ex.member_id) && ex.status !== 'deleted') {
      await ws.silentUpdateDoc('members', ex._id, { status: 'deleted', updated_at: now }).catch(e => console.error('[dataWrite] _syncMembers 软删失败:', e.message))
    }
  }
  // 成员同步（增/改/删）→ 显式触发 markMutated + advanceStage（ws.shouldHook=false 时 triggerHooks 为 no-op）
  await markFamilyMutated(db, familyId, openid)
  await advanceStage(db, familyId, openid)
}

async function _updateCompletenessAsync(db, familyId, openid) {
  try {
    const family = await loadFamilyView(db, openid, familyId)
    if (!family) return
    const hasMembers = (family.members || []).length > 0
    const polRes = await db.collection('policies').where({ family_id: familyId, _openid: openid }).limit(100).get()
    const score = calcCompletenessScore(family, polRes.data || [])
    const stateUpdate = { completeness_score: score }
    if (family.profile_state === 'not_ready' && hasMembers && (polRes.data || []).length > 0) stateUpdate.profile_state = 'ready'
    const ws = writeSeam(db, openid, familyId)
    await ws.updateWhere('families', { _id: familyId }, stateUpdate)
  } catch (e) { console.error('[dataWrite] _updateCompletenessAsync 失败:', e) }
}

async function _updateFamilyDelete(db, familyId, openid) {
  try {
    const family = await getFamily(db, familyId, openid)
    if (!family) return { code: 404, msg: '记录不存在或无权操作' }
    // 级联删除审计 #1 修复：成员删除纳入 batchTx（strict 失败可感知 → 触发 207 保留 family 可重试），
    // 原 deleteMembersForFamily 事务外静默吞错 → 家庭已删但成员孤儿残留
    // 全链路审计 PM5：先 batchTx 删关联数据，再删 family 文档——原顺序先删 family，
    // batchTx 失败时残留 policies/facts 等孤儿（family 已不存在，无入口再清理）
    const ws = writeSeam(db, openid, familyId, { markMutated: false, advanceStageHook: false })
    const txResult = await ws.batchTx([
      { name: 'members', exec: () => ws.batchRemove('members', { family_id: familyId }, 100, true) },
      { name: 'messages', exec: () => ws.batchRemove('messages', { family_id: familyId }, 100, true) },
      { name: 'facts', exec: () => ws.batchRemove('facts', { family_id: familyId }, 100, true) },
      { name: 'insights', exec: () => ws.batchRemove('insights', { family_id: familyId }, 100, true) },
      { name: 'policies', exec: () => ws.batchRemove('policies', { family_id: familyId }, 100, true) },
      { name: 'policy_cash_values', exec: () => ws.batchRemove('policy_cash_values', { family_id: familyId }, 100, true) },
      { name: 'finances', exec: () => ws.batchRemove('finances', { family_id: familyId }, 100, true) },
      { name: 'reports', exec: () => ws.batchRemove('reports', { family_id: familyId }, 100, true) },
      { name: 'operation_logs', exec: () => ws.batchRemove('operation_logs', { family_id: familyId }, 100, true) },
      { name: 'agent_logs', exec: () => ws.batchRemove('agent_logs', { family_id: familyId }, 100, true) },
      // 清理 OCR 阶段未关联 familyId 的孤儿日志（匹配前调用，family_id 为空字符串）
      // 级联删除审计 #4：agent_logs 的 '' 孤儿与 operation_logs 对齐一并清理
      { name: 'orphan_logs', exec: () => ws.batchRemove('operation_logs', { family_id: '' }, 100, true) },
      { name: 'orphan_agent_logs', exec: () => ws.batchRemove('agent_logs', { family_id: '' }, 100, true) }
    ])
    const total = (txResult.results || []).reduce((a, b) => a + (b || 0), 0)
    // 部分失败时返回 partial 标记：保留 family 文档（可重试清理），避免孤儿数据
    if (txResult.failed > 0) {
      console.error('[dataWrite] deleteFamily 部分级联失败:', JSON.stringify(txResult.errors))
      return { code: 207, msg: '部分级联数据清理失败，家庭未删除，可重试', partial: true, cascadeCleaned: total, errors: txResult.errors }
    }
    // 全链路审计 PM5：关联数据全部清理成功后，最后删 family 文档
    await deleteFamily(db, familyId, openid)
    return { code: 200, msg: '删除成功', cascadeCleaned: total }
  } catch (e) { return wrapError('删除', e) }
}

// ---------- deleteFamily ----------
// 注意：本地 handler 重命名为 deleteFamilyHandler，避免与 db-helpers 导入的 deleteFamily 冲突
async function deleteFamilyHandler(db, openid, event) {
  const { familyId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  return _updateFamilyDelete(db, familyId, openid)
}

// ---------- setStage ----------
async function setStage(db, openid, event) {
  const { familyId, stage } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!STAGES.includes(stage)) return { code: 400, msg: '不支持的阶段：' + stage }
  // setStage 直接设置阶段，无需 advanceStage 钩子
  const ws = writeSeam(db, openid, familyId, { advanceStageHook: false })
  await ws.updateWhere('families', { _id: familyId }, { engagement_stage: stage })
  return { code: 200, data: { stage } }
}

module.exports = { createFamily, updateFamilyHandler, deleteFamilyHandler, setStage }
