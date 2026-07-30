/**
 * member-read — 成员读取接缝
 *
 * 架构审计第 17 轮候选 #1：读取接缝对称化
 *   与 policy-read.js 对称，集中 members 集合的读取不变量：
 *   1. _openid 注入（防越权）
 *   2. 过滤 status='deleted'（默认开启，可 includeDeleted 关闭）
 *   3. 错误吞并返回空数组/null（非关键路径不阻断主流程）
 *
 * 导出：loadActiveMembers / findMemberByName / findMemberById
 */

/**
 * 取家庭内所有活跃成员（status !== 'deleted'）
 * @param {object} db - cloud.database()
 * @param {string} familyId
 * @param {string} openid
 * @param {object} [opts]
 * @param {boolean} [opts.includeDeleted=false] 是否包含已删除成员
 * @param {number} [opts.limit=50]
 * @returns {Promise<Array>} members 列表
 */
async function loadActiveMembers(db, familyId, openid, opts = {}) {
  const { includeDeleted = false, limit = 50 } = opts
  const where = { family_id: familyId, _openid: openid }
  if (!includeDeleted) where.status = db.command.neq('deleted')
  const res = await db.collection('members')
    .where(where)
    .limit(limit)
    .get()
    .catch(() => ({ data: [] }))
  return res.data || []
}

/**
 * 按姓名查成员（policy-write/fact-write/member-write 反查 member_id 用）
 * @returns {Promise<object|null>}
 */
async function findMemberByName(db, familyId, openid, name) {
  if (!name) return null
  const res = await db.collection('members')
    .where({ family_id: familyId, _openid: openid, name })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }))
  return (res.data && res.data[0]) || null
}

/**
 * 按 member_id 查成员（member-write writeNote/deleteMember 定位用）
 * @returns {Promise<object|null>}
 */
async function findMemberById(db, familyId, openid, memberId) {
  if (!memberId) return null
  const res = await db.collection('members')
    .where({ family_id: familyId, _openid: openid, member_id: memberId })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }))
  return (res.data && res.data[0]) || null
}

module.exports = { loadActiveMembers, findMemberByName, findMemberById }
