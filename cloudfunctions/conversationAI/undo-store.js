/**
 * undo-store — 默认执行+撤销（② 2026-08-30 极简重构）：undo_logs 集合读写
 *
 * 记录每次"默认执行"的写操作（写入前 before 快照 + 撤销定位用 after），
 * 5 分钟窗口内可经 {UNDO:op_id} 拦截恢复。超时/已撤销自动失效。
 *
 * 不变量：
 *   - op_id 为唯一业务键（撤销指令引用），openid 归属校验在查询层
 *   - 落库/查询失败静默（撤销是增强能力，不影响默认执行主流程）
 */
const UNDO_TTL_MS = 5 * 60 * 1000
// 越权审计修复：undo_logs 落库经 writeSeam（自动注入 _openid，原裸 add 只写普通 openid 字段，DB 权限层无法按 _openid 隔离）
const { writeSeam } = require('./_shared/writeSeam')

function _opId(toolName) {
  return 'ud_' + (toolName || 'op') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
}

/**
 * 写入 undo_logs 记录（status='pending', expires_at=now+5min）
 * @returns {Promise<string|null>} op_id；失败返回 null（不阻断主流程）
 */
async function createUndo(db, { familyId, openid, toolName, args, before, after }) {
  if (!db || !db.collection || !familyId || !openid || !toolName) return null
  const now = new Date()
  const opId = _opId(toolName)
  try {
    // writeSeam(db, openid) 不带 familyId → 无 markMutated 钩子（undo_logs 非家庭数据）
    await writeSeam(db, openid).silentAdd('undo_logs', {
      op_id: opId,
      family_id: familyId,
      openid,
      tool: toolName,
      payload: args || {},
      before: before || null,
      after: after || null,
      status: 'pending',
      expires_at: new Date(now.getTime() + UNDO_TTL_MS),
      created_at: now,
      updated_at: now
    })
    return opId
  } catch (e) {
    console.error('[undo-store] 落库失败:', (e && e.message) || e)
    return null
  }
}

/** 查 pending 状态且归属当前用户的撤销记录 */
async function findPending(db, familyId, openid, opId) {
  if (!db || !db.collection || !familyId || !openid || !opId) return null
  try {
    const r = await db.collection('undo_logs')
      .where({ op_id: opId, family_id: familyId, openid, status: 'pending' })
      .limit(1).get()
    return (r.data && r.data[0]) || null
  } catch (e) {
    console.error('[undo-store] 查询失败:', (e && e.message) || e)
    return null
  }
}

/** 更新撤销记录状态（undone/settled），失败静默 */
async function updateStatus(db, docId, status) {
  if (!db || !db.collection || !docId || !status) return
  try {
    await db.collection('undo_logs').doc(docId).update({ data: { status, updated_at: new Date() } })
  } catch (e) { /* 静默 */ }
}

module.exports = { createUndo, findPending, updateStatus, UNDO_TTL_MS }
