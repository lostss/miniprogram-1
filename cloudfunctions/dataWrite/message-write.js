/**
 * message-write — 消息与日志领域
 *
 * 导出：writeMessage / writeOpLog
 */
const { writeSeam } = require('./_shared/writeSeam')
const { logOperation } = require('./_shared/logSeam')
const { wrapError } = require('./_shared/errorHandler')

// ---------- writeMessage ----------
async function writeMessage(db, openid, event) {
  const { familyId, role, content, suggestions, pending_confirms, undoOps, inputType, isOcrMsg, sessionId, msgType } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!role || !content) return { code: 400, msg: '缺少参数 role 或 content' }
  const msgRoles = ['user', 'assistant', 'system']
  if (!msgRoles.includes(role)) return { code: 400, msg: 'role 不合法：' + role }
  if (content.length > 4000) return { code: 400, msg: '内容过长' }
  try {
    const doc = { family_id: familyId, role, content: content.substring(0, 4000), created_at: new Date() }
    if (inputType) doc.input_type = inputType; if (isOcrMsg) doc.ocr_msg = true; if (suggestions && suggestions.length > 0) doc.suggestions = suggestions; if (pending_confirms && pending_confirms.length > 0) doc.pending_confirms = pending_confirms; if (undoOps && undoOps.length > 0) doc.undoOps = undoOps; if (sessionId) doc.session_id = sessionId; if (msgType) doc.type = msgType
    // messages 为审计类写入，不触发 markMutated/advanceStage
    const ws = writeSeam(db, openid)
    await ws.silentAdd('messages', doc)
    return { code: 200, msg: '消息已写入' }
  } catch (e) { return wrapError('写入消息', e) }
}

// ---------- writeOpLog ----------
// 架构审计第 6 轮：委托 logSeam.logOperation，统一 operation_logs schema（含 target 字段）
async function writeOpLog(db, openid, event) {
  const { familyId, action: logAction, result, meta, target } = event
  if (!logAction) return { code: 400, msg: '缺少参数 action' }
  try {
    await logOperation(db, {
      openid,
      familyId: familyId || '',
      action: logAction,
      target: target || {},
      result: {
        status: (result && result.status) || 'ok',
        summary: (result && result.summary) || '',
        error: (result && result.error) || '',
        errorCode: result && (result.error_code || result.errorCode)
      },
      meta: meta || {}
    })
    return { code: 200, msg: '日志已写入' }
  } catch (e) { return wrapError('写入日志', e) }
}

module.exports = { writeMessage, writeOpLog }
