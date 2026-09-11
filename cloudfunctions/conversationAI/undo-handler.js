/**
 * undo-handler — 撤销处理（② 2026-08-30 默认执行+撤销）
 *
 * 前端撤销按钮 → {UNDO:op_id} 拦截指令 → 校验 undo_logs（pending + 归属 + 未过期）
 * → 按工具恢复（updateFinances/upsertMember 覆盖写回或删除；addFact supersede）→ 落消息 + 状态
 */
const { findPending, updateStatus } = require('./undo-store')
const { restoreFinance, restoreMember } = require('./_shared/memberRepo')

/** 撤销新建事实：对目标 fact 置 superseded（版本机制天然支持）
 * B3（2026-08-30 审计）：改走 writeSeam——统一 _openid 校验 + updated_at + markMutated 钩子，
 * 撤销事实后正确置 insight_stale（此前裸 update 绕过，报告不感知该变更）
 */
async function _restoreFact(db, familyId, after, openid) {
  const fid = after && (after.factId || after.fact_id)
  if (!fid) return { code: 400, msg: '缺少事实ID' }
  try {
    const { writeSeam } = require('./_shared/writeSeam')
    const ws = writeSeam(db, openid, familyId)
    await ws.silentUpdateDoc('facts', fid, { status: 'superseded' })
    await ws.triggerHooks()
    return { code: 200, data: { action: 'superseded' } }
  } catch (e) {
    console.error('[undo-handler] 撤销事实失败:', (e && e.message) || e)
    return { code: 500, msg: '撤销记录失败' }
  }
}

// 操作内容摘要（基于 undo 记录的 AI 参数，生成人可读的自然描述）
function _summarizeArgs(toolName, args) {
  args = args || {}
  if (toolName === 'updateFinances') {
    const parts = []
    if (args.annual_income != null) parts.push('年收入 ' + Number(args.annual_income).toLocaleString() + ' 元')
    if (args.total_debt != null) parts.push('总负债 ' + Number(args.total_debt).toLocaleString() + ' 元')
    if (args.fixed_annual_expense != null) parts.push('年固定支出 ' + Number(args.fixed_annual_expense).toLocaleString() + ' 元')
    return parts.join('、')
  }
  if (toolName === 'upsertMember') {
    return String(args.memberName || (args.data && args.data.name) || '成员')
  }
  if (toolName === 'addFact') {
    const p = args.predicate || ''
    const v = args.objectValue || ''
    return String(p ? (p + (v ? '：' + v : '')) : '')
  }
  return ''
}

// 自然化的撤销回复（按工具 + 是否新建 + 操作内容生成完整句子）
function _naturalReply(rec) {
  const detail = _summarizeArgs(rec.tool, rec.payload)
  if (rec.tool === 'updateFinances') {
    return rec.before
      ? '已撤销刚才的家庭财务调整' + (detail ? '（' + detail + '）' : '')
      : '已撤销新建的家庭财务记录'
  }
  if (rec.tool === 'upsertMember') {
    return rec.before
      ? '已撤销对' + (detail || '成员') + '的信息更新'
      : '已撤销新增成员' + (detail || '')
  }
  if (rec.tool === 'addFact') {
    return '已撤销刚才的记录' + (detail ? '（' + detail + '）' : '')
  }
  return '已撤销刚才的操作'
}

/**
 * 处理 {UNDO:op_id} 拦截指令
 * @returns {Promise<{code, msg?, data?}>}
 */
async function handleUndo({ familyId, openid, opId, sid, db, writeMessage, ctxCache, stateCache }) {
  if (!familyId || !openid || !opId) return { code: 400, msg: '缺少参数' }

  const rec = await findPending(db, familyId, openid, opId)
  if (!rec) return { code: 400, msg: '该操作已失效或已处理，无法撤销' }
  if (new Date(rec.expires_at).getTime() < Date.now()) {
    await updateStatus(db, rec._id, 'settled')
    return { code: 400, msg: '撤销窗口已过，该操作已生效' }
  }

  let result
  if (rec.tool === 'updateFinances') result = await restoreFinance(db, familyId, openid, rec.before)
  else if (rec.tool === 'upsertMember') result = await restoreMember(db, familyId, openid, rec.before, rec.after)
  else if (rec.tool === 'addFact') result = await _restoreFact(db, familyId, rec.after, openid)
  else return { code: 400, msg: '不支持的撤销类型：' + rec.tool }

  if (!result || result.code !== 200) return { code: 500, msg: (result && result.msg) || '撤销失败' }

  // 历史显示 bug 修复：撤销按钮落库友好化（重新进入会话看到中文"撤销"，而非 {UNDO:xxx}）
  const actualUserText = '撤销' + (rec.payload && rec.payload.memberName ? '：' + rec.payload.memberName : '')
  const replyText = _naturalReply(rec)
  await writeMessage(familyId, openid, 'user', actualUserText, { sessionId: sid })
  await writeMessage(familyId, openid, 'assistant', replyText, { sessionId: sid })
  // P1-C1 修复：撤销是写操作，状态块失效须打在 _stateCache（index 传入 stateCache）；仅传 ctxCache 的旧调用回退兼容
  const _stateCacheInst = stateCache || ctxCache
  if (_stateCacheInst && typeof _stateCacheInst.invalidate === 'function') _stateCacheInst.invalidate('state:' + familyId + ':' + openid)
  await updateStatus(db, rec._id, 'undone')

  // B1（2026-08-30 审计）：撤销是数据变更，toolResults 补 tool/success 触发前端报告刷新
  const enriched = { tool: rec.tool, success: true, result: result || { code: 200 } }
  return {
    code: 200,
    data: { cleanText: replyText, suggestions: [], pending_confirms: [], toolResults: [enriched], auditBlocked: false, userWritten: true, assistantWritten: true }
  }
}

module.exports = { handleUndo }
