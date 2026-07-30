/**
 * confirm-handler.js — 确认/保留卡片处理（策略表驱动）
 *
 * 解决问题：原 _handleConfirm 三个分支（fact_confirm / member_confirm / delete_confirm）
 * 骨架完全一致——_ctxCache.delete → _dispatch → _writeMessage(user) → 构造 reply
 * → _writeMessage(assistant) → agent_logs.add——改一处须改三处。
 *
 * 设计：策略表，每个 type 定义 4 个 hook
 *   - exec({pc, familyId, dispatch}) → 调用 dispatch，返回 result
 *   - reply(result, pc) → 构造回复文案
 *   - logAction → agent_logs 的 action 字段
 *   - logStatus(result) → agent_logs 的 status 字段
 *
 * 接口契约：
 *   handleConfirm({familyId, openid, pendingId, sid, userText, lastMsg, ctxCache, dispatch, writeMessage, db, promptVersion})
 *     → { code, msg, data? }
 */
const { logAI } = require('./_shared/logSeam')

// 策略表：type → { exec, reply, logAction, logStatus }
const STRATEGIES = {
  fact_confirm: {
    logAction: 'fact_confirm',
    exec: ({ pc, familyId, dispatch }) => dispatch('updateFactConfidence', {
      familyId, factId: pc.factId, confidence: 1, source: 'agent_confirmed'
    }),
    reply: (r) => (r && r.code === 200) ? '已确认事实，置信度升级' : '确认失败：' + ((r && r.msg) || '未知错误'),
    logStatus: () => 'success'
  },
  member_confirm: {
    logAction: 'member_confirm',
    exec: ({ pc, familyId, dispatch }) => dispatch('upsertMember', {
      familyId, memberName: pc.memberName, memberId: pc.memberId, data: pc.proposed, confirmed: true
    }),
    reply: (r) => (r && r.code === 200) ? '已确认并更新成员信息' : '更新失败：' + ((r && r.msg) || '未知错误'),
    logStatus: () => 'success'
  },
  delete_confirm: {
    logAction: 'delete_confirm',
    exec: ({ pc, familyId, dispatch }) => dispatch(pc.toolName, {
      familyId, ...pc.payload, confirmed: true
    }),
    reply: (r, pc) => (r && r.code === 200) ? ('已删除' + (pc.target || '')) : '删除失败：' + ((r && r.msg) || '未知错误'),
    logStatus: (r) => (r && r.code === 200) ? 'success' : 'failed'
  }
}

/**
 * 处理 CONFIRM 卡片
 * @param {object} args
 *   - familyId, openid, pendingId, sid, userText
 *   - lastMsg: 最近 assistant 消息（含 pending_confirms）
 *   - ctxCache: CtxCache 实例（ctx-cache.js），用于失效上下文缓存
 *   - dispatch(action, payload, openid) → result
 *   - writeMessage(familyId, openid, role, content, opts) → Promise<bool>
 *   - db, promptVersion
 */
async function handleConfirm({
  familyId, openid, pendingId, sid, userText,
  lastMsg, ctxCache, dispatch, writeMessage, db, promptVersion
}) {
  const t0 = Date.now()
  if (!lastMsg || !lastMsg.pending_confirms || lastMsg.pending_confirms.length === 0) {
    return { code: 404, msg: '未找到待确认项' }
  }
  const pc = lastMsg.pending_confirms.find(p => p.pendingId === pendingId)
  if (!pc) return { code: 400, msg: '确认数据无效' }

  const strategy = STRATEGIES[pc.type]
  if (!strategy) return { code: 400, msg: '不支持的确认类型：' + pc.type }

  const actualUserText = userText || ('{CONFIRM:' + pendingId + '}')

  // 三分支统一骨架：清缓存 → 执行 → 写 user 消息 → 构造 reply → 写 assistant 消息 → log
  ctxCache.invalidate(familyId)
  const result = await strategy.exec({ pc, familyId, dispatch })
  await writeMessage(familyId, openid, 'user', actualUserText, { sessionId: sid })
  const replyText = strategy.reply(result, pc)
  await writeMessage(familyId, openid, 'assistant', replyText, { sessionId: sid })

  await logAI(db, {
    openid, familyId, sessionId: sid,
    action: strategy.logAction,
    status: strategy.logStatus(result),
    tools: [result],
    metrics: { total: Date.now() - t0 },
    promptVersion
  })

  return {
    code: 200,
    data: { cleanText: replyText, suggestions: [], toolResults: [result], auditBlocked: false, userWritten: true, assistantWritten: true }
  }
}

/**
 * 处理 KEEP 卡片（保留原值/取消删除）
 * 简化路径：仅写消息 + log，不调 dispatch
 */
async function handleKeep({
  familyId, openid, pendingId, sid, userText,
  lastMsg, writeMessage, db, promptVersion
}) {
  if (!familyId || !openid) return { code: 400, msg: '缺少参数' }
  const pc = lastMsg && lastMsg.pending_confirms && lastMsg.pending_confirms.find(p => p.pendingId === pendingId)
  const isDelete = pc && pc.type === 'delete_confirm'
  const actualUserText = userText || ('{KEEP:' + pendingId + '}')
  await writeMessage(familyId, openid, 'user', actualUserText, { sessionId: sid })
  const replyText = isDelete ? '已取消删除' : '已保留原值，未修改成员信息'
  await writeMessage(familyId, openid, 'assistant', replyText, { sessionId: sid })

  await logAI(db, {
    openid, familyId, sessionId: sid,
    action: isDelete ? 'delete_keep' : 'member_keep',
    status: 'success',
    metrics: { total: 0 },
    promptVersion
  })

  return { code: 200, data: { cleanText: replyText, suggestions: [], toolResults: [], auditBlocked: false, userWritten: true, assistantWritten: true } }
}

module.exports = { handleConfirm, handleKeep, STRATEGIES }
