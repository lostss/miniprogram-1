/**
 * logSeam.js — 统一日志写入缝（agent_logs + operation_logs 单一事实源）
 *
 * 解决问题：架构审计第 6 轮发现 agent-log.js + operation-logger.js 都是伪共享，
 * 4 处绕过直接 db.collection().add()，schema 各自漂移。本模块统一所有日志写入。
 *
 * 设计：union schema + 按需填充，所有日志写入走此模块
 *   - logAI:        写 agent_logs（AI 调用生命周期，含 tokens/promptVersion 等）→ 返回 logId
 *   - logOperation: 写 operation_logs（CRUD 操作，含 target 字段）
 *   - updateLogStatus: mutation（preWrite→markBlocked 模式，ai-gateway 专用）
 *
 * 异常吞咽：日志失败不阻断主流程（与原 agent-log/operation-logger 一致）
 */

/**
 * 写 agent_logs（AI 调用生命周期日志）
 * @param {object} db - 数据库实例
 * @param {object} entry
 *   - openid, action（必填）
 *   - familyId?, sessionId?, model?, status?
 *   - tokens? { input, output, total }, cost?
 *   - tools?, metrics?
 *   - userText?, replyText?, outputCards?, rawText?
 *   - activatedDimensions?, coreInsights?
 *   - promptVersion?, error?
 * @returns {Promise<string|null>} logId（供 updateLogStatus mutation 使用）
 */
async function logAI(db, entry) {
  if (!db || !entry || !entry.action) return null
  try {
    // S-4 修复：走 writeSeam.silentAdd 接缝，自动注入 _openid 不变量
    const ws = require('./writeSeam').writeSeam(db, entry.openid || '')
    const res = await ws.silentAdd('agent_logs', {
      openid: entry.openid || '',
      family_id: entry.familyId || '',
      sessionId: entry.sessionId || '',
      action: entry.action,
      model: entry.model || '',
      timestamp: new Date(),
      status: entry.status || 'success',
      // AI 调用指标
      tokens: entry.tokens || null,
      cost: entry.cost != null ? entry.cost : null,
      // 工具执行
      tools: entry.tools || [],
      metrics: entry.metrics || {},
      // 内容（按场景填充）
      userText: entry.userText || '',
      replyText: entry.replyText || '',
      outputCards: entry.outputCards || [],
      rawText: entry.rawText || '',
      // 报告特有
      activated_dimensions: entry.activatedDimensions || [],
      core_insights: entry.coreInsights || [],
      // 元数据
      promptVersion: entry.promptVersion || '',
      error: entry.error || null
    })
    return (res && res._id) ? res._id : null
  } catch (e) {
    console.error('[logSeam] logAI 写入失败:', entry.action, e.message)
    return null
  }
}

/**
 * 写 operation_logs（CRUD 操作审计日志）
 * @param {object} db - 数据库实例
 * @param {object} entry
 *   - openid, action（必填）
 *   - familyId?
 *   - target? { collection, docId }
 *   - result? { status, summary, error?, errorCode? }
 *   - meta?
 */
async function logOperation(db, entry) {
  if (!db || !entry || !entry.action || !entry.openid) return
  try {
    // S-4 修复：走 writeSeam.silentAdd 接缝，自动注入 _openid 不变量
    const ws = require('./writeSeam').writeSeam(db, entry.openid || '')
    await ws.silentAdd('operation_logs', {
      action: entry.action,
      openid: entry.openid,
      family_id: entry.familyId || '',
      target: {
        collection: (entry.target && entry.target.collection) || '',
        doc_id: (entry.target && (entry.target.docId || entry.target.doc_id)) || ''
      },
      result: {
        status: (entry.result && entry.result.status) || 'ok',
        summary: (entry.result && entry.result.summary) || '',
        error: (entry.result && entry.result.error) || '',
        error_code: (entry.result && (entry.result.errorCode || entry.result.error_code)) || ''
      },
      meta: entry.meta || {},
      created_at: new Date()
    })
  } catch (e) {
    console.error('[logSeam] logOperation 写入失败:', entry.action, e.message)
  }
}

/**
 * 更新日志状态（mutation 模式：preWrite success → markBlocked）
 * 用于 ai-gateway 的"AI 调用成功但内容审核失败"场景
 * @param {object} db
 * @param {string} logId - logAI 返回的 logId
 * @param {string} status - 'blocked' | 'success' | 'fail'
 * @param {object} [error] - { code, message, step }
 */
async function updateLogStatus(db, logId, status, error) {
  if (!db || !logId) return
  try {
    const data = { status }
    if (error) data.error = error
    await db.collection('agent_logs').doc(logId).update({ data })
  } catch (e) {
    console.error('[logSeam] updateLogStatus 失败:', logId, e.message)
  }
}

module.exports = { logAI, logOperation, updateLogStatus }
