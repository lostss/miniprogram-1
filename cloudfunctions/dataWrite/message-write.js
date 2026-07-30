/**
 * message-write — 消息、日志与画像提交领域
 *
 * 导出：writeMessage / writeOpLog / submitProfiling
 *
 * 依赖关系（单向）：
 *   - submitProfiling 编排：fact-write.addMemberFact（标准字段）+ free-text-extractor（自由文本）
 *   - free-text-extractor lazy require ai-gateway / ai-client（ponytail：避免冷启动崩溃）
 */
const { writeSeam } = require('./_shared/writeSeam')
const { logOperation } = require('./_shared/logSeam')
const { ALLOWED_DIMENSIONS } = require('./member-dimensions')
const { updateMemberFields } = require('./_shared/memberRepo')
const { DIM_TO_PREDICATE, addMemberFact } = require('./fact-write')
const { extractFactsFromFreeText } = require('./free-text-extractor')
const { wrapError } = require('./_shared/errorHandler')

// ---------- writeMessage ----------
async function writeMessage(db, openid, event) {
  const { familyId, role, content, cards, suggestions, pending_confirms, inputType, isOcrMsg, sessionId, msgType } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!role || !content) return { code: 400, msg: '缺少参数 role 或 content' }
  const msgRoles = ['user', 'assistant', 'system']
  if (!msgRoles.includes(role)) return { code: 400, msg: 'role 不合法：' + role }
  if (content.length > 4000) return { code: 400, msg: '内容过长' }
  try {
    const doc = { family_id: familyId, role, content: content.substring(0, 4000), created_at: new Date() }
    if (inputType) doc.input_type = inputType; if (isOcrMsg) doc.ocr_msg = true; if (cards && cards.length > 0) doc.cards = cards; if (suggestions && suggestions.length > 0) doc.suggestions = suggestions; if (pending_confirms && pending_confirms.length > 0) doc.pending_confirms = pending_confirms; if (sessionId) doc.session_id = sessionId; if (msgType) doc.type = msgType
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

// ---------- submitProfiling ----------
async function submitProfiling(db, openid, event) {
  const { familyId, members } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!members || !Array.isArray(members)) return { code: 400, msg: '缺少参数 members' }

  let standardWritten = 0
  const fieldWritePromises = []
  const freeTexts = []
  const memberNameById = {}
  for (const m of members) if (m.memberId) memberNameById[m.memberId] = m.name

  // Phase 1：标准字段 → fact（confidence=1，source=user_form）
  for (const mem of members) {
    const memberId = mem.memberId || ''
    if (mem.standardFields) {
      for (const fld of mem.standardFields) {
        if (!fld.value || !fld.key) continue
        const dimMap = { birth_date: '年龄', gender: '性别', occupation: '职业', health: '健康', education: '教育程度' }
        const dimension = dimMap[fld.key] || fld.key
        if (!ALLOWED_DIMENSIONS.has(dimension)) continue
        const factPredicate = DIM_TO_PREDICATE[dimension]
        if (factPredicate) {
          fieldWritePromises.push(addMemberFact(db, openid, { familyId, memberId, memberName: mem.name, predicate: factPredicate, value: fld.value, confidence: 1 }))
        }
        standardWritten++
      }
    }
    if (mem.freeText && mem.freeText.value && mem.freeText.value.trim()) {
      freeTexts.push({ memberId, name: mem.name || '', text: mem.freeText.value.trim() })
    }
  }
  await Promise.all(fieldWritePromises)

  // Phase 2：自由文本 → AI 提取 → fact（confidence=0.9）
  const { freeExtracted, aiExtractFailed } = await extractFactsFromFreeText({
    db, openid, familyId, freeTexts, memberNameById
  })

  // Phase 3：同步成员属性到 members 集合（Plan A：唯一真相源）
  if (standardWritten > 0 || freeExtracted > 0) {
    const memberSyncPromises = []
    for (const mem of members) {
      if (!mem.memberId) continue
      const fields = {}
      if (mem.standardFields) {
        for (const fld of mem.standardFields) {
          if (!fld.value || !fld.key) continue
          const fieldMap = { birth_date: 'birth_date', gender: 'gender', occupation: 'occupation', health: 'health' }
          const dbField = fieldMap[fld.key]
          if (dbField) fields[dbField] = fld.key === 'birth_date' ? String(fld.value) : fld.value
        }
      }
      if (Object.keys(fields).length > 0) {
        memberSyncPromises.push(updateMemberFields(db, familyId, openid, mem.memberId, fields).catch(e => console.error('[dataWrite] submitProfiling 成员同步失败:', e.message)))
      }
    }
    await Promise.all(memberSyncPromises)
  }

  // Phase 4：成员字段变更 → 经 writeSeam 统一触发 markMutated + advanceStage
  const ws = writeSeam(db, openid, familyId)
  await ws.triggerHooks()

  return { code: 200, data: { standardWritten, freeExtracted, aiExtractFailed, freeTextCount: freeTexts.length } }
}

module.exports = { writeMessage, writeOpLog, submitProfiling }
