/**
 * fact-read — 事实读取接缝
 *
 * 架构审计第 17 轮候选 #1：读取接缝对称化
 *   与 policy-read.js / member-read.js 对称，集中 facts 集合的读取不变量：
 *   1. _openid 注入（防越权）
 *   2. 默认仅取 status='active'（过滤 superseded/deleted）
 *   3. 错误吞并返回空数组/null
 *
 *   修复 fact-write.js L121 updateFactConfidence 中 doc(factId).get() 无 _openid 校验的越权 bug
 *   （任何知道 factId 的人都能读取该 fact → 改为 where + _openid 注入）
 *
 * 导出：loadActiveFacts / findFactByIdSecure / findFactByValue
 */

/**
 * 取家庭内活跃事实列表
 * @param {object} db
 * @param {string} familyId
 * @param {string} openid
 * @param {object} [opts]
 * @param {string} [opts.predicate] 按谓词过滤
 * @param {string} [opts.subjectId] 按主体过滤
 * @param {boolean} [opts.includeSuperseded=false] 是否包含已 superseded 的事实
 * @param {number} [opts.limit=300]
 * @returns {Promise<Array>}
 */
async function loadActiveFacts(db, familyId, openid, opts = {}) {
  const { predicate, subjectId, includeSuperseded = false, limit = 300 } = opts
  const where = { family_id: familyId, _openid: openid }
  if (!includeSuperseded) where.status = 'active'
  if (predicate) where.predicate = predicate
  if (subjectId) where.subject_id = subjectId
  const res = await db.collection('facts')
    .where(where)
    .limit(limit)
    .get()
    .catch(() => ({ data: [] }))
  return res.data || []
}

/**
 * 按 _id 安全查 fact（带 _openid + family_id 校验）
 * 替代 fact-write.js 原 db.collection('facts').doc(factId).get() 越权查询
 * @returns {Promise<object|null>}
 */
async function findFactByIdSecure(db, factId, familyId, openid) {
  if (!factId) return null
  const res = await db.collection('facts')
    .where({ _id: factId, family_id: familyId, _openid: openid })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }))
  return (res.data && res.data[0]) || null
}

/**
 * 按主体+谓词+值精确查 fact（dedup 检测、备注回查用）
 * @returns {Promise<object|null>}
 */
async function findFactByValue(db, familyId, openid, { subjectId, predicate, objectValue, status = 'active' }) {
  if (!familyId || !openid || !predicate || objectValue == null) return null
  const where = { family_id: familyId, _openid: openid, predicate, object_value: objectValue }
  if (status) where.status = status
  if (subjectId) where.subject_id = subjectId
  const res = await db.collection('facts')
    .where(where)
    .limit(1)
    .get()
    .catch(() => ({ data: [] }))
  return (res.data && res.data[0]) || null
}

module.exports = { loadActiveFacts, findFactByIdSecure, findFactByValue }
