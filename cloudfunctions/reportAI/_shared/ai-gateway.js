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
const { sanitize, detectInjection, checkRateLimit, checkMonthlyQuota, auditOutput } = require('./guard')
const { desensitize } = require('./pii-rules')
const { COST_PER_1K, PRICING } = require('./config')
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
  // 月度 token 配额预检（用户级，独立于速率限制；DB 不可用/未建档默认放行）
  if (ctx.db && ctx.openid) {
    const quota = await checkMonthlyQuota(ctx.db, ctx.openid)
    if (!quota.allowed) {
      await _writeLog(ctx, { status: 'blocked', error: { code: 'QUOTA_LIMIT', message: quota.reason, step: 'quota' } })
      return { blocked: true, code: 'QUOTA_LIMIT', reason: quota.reason }
    }
  }
  return { blocked: false, secured }
}

/**
 * 用量与成本计算（2026-09-10 口径校准）
 * 原实现用单一 COST_PER_1K 混合计价且不区分模型——而该常量注释是 hy3 的美元价，
 * 用在 DeepSeek 直连（人民币、输入/输出单价差 4 倍）上会系统性高估。
 * 现按 model 查 config.PRICING（元/百万；hy3 为美元），拆输入未命中/缓存命中/输出三段；
 * 未命中模型时回落 COST_PER_1K 旧口径，避免存量看板断层。
 * @param {object} usage - AI 返回的 usage
 * @param {string} [model] - 实际调用的模型名（ctx.model）
 */
function calcTokenUsage(usage, model) {
  const input = usage.prompt_tokens || usage.promptTokens || usage.input_tokens || 0
  const output = usage.completion_tokens || usage.completionTokens || usage.output_tokens || 0
  const total = usage.total_tokens || usage.totalTokens || (input + output) || 0
  const table = (typeof PRICING !== 'undefined' && PRICING) || null
  const price = (table && model && table[model]) || null
  let cost
  if (price) {
    // DeepSeek 返回 prompt_cache_hit_tokens；命中部分按缓存价计（仅 1/50 单价的差量很大，必须拆开）
    const cachedIn = Math.min(input, usage.prompt_cache_hit_tokens || usage.promptCacheHitTokens || 0)
    const missIn = Math.max(0, input - cachedIn)
    cost = (missIn * price.in + cachedIn * (price.inCached == null ? price.in : price.inCached) + output * price.out) / 1e6
  } else {
    cost = (input + output) / 1000 * COST_PER_1K
  }
  return { input, output, total, cost: Math.round(cost * 1e6) / 1e6 }
}

/**
 * 用户月度 token 配额原子累加（agents.token_used_monthly/total，只加不减）。
 * 供 ai-gateway 内部与 conversationAI 流式收尾（record/postProcess）共用；DB 不可用/失败不抛错。
 */
async function bumpAgentTokens(db, openid, total) {
  if (!db || !openid || !(total > 0) || typeof db.collection !== 'function') return
  try {
    const _ = db.command
    if (_ && typeof _.inc === 'function') {
      await db.collection('agents').where({ openid, _openid: openid })
        .update({ data: { token_used_monthly: _.inc(total), token_used_total: _.inc(total) } })
        .catch(e => console.error('[ai-gateway] 配额累加失败:', e.message))
    }
  } catch (e) { console.error('[ai-gateway] 配额累加异常:', e.message) }
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
  let audit = ctx.skipOutputAudit ? { pass: true, text: result.text || '' } : auditOutput(result.text || '')
  // 2026-09-10：结构化输出（报告 JSON 等）允许"命中即告警、不阻断"。
  // auditOutput 命中时把**整段输出替换成拒答文案**——对 JSON 而言必然解析失败，且原文丢失不可诊断，
  // 重试也会同样被拦（23:20 线上事故：报告两次 output 2218/1846 tokens 全部丢弃）。
  // 仅当调用方显式声明 ctx.outputAuditMode==='warn'（结构化场景）时保留原文，命中信息落日志 metrics。
  const auditWarnOnly = !!(ctx.outputAuditMode === 'warn' && audit && !audit.pass)
  if (auditWarnOnly) {
    console.warn('[ai-gateway] 输出命中禁止承诺规则（warn 模式，保留原文）:', audit.matchedRule || audit.reason)
    audit = { pass: true, text: result.text || '', auditWarning: audit.reason, matchedRule: audit.matchedRule }
  }
  const usage = result.usage || {}
  const { input, output, total, cost } = calcTokenUsage(usage, ctx.model)

  // P0：用户月度 token 配额原子累加（仅成功调用可计费；DB 不可用/失败不阻断主流程）
  await bumpAgentTokens(ctx.db, ctx.openid, total)

  // C 方案：输出内容安全审核与日志预写并行，减少串行等待
  const outputSafeP = _checkContentSafe(ctx.cloud, result.text || '', ctx.skipContentSafety)
  const logIdP = _writeLog(ctx, {
    status: 'success',
    tokens: { input, output, total },
    cost,
    // warn 模式命中：规则写进日志 metrics，保留合规可观测性（不再以牺牲功能可用性为代价）
    metrics: auditWarnOnly ? { outputAuditWarning: audit.auditWarning, matchedRule: audit.matchedRule } : {}
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
  // 观测统一修复（2026-09-05）：ctx.openid 透传到 ai-client 观测（_defaultObserve 落 _openid 归因 AI 成本）
  if (!mergedOpts.openid && ctx && ctx.openid) mergedOpts.openid = ctx.openid
  return _runSecuredPipeline(messages, ctx, (secured) => rawCallChat(secured, mergedOpts))
}

async function safeCallChatWithTools(messages, tools, rawCallChatWithTools, ctx = {}, opts = {}) {
  const mergedOpts = Object.assign({}, opts)
  if (!mergedOpts.model && ctx && ctx.model) mergedOpts.model = ctx.model
  if (!mergedOpts.openid && ctx && ctx.openid) mergedOpts.openid = ctx.openid
  return _runSecuredPipeline(messages, ctx, (secured) => rawCallChatWithTools(secured, tools, mergedOpts))
}

module.exports = { safeCallChat, safeCallChatWithTools, checkContentSafe: _checkContentSafe, calcTokenUsage, bumpAgentTokens }
