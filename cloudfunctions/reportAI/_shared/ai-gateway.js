/**
 * _shared/ai-gateway.js — 统一 AI 调用安全网关 v4.1（权威源）
 *
 * 完整调用链 + 统一日志（成功/失败均记录）：
 *   sanitize → PII脱敏 → 注入检测 → 内容安全 → 限流 → 调用AI → 输出审计 → 日志
 *
 * 返回 { text, usage, logId, toolCalls? } —— logId 供函数层追加业务指标
 *
 * v4.1：safeCallChat 与 safeCallChatWithTools 共享 _runSecuredPipeline（消除 80% 重复）；
 *       desensitize 统一调用 pii-rules.desensitize（删除本文件副本）。
 *
 * 用法：
 *   const { text, usage, logId } = await safeCallChat(messages, callChat, ctx, opts)
 *   if (logId) db.collection('agent_logs').doc(logId).update({ data: { userText: '...' } })
 */
const { sanitize, detectInjection, checkRateLimit, auditOutput } = require('./guard')
const { desensitize } = require('./pii-rules')
const { COST_PER_1K } = require('./config')
// 架构审计第 6 轮：日志写入统一走 logSeam（含 mutation 模式）
const { logAI, updateLogStatus } = require('./logSeam')

function _secureInput(messages) {
  return messages.map(m => {
    let content = sanitize(m.content || '')
    if (m.role === 'user') content = desensitize(content)
    return { ...m, content }
  })
}

function _checkInjection(messages) {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const inj = detectInjection(m.content)
    if (inj.injected) return { blocked: true, reason: inj.rule || '输入校验失败' }
  }
  return { blocked: false }
}

async function _checkContentSafe(cloud, text, skip) {
  if (!cloud || !text || skip) return { pass: true }
  const { SECURITY } = require('./config')
  try {
    const res = await cloud.openapi.security.msgSecCheck({ content: text.substring(0, SECURITY.CONTENT_AUDIT_TRUNCATE) })
    if (res && (res.result === 'block' || res.result === 'review')) return { pass: false, reason: '内容安全审核未通过' }
  } catch (e) {
    // -604101：函数未开通 TMS 内容安全 API 权限 → 降级放行（复核不可用，不阻断对话）；其余异常才报错
    if (e && e.errCode === -604101) {
      console.warn('[ai-gateway] 内容安全审核权限未开通（-604101），本次复核降级跳过')
    } else {
      console.error('[ai-gateway] 内容安全审核异常:', e.message)
    }
  }
  return { pass: true }
}

function _secureOutput(text, auditResult) {
  if (!auditResult.pass) return { blocked: true, text: auditResult.text }
  // auditOutput 已调用 pii-rules.desensitize 完成 PII 脱敏，此处直接返回
  return { blocked: false, text: auditResult.text }
}

/** 统一写日志（委托 logSeam.logAI），返回 logId 供业务层追加字段 */
async function _writeLog(ctx, logData) {
  if (!ctx || !ctx.db || ctx.skipLog) return null
  // logData 中可能含 status / tokens / cost / error 等字段
  return logAI(ctx.db, {
    openid: ctx.openid,
    familyId: ctx.familyId,
    sessionId: ctx.sessionId,
    traceId: ctx.traceId,
    action: ctx.action || 'ai_call',
    model: ctx.model,
    ...logData
  })
}

/** 共享流水线核心：secureInput → injectCheck → rateLimit → 返回值 { blocked, reason, code, secured? } */
async function _pipelineGuard(messages, ctx, skipInjection) {
  const secured = _secureInput(messages)
  if (!skipInjection) {
    const injection = _checkInjection(secured)
    if (injection.blocked) {
      await _writeLog(ctx, { status: 'blocked', error: { code: 'INJECTION', message: injection.reason, step: 'guard' } })
      return { blocked: true, code: 'INJECTION', reason: injection.reason }
    }
  }
  if (ctx.db && ctx.openid && !ctx.skipRateLimit) {
    const rate = await checkRateLimit(ctx.db, ctx.openid)
    if (!rate.allowed) {
      await _writeLog(ctx, { status: 'blocked', error: { code: 'RATE_LIMIT', message: rate.reason, step: 'rate_limit' } })
      return { blocked: true, code: 'RATE_LIMIT', reason: rate.reason }
    }
  }
  return { blocked: false, secured }
}

