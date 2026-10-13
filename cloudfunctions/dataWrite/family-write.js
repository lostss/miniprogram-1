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
// 2026-09-22 全面审计（死代码清理）：原 `calcCompletenessScore`（_shared/completeness）与
// `loadFamilyView`（_shared/familyView）两个 require 已删除——本模块改用 completeness-sync
// 的 syncCompleteness 后，这两个导入再也没有任何引用。
const { ALLOWED_FIELDS, isSafeKey } = require('./constants')
const { upsertFinances, createMembersForFamily, _MEMBER_FIELDS } = require('./_shared/memberRepo')
const { wrapError } = require('./_shared/errorHandler')
const { wanToYuan } = require('./_shared/amount')
// 成员移除时的事实层清理：与 member-write.deleteMember 共用同一实现
// （2026-09-19 抽出，P2-7；2026-09-20 曾加"保单解链"，2026-09-22 因**无效且违反数据模型规则**
//   已回退 —— 证据与原因见 member-facts.js 文件头）
const { supersedeMemberFacts } = require('./member-facts')
// 完整度重算：2026-09-19 从本模块私有实现抽出，供保单写路径共用（流程审计 UX3）
const { syncCompleteness } = require('./completeness-sync')

// ---------- createFamily ----------
// Plan A：先建 families 文档，成员写入 members 集合（不再内嵌 families.members）
async function createFamily(db, openid, event) {
  const { family_name, family_structure, members } = event
  if (!family_name || family_name.trim() === '') return { code: 400, msg: '家庭名称不能为空' }
  // 2026-09-12 放开"无成员建档"：第一次见面、还没拿到保单时最需要先建客户档案，
  // 成员可后续补（readiness 会引导补全）。原校验（至少一个成员）把最需要的时点挡在门外。
  if (members != null && !Array.isArray(members)) return { code: 400, msg: '成员参数格式错误' }
  const memberList = Array.isArray(members) ? members : []
  const dupCount = await db.collection('families').where({ family_name: family_name.trim(), _openid: openid, status: _.neq('deleted') }).count()
  if (dupCount.total > 0) return { code: 409, msg: '已存在同名家庭：' + family_name.trim() }
  const now = new Date()
  const ws = writeSeam(db, openid) // 无 familyId，不触发钩子（新建家庭）
  const result = await ws.silentAdd('families', { family_name: family_name.trim(), family_structure: { roles: [], member_count: memberList.length, created_with_roles: family_structure || [] }, confirmed_health: null, health_confirmed: false, has_portrait: false, completeness_score: 0, engagement_stage: 'onboarding', memo: '', status: 'active', profile_state: 'collecting', created_at: now, updated_at: now })
  const familyId = result._id
  const created = await createMembersForFamily(db, familyId, openid, memberList)
  const structure = { roles: created.map(m => m.role), member_count: created.length, created_with_roles: family_structure || created.map(m => m.role) }
  try { await updateFamily(db, familyId, openid, { family_structure: structure }) } catch (e) { console.error('[dataWrite] createFamily 结构更新失败:', e.message) }
  const lockedMembers = created.map(m => ({ member_id: m.member_id, name: m.name, gender: m.gender, age: m.age, role: m.role, occupation: m.occupation, health: m.health, income: m.income }))
  return { code: 200, msg: '创建成功', data: { _id: familyId, family_name: family_name.trim(), members: lockedMembers, family_structure: structure } }
}

