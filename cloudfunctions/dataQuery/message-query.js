/**
 * message-query — 消息查询领域
 *
 * 导出：queryMessages
 *
 * 设计：对话面板用，按 family_id 查消息，支持 before 游标分页。
 *   conversationAI 的 sug 拦截所需"最近 assistant 消息"读取接缝在 _shared/message-read.js，
 *   不放此处：跨云函数 require 不可行，_shared 由 sync-shared 同步到各函数本地。
 */
const { wrapError } = require('./_shared/errorHandler')

// ---------- queryMessages ----------
async function queryMessages(db, openid, event) {
  const { familyId, before, mode } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  const limit = Math.min(Number(event.limit) || 20, 50)
  try {
    const where = { family_id: familyId, _openid: openid }
    if (before) {
      const _ = db.command
      where.created_at = _.lt(new Date(before))
    }
    const res = await db.collection('messages').where(where).orderBy('created_at', 'desc').limit(limit).get().catch(() => ({ data: [] }))
    // latest 模式返回最新 N 条（正序展示由前端处理）；more 模式返回游标之前 N 条
    const messages = (res.data || []).map(m => ({
      _id: m._id,
      role: m.role || 'assistant',
      content: m.content || '',
      created_at: m.created_at,
      suggestions: m.suggestions || [],
      cards: m.cards || [],
      input_type: m.input_type || '',
      session_id: m.session_id || ''
    }))
    return { code: 200, data: { messages } }
  } catch (e) {
    return wrapError('获取消息', e)
  }
}

module.exports = { queryMessages }