function _calcTokens(usage) {
  const input = usage.prompt_tokens || usage.promptTokens || usage.input_tokens || 0
  const output = usage.completion_tokens || usage.completionTokens || usage.output_tokens || 0
  const total = usage.total_tokens || usage.totalTokens || (input + output) || 0
  const cost = Math.round((input + output) / 1000 * COST_PER_1K * 10000) / 10000
  return { input, output, total, cost }
}

/**
 * 共享调用核心：guard → contentSafe(输入) → invokeAI → audit → contentSafe(输出) ∥ writeLog → secureOutput
 * invokeAI(secured) → { text, toolCalls?, usage? }
 * 返回 { text, toolCalls, usage, logId }
 */
async function _runSecuredPipeline(messages, ctx, invokeAI) {
  const guard = await _pipelineGuard(messages, ctx, ctx.skipInjection)
  if (guard.blocked) return { text: guard.reason, toolCalls: [], usage: {}, logId: null }

  const userText = guard.secured.filter(m => m.role === 'user').map(m => m.content).join('\n')
  const inputSafe = await _checkContentSafe(ctx.cloud, userText, ctx.skipContentSafety)
  if (!inputSafe.pass) {
    await _writeLog(ctx, { status: 'blocked', error: { code: 'CONTENT_UNSAFE', message: inputSafe.reason, step: 'content_safety' } })
    return { text: inputSafe.reason, toolCalls: [], usage: {}, logId: null }
  }

  let result
  try {
    result = await invokeAI(guard.secured)
  } catch (e) {
    // 日志审计 #2：AI 调用异常（网络/超时/空响应）也落 agent_logs——失败调用已消耗输入 token，
    // 缺失会导致成本核算系统性低估、AI 异常率无日志支撑
    await _writeLog(ctx, { status: 'fail', error: { code: 'AI_CALL_FAIL', message: (e && e.message) || 'AI调用异常', step: 'invoke' } })
    throw e
  }
  // OCR/结构化提取场景：AI 返回 JSON 是业务数据，不应脱敏（保单号/身份证号需原样入库）
  // 对话场景：AI 返回自然语言给用户，需脱敏 PII
  // 通过 ctx.skipOutputAudit 跳过输出脱敏，由调用方在入库时按字段脱敏（如 writePolicy 对 special_agreement）
  const audit = ctx.skipOutputAudit ? { pass: true, text: result.text || '' } : auditOutput(result.text || '')
  const usage = result.usage || {}
  const { input, output, total, cost } = _calcTokens(usage)

  // C 方案：输出内容安全审核与日志预写并行，减少串行等待
  const outputSafeP = _checkContentSafe(ctx.cloud, result.text || '', ctx.skipContentSafety)
  const logIdP = _writeLog(ctx, {
    status: 'success',
    tokens: { input, output, total },
    cost
  })
  const [outputSafe, logId] = await Promise.all([outputSafeP, logIdP])

  if (!outputSafe.pass) {
    // 审核未通过：将刚才预写的成功日志改为 blocked 状态（委托 logSeam.updateLogStatus）
    if (logId) {
      await updateLogStatus(ctx.db, logId, 'blocked', {
        code: 'OUTPUT_UNSAFE', message: 'AI输出内容安全审核未通过', step: 'content_safety'
      })
    }
    return { text: audit.pass ? '回复内容安全审核未通过' : audit.text, toolCalls: [], usage, logId: null }
  }

  const securedOutput = _secureOutput(result.text || '', audit)
  const toolCalls = result.toolCalls || []
  return { text: securedOutput.text, toolCalls, usage, logId }
}

async function safeCallChat(messages, rawCallChat, ctx = {}, opts = {}) {
  // ctx.model 用于日志；同时桥接到 opts.model，让 callChat 真正使用（修复 Bug-6：原 callChat 丢弃 model）
  const mergedOpts = Object.assign({}, opts)
  if (!mergedOpts.model && ctx && ctx.model) mergedOpts.model = ctx.model
  return _runSecuredPipeline(messages, ctx, (secured) => rawCallChat(secured, mergedOpts))
}

async function safeCallChatWithTools(messages, tools, rawCallChatWithTools, ctx = {}, opts = {}) {
  const mergedOpts = Object.assign({}, opts)
  if (!mergedOpts.model && ctx && ctx.model) mergedOpts.model = ctx.model
  return _runSecuredPipeline(messages, ctx, (secured) => rawCallChatWithTools(secured, tools, mergedOpts))
}

module.exports = { safeCallChat, safeCallChatWithTools, checkContentSafe: _checkContentSafe }
