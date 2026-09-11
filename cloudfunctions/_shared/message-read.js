/**
 * message-read — 消息读取接缝
 *
 * 架构审计第 17 轮候选 #2：conversationAI 的 sug 拦截所需"最近 assistant 消息"
 *   原本散落在 conversationAI/index.js 中的裸 db.collection('messages').where().get()，
 *   统一迁移至此处。放 _shared 而非 dataQuery/message-query.js：
 *   跨云函数 require 不可行（部署时 conversationAI 代码包不含 dataQuery 目录），
 *   _shared 由 sync-shared.js 自动同步到各函数本地。
 *
 * 不变量：
 *   1. _openid 注入（防越权，所有 where 必须带 _openid）
 *   2. 错误吞并返回空值（非关键路径，不应阻断主流程）
 *
 * 导出：getLatestAssistantMsg、getFamilyHistory（2026-08-30 长期记忆增量历史）
 */

/**
 * 取 family 内最近一条 assistant 消息
 * @param {object} db - cloud.database()
 * @param {string} familyId
 * @param {string} openid
 * @returns {Promise<object|null>} 最近 assistant 消息，含 suggestions/pending_confirms 等字段
 */
async function getLatestAssistantMsg(db, familyId, openid) {
  const r = await db.collection('messages')
    .where({ family_id: familyId, _openid: openid, role: 'assistant' })
    .orderBy('created_at', 'desc').limit(1).get()
    .catch(() => ({ data: [] }))
  return (r.data && r.data[0]) || null
}

// 内部拦截指令（CONFIRM/KEEP/UNDO/sug 点击）会以 user 角色落库，AI 读全量历史时不可见原始指令
const CMD_RE = /^\{[A-Z]+:[\w-]+\}$/
function _friendlyContent(content) {
  const c = String(content || '')
  if (CMD_RE.test(c.trim())) return '（用户操作了界面按钮）'
  return c
}

/**
 * 取 family 全量对话历史（append-only 增量记忆，2026-08-30）
 *
 * 契约：
 *   - 返回 [{ role: 'user'|'assistant', content }]，按 created_at 升序（时间正序）
 *   - after：压缩游标（families.ctx_compacted_at）——压缩后只读该时间点之后的消息，
 *     保证注入前缀在压缩后重新稳定（基础摘要含压缩前全部状态）
 *   - 内部指令消息（{CONFIRM:..}/{UNDO:..}）替换为可读占位，防 AI 误读
 *   - desc + limit 再 reverse：防御性上限（READ_LIMIT）截断时保留最新消息
 *
 * @param {object} db
 * @param {string} familyId
 * @param {string} openid
 * @param {object} [opts] - { after: Date|string|null, limit: number }
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
async function getFamilyHistory(db, familyId, openid, opts = {}) {
  try {
    const { after, limit } = opts
    let where = { family_id: familyId, _openid: openid }
    if (after) {
      const _ = db.command
      where.created_at = _.gt(new Date(after))
    }
    let q = db.collection('messages').where(where).orderBy('created_at', 'desc')
    if (limit) q = q.limit(limit)
    const r = await q.get()
    return (r.data || []).slice().reverse().map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: _friendlyContent(m.content).substring(0, 500)
    }))
  } catch (e) {
    console.warn('[message-read] getFamilyHistory 失败:', (e && e.message) || e)
    return []
  }
}

module.exports = { getLatestAssistantMsg, getFamilyHistory }
