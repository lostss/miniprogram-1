/**
 * _shared/ai-error.js — AI 错误分类唯一接缝（架构审计候选 2）
 *
 * 所有 429/超时/格式错误的识别集中于此，杜绝各模块「各自判断是不是 429」的漂移。
 * 历史 bug：SDK 429 错误 e.code=undefined、e.statusCode=429，只看 e.code 被误判为 ai_exception。
 */
function classifyAIError(e) {
  if (!e) return 'ai_exception'
  if (e.statusCode === 429 || e.status === 429) return '429'
  if (e.code === '429' || e.code === 'RATE_LIMIT' || e.code === 'RequestLimitExceeded') return '429'
  const msg = String(e.message || '')
  if (msg.indexOf('429') >= 0) return '429'
  if (msg.indexOf('RequestLimitExceeded') >= 0 || msg.indexOf('RateLimit') >= 0) return '429'
  if (e.code === 'CHAT_TIMEOUT' || e.code === 'TIMEOUT' || msg.indexOf('CHAT_TIMEOUT') >= 0) return 'CHAT_TIMEOUT'
  if (e.code === 'ai_format' || e.code === 'ai_empty') return e.code
  return e.code || 'ai_exception'
}

function is429(e) {
  return classifyAIError(e) === '429'
}

module.exports = { classifyAIError, is429 }
