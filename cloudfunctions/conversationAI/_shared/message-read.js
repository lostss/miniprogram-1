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
 *   2. 错误吞并返回 null（sug 拦截是非关键路径，不应阻断主流程）
 *
 * 导出：getLatestAssistantMsg
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

module.exports = { getLatestAssistantMsg }
