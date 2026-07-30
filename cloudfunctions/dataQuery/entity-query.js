/**
 * entity-query — 实体查询领域（保单 / 成员 / 事实）
 *
 * 导出：queryPolicies / queryMembers / queryFacts
 *
 * 设计：conversationAI 内部用，三个 handler 共用"validate familyId → safeQuery → 过滤 deleted → 返回 {code,msg,data}"模板。
 *      集中到同一领域文件提升 locality（架构审计第 10 轮：从 handlers.js 拆分）。
 */
const { safeQuery } = require('./_shared/db-helpers')
const { loadActivePolicies } = require('./_shared/policy-read')
const { wrapError } = require('./_shared/errorHandler')

// ---------- queryPolicies ----------
// conversationAI 内部用：查家庭保单
// 架构审计第 16 轮候选 #1：读取接缝集中 _openid 注入 + 过滤 deleted 两件套
async function queryPolicies(db, openid, event) {
  const { familyId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  try {
    const policies = await loadActivePolicies(db, familyId, openid, { ensureStatus: false })
    return { code: 200, data: { policies } }
  } catch (e) {
    return wrapError('获取保单', e)
  }
}

// ---------- queryMembers ----------
// conversationAI 内部用：查家庭成员（含 member_id，投影完整）
async function queryMembers(db, openid, event) {
  const { familyId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  try {
    const res = await safeQuery(db, 'members', { family_id: familyId }, openid, { limit: 50 })
    const members = (res.data || []).filter(m => m.status !== 'deleted')
    return { code: 200, data: { members } }
  } catch (e) {
    return wrapError('获取成员', e)
  }
}

// ---------- queryFacts ----------
// conversationAI 内部用：查家庭事实三元组（投影含 subject_id/subject_type，防关联丢失）
async function queryFacts(db, openid, event) {
  const { familyId, predicate, subjectId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  try {
    const where = { family_id: familyId, _openid: openid, status: 'active' }
    if (predicate) where.predicate = predicate
    if (subjectId) where.subject_id = subjectId
    const res = await db.collection('facts').where(where).limit(300).get().catch(() => ({ data: [] }))
    const facts = (res.data || []).map(f => ({
      _id: f._id,
      subject_id: f.subject_id || '',
      subject_type: f.subject_type || '',
      subject_name: f.subject_name || '',
      predicate: f.predicate || '',
      object_value: f.object_value || '',
      object_id: f.object_id || '',
      object_type: f.object_type || '',
      confidence: f.confidence != null ? f.confidence : 1,
      source: f.source || '',
      created_at: f.created_at
    }))
    return { code: 200, data: { facts } }
  } catch (e) {
    return wrapError('获取事实', e)
  }
}

module.exports = { queryPolicies, queryMembers, queryFacts }