// ---------- updateFamily ----------
// 注意：本地 handler 重命名为 updateFamilyHandler，避免与 db-helpers 导入的 updateFamily 冲突
async function updateFamilyHandler(db, openid, event) {
  const { familyId, field, value, operator = 'set', updateData: updateDataInput } = event
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
  // 2026-09-28 审计 P2：成员同步的失败标签（软删未命中 / 事实清理失败）→ 末尾并入 207 partial
  const memberSyncFailures = []
  // 2026-09-19（流程审计 P2-7）：members 整组覆盖的**删除基线** —— 客户端加载后见过的 member_id 集合。
  // 只用于判定"哪些成员是用户本次真移除的"，不落库（故不进 ALLOWED_FIELDS）。
  // 缺省（未传）→ null，_syncMembers 沿用旧行为（凡不在 incoming 者皆软删），避免老调用方删除静默失效。
  const baselineIds = Array.isArray(updateDataInput && updateDataInput.members_baseline)
    ? new Set(updateDataInput.members_baseline.filter(Boolean))
    : null
  for (const key of Object.keys(updateDataInput)) {
    if (key === 'updated_at') { updateData[key] = new Date(); continue }
    if (key === 'members_baseline') continue // 仅作基线消费，不写库
    if (key === 'financial_snapshot') {
      // 家庭财务 → finances 集合（唯一真相源，数值审计 #2：统一存元键——表单输入为万，×10000 转元）
      const snap = updateDataInput[key] || {}
      const patch = {}
      if (snap.income !== undefined) patch.annual_income = wanToYuan(snap.income)
      if (snap.debt !== undefined) patch.total_debt = wanToYuan(typeof snap.debt === 'object' ? (snap.debt.amount != null ? snap.debt.amount : 0) : snap.debt)
      if (snap.debt && snap.debt.type !== undefined) patch.debt_type = snap.debt.type
      if (snap.annual_premium_budget !== undefined) patch.annual_premium_budget = snap.annual_premium_budget
      if (Object.keys(patch).length > 0) await upsertFinances(db, familyId, openid, patch)
      needCompletenessCalc = true
      continue
    }
    if (key === 'members') {
      // 按成员 diff 同步（保留 member_id，避免破坏 policies/facts 跨集合关联）
      // 2026-09-28 审计 P2：软删/事实清理失败必须披露（原先整体丢弃 → 成员在册却丢光事实还回 200）
      const sync = await _syncMembers(db, familyId, openid, updateDataInput[key] || [], baselineIds)
      if (sync && sync.reject) return sync.reject
      if (sync && sync.failures && sync.failures.length) memberSyncFailures.push(...sync.failures)
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
  if (needCompletenessCalc) await syncCompleteness(db, familyId, openid)
  // 2026-09-28 审计 P2：与 deleteMember 同口径 —— 部分失败必须让用户知道，不能一律"更新成功"
  if (memberSyncFailures.length) {
    return { code: 207, partial: true, msg: '成员部分同步失败：' + memberSyncFailures.join(','), data: { updated: 1 } }
  }
  return { code: 200, msg: '更新成功', data: { updated: 1 } }
}

// 按成员 diff 同步：现有成员按 member_id 原地更新（保留 _id/member_id，避免 policies/facts 关联断裂）；
// 新成员（member_id 不在库中）创建；库中存在但不在 incoming 列表的成员软删除。
async function _syncMembers(db, familyId, openid, incoming, baselineIds) {
  const existing = await safeQuery(db, 'members', { family_id: familyId }, openid)
  // R-2 修复：原 50% 阈值会误拦正常批量删除；改为仅拦截 incoming 为空导致的整表误清空
  const existingActive = (existing.data || []).filter(m => m.status !== 'deleted')
  if (existingActive.length > 0 && incoming.length === 0) {
    // 2026-09-28 审计 P3：原为 `throw new Error(...)`，被 createHandler 兜成 500「写入失败，请稍后重试」，
    // 这句面向用户的提示永远到不了界面。改为结构化拒绝，由调用方原样上抛（400）。
    return { failures: [], reject: { code: 400, msg: '成员列表为空，请确认后重试' } }
  }
  const existingMap = new Map()
  for (const m of (existing.data || [])) {
    if (m.member_id) existingMap.set(m.member_id, m)
  }
  const now = new Date()
  const incomingIds = new Set()
  // 2026-09-28 全面审计 P2：收集软删/事实清理的失败标签，由调用方并入 207 partial 披露。
  // 原实现把这些失败**整体丢弃**，与 member-facts 模块头注释（"不要在内部吞掉失败再返回空数组，
  // 否则部分删除失败披露会失效"）以及 deleteMember 的 207 口径都不一致。
  const memberSyncFailures = []
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
      // 候选 4：字段白名单单源（memberRepo._MEMBER_FIELDS），age/income 数字归一语义保留
      const patch = { updated_at: now }
      // S3-6 修复：重添同 member_id 的已软删成员时恢复 status='active'
      // 原实现不写 status，用户重新添加后得到"更新成功"但成员仍处于 deleted 状态，前端列表看不到
      if (ex.status === 'deleted') patch.status = 'active'
      for (const f of _MEMBER_FIELDS) {
        if (m[f] === undefined) continue
        patch[f] = (f === 'age' || f === 'income') ? (Number(m[f]) || 0) : m[f]
      }
      await ws.silentUpdateDoc('members', ex._id, patch)
    } else {
      // 新成员 → 创建（member_id 非 mem_ 前缀则生成，防前端 m_ 临时 id 入库）
      const newId = mid.indexOf('mem_') === 0 ? mid : ('mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6))
      await createMembersForFamily(db, familyId, openid, [{ ...m, member_id: newId }])
    }
  }
  // 库中存在但不在 incoming 列表的成员 → 软删除（保留文档以维持历史事实关联）
  for (const ex of (existing.data || [])) {
    if (!ex.member_id || incomingIds.has(ex.member_id) || ex.status === 'deleted') continue
    // 2026-09-19 修（流程审计 P2-7）：只软删"客户端**基线**里见过、且本次被移除"的成员。
    // 原实现把"库内存在但 incoming 里没有"一律软删 → 编辑 Sheet 打开期间别处（对话/多端）
    // 新增的成员，会因不在陈旧快照里而被误删（用户只是改了另一个成员的职业）。
    // 缺省（未传基线）时保持旧行为，避免老调用方删除能力静默失效。
    if (baselineIds && !baselineIds.has(ex.member_id)) {
      console.warn('[dataWrite] _syncMembers 跳过软删（不在客户端基线内，判为并发新增）:', ex.member_id)
      continue
    }
    // 2026-09-28 全面审计 P2（已实测复现的数据丢失）：软删写失败此前被 `.catch` 吞掉，
    // 紧随其后的 supersedeMemberFacts 照旧执行、接口仍返回 200「更新成功」→ 成员**仍在册**
    // （报告/画像照常显示）但其职业/健康/保障边 facts 已被全部 superseded，且用户被告知成功。
    // 现：先确认软删真的命中（stats.updated），成功才清理事实；失败则把标签并入 207 披露。
    const delRes = await ws.silentUpdateDoc('members', ex._id, { status: 'deleted', updated_at: now })
      .then(r => ({ ok: true, r }))
      .catch(e => { console.error('[dataWrite] _syncMembers 软删失败:', e.message); return { ok: false } })
    const updated = delRes.ok && ((delRes.r && delRes.r.stats && delRes.r.stats.updated) || 0)
    if (!delRes.ok || updated === 0) {
      // 未命中/失败：**不要**清理事实（否则成员在册却丢光事实），如实上报
      memberSyncFailures.push('members:' + ex.member_id)
      continue
    }
    // 2026-09-19 修（同上）：软删必须同步清理关联事实——原先此路径完全不做，
    // 报告页删除成员会留下 active 的「拥有保障/职业/健康」孤儿事实，画像与 AI 上下文继续读出该成员。
    // 与 deleteMember 共用同一实现（dataWrite/member-facts.js）。
    memberSyncFailures.push(...await supersedeMemberFacts(db, ws, familyId, openid, ex.member_id))
  }
  // 成员同步（增/改/删）→ 显式触发 markMutated + advanceStage（ws.shouldHook=false 时 triggerHooks 为 no-op）
  await markFamilyMutated(db, familyId, openid)
  await advanceStage(db, familyId, openid)
  // 失败标签上抛（failures 空 = 全部成功）；调用方据此返回 207 partial，不再对用户谎报"更新成功"
  return { failures: memberSyncFailures, reject: null }
}

// _updateCompletenessAsync 已迁至 completeness-sync.syncCompleteness（2026-09-19）——
// 保单写路径同样需要重算，留在本模块私有会让「写保单不更新完整度」继续存在。

async function _updateFamilyDelete(db, familyId, openid) {
  try {
    const family = await getFamily(db, familyId, openid)
    if (!family) return { code: 404, msg: '记录不存在或无权操作' }
    // 级联删除审计 #1 修复：成员删除纳入 batchTx（strict 失败可感知 → 触发 207 保留 family 可重试），
    // 原 deleteMembersForFamily 事务外静默吞错 → 家庭已删但成员孤儿残留
    // （该函数已于 2026-09-27 作为死代码删除，这里是唯一提到它的地方，保留作历史依据）
    // 全链路审计 PM5：先 batchTx 删关联数据，再删 family 文档——原顺序先删 family，
    // batchTx 失败时残留 policies/facts 等孤儿（family 已不存在，无入口再清理）
    const ws = writeSeam(db, openid, familyId, { markMutated: false, advanceStageHook: false })
    const cascadeSteps = [
      { name: 'members', exec: () => ws.batchRemove('members', { family_id: familyId }, 100, true) },
      { name: 'messages', exec: () => ws.batchRemove('messages', { family_id: familyId }, 100, true) },
      { name: 'facts', exec: () => ws.batchRemove('facts', { family_id: familyId }, 100, true) },
      { name: 'insights', exec: () => ws.batchRemove('insights', { family_id: familyId }, 100, true) },
      { name: 'policies', exec: () => ws.batchRemove('policies', { family_id: familyId }, 100, true) },
      { name: 'policy_cash_values', exec: () => ws.batchRemove('policy_cash_values', { family_id: familyId }, 100, true) },
      { name: 'finances', exec: () => ws.batchRemove('finances', { family_id: familyId }, 100, true) },
      { name: 'reports', exec: () => ws.batchRemove('reports', { family_id: familyId }, 100, true) },
      // 审计 #7：undo_logs 含 before 快照（成员/财务全文），原不在级联清单 → 家庭删除后永不清理
      { name: 'undo_logs', exec: () => ws.batchRemove('undo_logs', { family_id: familyId }, 100, true) },
      { name: 'operation_logs', exec: () => ws.batchRemove('operation_logs', { family_id: familyId }, 100, true) },
      { name: 'agent_logs', exec: () => ws.batchRemove('agent_logs', { family_id: familyId }, 100, true) },
      // 清理 OCR 阶段未关联 familyId 的孤儿日志（匹配前调用，family_id 为空字符串）
      // 级联删除审计 #4：agent_logs 的 '' 孤儿与 operation_logs 对齐一并清理
      { name: 'orphan_logs', exec: () => ws.batchRemove('operation_logs', { family_id: '' }, 100, true) },
      { name: 'orphan_agent_logs', exec: () => ws.batchRemove('agent_logs', { family_id: '' }, 100, true) }
    ]
    let txResult = await ws.batchTx(cascadeSteps)
    // 2026-09-09 修复：部分级联失败（瞬时单文档异常/日志量大）→ 幂等自动重试一次，
    // 避免一次抖动让用户看到 207"删除失败"且家庭半删除（policies/facts 已清、family 残留）
    if (txResult.failed > 0) {
      console.warn('[dataWrite] deleteFamily 首轮部分级联失败，自动重试:', JSON.stringify((txResult.errors || []).map(function(e) { return (e && e.name) || e })))
      await new Promise(function(r) { setTimeout(r, 300) })
      txResult = await ws.batchTx(cascadeSteps)
    }
    const total = (txResult.results || []).reduce((a, b) => a + (b || 0), 0)
    // 部分失败时返回 partial 标记：保留 family 文档（可重试清理），避免孤儿数据
    if (txResult.failed > 0) {
      console.error('[dataWrite] deleteFamily 部分级联失败（自动重试后仍失败）:', JSON.stringify(txResult.errors))
      // 审计 #6：文案与事实对齐——batchTx 不回滚，关联数据可能已部分清空，笼统说"未删除"会掩盖半删除态
      return { code: 207, msg: '部分关联数据已清理，家庭档案保留，可重试删除', partial: true, cascadeCleaned: total, errors: txResult.errors }
    }
    // 全链路审计 PM5：关联数据全部清理成功后，最后删 family 文档
    // 2026-09-22 全面审计 P1：必须检查返回值——db-helpers.deleteFamily 内部 catch 后**返回**
    // {code:500} 而从不抛出，原实现忽略返回值 → 关联数据已全部删掉、family 文档还在，
    // 用户却看到"删除成功"，该家庭继续出现在客户列表里（0 成员，点进去空报告）。
    const delRes = await deleteFamily(db, familyId, openid)
    if (!delRes || delRes.code !== 200) {
      console.error('[dataWrite] deleteFamily 文档删除失败:', (delRes && delRes.msg) || 'unknown')
      return { code: 207, msg: '关联数据已清理，家庭档案删除失败，请重试', partial: true, cascadeCleaned: total }
    }
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

module.exports = { createFamily, updateFamilyHandler, deleteFamilyHandler }
