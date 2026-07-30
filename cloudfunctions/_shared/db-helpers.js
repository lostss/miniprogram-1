/**
 * db-helpers — 读取侧 _openid 注入 + families/agents 专用读写
 *
 * v2：写入原语（safeWrite/safeUpdate/safeUpdateMany）收编进 writeSeam，
 *     本文件仅保留 safeQuery（读路径无 writeSeam 等价）和 families/agents 专用封装。
 *     updateFamily/deleteFamily 改为经 writeSeam 的 silentUpdateWhere/silentRemoveWhere，
 *     保证 _openid 注入 + updated_at 不变量统一由 writeSeam 维护。
 *     不含 agent_logs（已由 conversationAI postProcess 统一记录）
 *
 * 架构审计第 17 轮候选 #1：新增 agents 读取接缝（loadAgentByOpenid/loadAgentByPhone），
 *   消除 login/index.js 裸 db.collection('agents').where().get()，
 *   agents 表无 family_id，_openid 即所有权字段，直接作为 where 条件。
 */
const { writeSeam } = require('./writeSeam')

async function safeQuery(db, collection, where, openid, opts = {}) {
  let q = db.collection(collection).where({ ...where, _openid: openid })
  if (opts.orderBy) q = q.orderBy(opts.orderBy[0], opts.orderBy[1])
  if (opts.limit) q = q.limit(opts.limit)
  return q.get()
}

// 候选 4：families 单一读取缝，集中注入 _openid，替代 handlers 散落的
// db.collection('families').where({ _id, _openid }).limit(1).get()
async function getFamily(db, familyId, openid) {
  const res = await safeQuery(db, 'families', { _id: familyId }, openid, { limit: 1 }).catch(() => ({ data: [] }))
  return (res.data && res.data[0]) || null
}

/** families 文档更新（带 _openid 校验 + updated_at，经 writeSeam silent 变体） */
async function updateFamily(db, familyId, openid, data) {
  try {
    // 无 familyId 时不触发钩子（与原语义一致）；带 updated_at 由 writeSeam 自动附加
    const ws = writeSeam(db, openid, null)
    const updated = await ws.silentUpdateWhere('families', { _id: familyId }, data)
    return { code: 200, data: { updated } }
  } catch (e) { console.error('[db-helpers] updateFamily 失败:', e.message); return { code: 500, msg: '更新失败' } }
}

/** families 文档删除（带 _openid 校验，经 writeSeam silent 变体） */
async function deleteFamily(db, familyId, openid) {
  try {
    const ws = writeSeam(db, openid, null)
    await ws.silentRemoveWhere('families', { _id: familyId })
    return { code: 200 }
  } catch (e) { console.error('[db-helpers] deleteFamily 失败:', e.message); return { code: 500, msg: '删除失败' } }
}

// ---------- agents 读取接缝 ----------
// agents 表无 family_id，_openid 即所有权字段；按 openid/phone 查询时直接注入 _openid 条件
/**
 * 按 openid 查 agent（devLogin 用）
 * @returns {Promise<object|null>}
 */
async function loadAgentByOpenid(db, openid) {
  if (!openid) return null
  const res = await db.collection('agents')
    .where({ _openid: openid, openid })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }))
  return (res.data && res.data[0]) || null
}

/**
 * 按手机号查 agent（phoneLogin 用）
 * 注：phone 是登录凭证，不是所有权字段；_openid 仍注入作为防越权兜底
 * @returns {Promise<object|null>}
 */
async function loadAgentByPhone(db, phone, openid) {
  if (!phone) return null
  const where = { phone }
  if (openid) where._openid = openid
  const res = await db.collection('agents')
    .where(where)
    .limit(1)
    .get()
    .catch(() => ({ data: [] }))
  return (res.data && res.data[0]) || null
}

module.exports = { safeQuery, getFamily, updateFamily, deleteFamily, loadAgentByOpenid, loadAgentByPhone }
