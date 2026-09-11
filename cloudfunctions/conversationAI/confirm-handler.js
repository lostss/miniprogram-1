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
// 2026-08-29 修复：exec 需透传 openid 给 dispatch（_dispatch(tool, params, openid) 第三参缺失
// 会导致 writeSeam safeUpdateDoc 缺 openid → 点确认 500"处理失败"）
const STRATEGIES = {
  fact_confirm: {
    logAction: 'fact_confirm',
    exec: ({ pc, familyId, dispatch, openid }) => dispatch('updateFactConfidence', {
      familyId, factId: pc.factId, confidence: 1, source: 'agent_confirmed'
    }, openid),
    reply: (r) => (r && r.code === 200) ? '已确认事实，置信度升级' : '确认失败：' + ((r && r.msg) || '未知错误'),
    logStatus: () => 'success'
  },
  member_confirm: {
    logAction: 'member_confirm',
    exec: ({ pc, familyId, dispatch, openid }) => dispatch('upsertMember', {
      familyId, memberName: pc.memberName, memberId: pc.memberId, data: pc.proposed, confirmed: true
    }, openid),
    reply: (r) => (r && r.code === 200) ? '已确认并更新成员信息' : '更新失败：' + ((r && r.msg) || '未知错误'),
    logStatus: () => 'success'
  },
  delete_confirm: {
    logAction: 'delete_confirm',
    exec: ({ pc, familyId, dispatch, openid }) => dispatch(pc.toolName, {
      familyId, ...pc.payload, confirmed: true
    }, openid),
    reply: (r, pc) => (r && r.code === 200) ? ('已删除' + (pc.target || '')) : '删除失败：' + ((r && r.msg) || '未知错误'),
    logStatus: (r) => (r && r.code === 200) ? 'success' : 'failed'
  },
  // 单通道 v10：写入类工具（成员/财务/保单/新建家庭）确认后执行
  write_confirm: {
    logAction: 'write_confirm',
    exec: ({ pc, familyId, dispatch, openid }) => dispatch(pc.toolName, {
      familyId, ...pc.payload, confirmed: true
    }, openid),
    reply: (r, pc) => (r && r.code === 200) ? ('已确认写入' + (pc.target ? ' ' + pc.target : '') + (pc.summary ? '：' + pc.summary : '')) : '写入失败：' + ((r && r.msg) || '未知错误'),
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
  lastMsg, ctxCache, stateCache, dispatch, writeMessage, db, promptVersion
}) {
  const t0 = Date.now()
  if (!lastMsg || !lastMsg.pending_confirms || lastMsg.pending_confirms.length === 0) {
    return { code: 404, msg: '未找到待确认项' }
  }
  const pc = lastMsg.pending_confirms.find(p => p.pendingId === pendingId)
  if (!pc) return { code: 400, msg: '该确认操作已失效，请重新发起' }

  const strategy = STRATEGIES[pc.type]
  if (!strategy) return { code: 400, msg: '不支持的确认类型：' + pc.type }

  // 历史显示 bug 修复：落库前友好化指令文本（前端展示"确认"/"取消"，重新进入会话也能看到中文）
  // agent_logs 已用 strategy.logAction 字段记录操作类型，messages 集合的 user 消息只需人可读
  const friendlyText = '确认' + (pc.target ? '：' + pc.target : '')
  const actualUserText = userText || friendlyText

  // 三分支统一骨架：失效状态块 → 执行 → 写 user 消息 → 构造 reply → 写 assistant 消息 → log
  // 2026-08-30 长期记忆：确认执行是写操作，只失效状态块（基础摘要保持稳定保前缀缓存命中）
  // P1-C1 修复：失效打在 _stateCache（index 传入 stateCache）；仅传 ctxCache 的旧调用回退兼容
  // 行首必须有分号：上一 const 行无分号，若以 ( 开头会被 ASI 拼接成 friendlyText(...) 调用
  ;(stateCache || ctxCache).invalidate('state:' + familyId + ':' + openid)
  const result = await strategy.exec({ pc, familyId, dispatch, openid })
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

  // B1（2026-08-30 审计）：toolResults 补 tool/success——前端 _postChat 的 hasWrite 检查
  // tr.tool/tr.success 据此触发报告刷新；裸 dispatch 结果 {code,data} 缺失两字段致确认写入后报告 stale
  const enriched = { tool: pc.toolName, success: !!(result && result.code === 200), result }
  return {
    code: 200,
    data: { cleanText: replyText, suggestions: [], toolResults: [enriched], auditBlocked: false, userWritten: true, assistantWritten: true }
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
  if (!pc) return { code: 400, msg: '该保留操作已失效，请重新发起' }
  const isDelete = pc.type === 'delete_confirm'
  const isWrite = pc.type === 'write_confirm'
  // 历史显示 bug 修复：KEEP 落库友好化（与 CONFIRM 对称，重新进入会话看到中文"取消"）
  const friendlyText = '取消' + (pc.target ? '：' + pc.target : '')
  const actualUserText = userText || friendlyText
  await writeMessage(familyId, openid, 'user', actualUserText, { sessionId: sid })
  // P3-C 修复：KEEP 文案按卡类型区分，写入类取消不再误称"未修改成员信息"
  const replyText = isDelete ? '已取消删除' : (isWrite ? '已取消写入' : '已保留原值，未修改成员信息')
  await writeMessage(familyId, openid, 'assistant', replyText, { sessionId: sid })

  await logAI(db, {
    openid, familyId, sessionId: sid,
    action: isDelete ? 'delete_keep' : (isWrite ? 'write_keep' : 'member_keep'),
    status: 'success',
    metrics: { total: 0 },
    promptVersion
  })

  return { code: 200, data: { cleanText: replyText, suggestions: [], toolResults: [], auditBlocked: false, userWritten: true, assistantWritten: true } }
}

module.exports = { handleConfirm, handleKeep, STRATEGIES }
