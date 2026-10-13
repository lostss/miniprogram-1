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
// 定价/配额/记账已收敛到 ai-accounting（架构审查候选 3）。
// re-export calcTokenUsage / bumpAgentTokens 保持旧调用点（tool-orchestration 等）兼容。
const { calcTokenUsage, bumpAgentTokens } = require('./ai-accounting')
// 架构审计第 6 轮：日志写入统一走 logSeam（含 mutation 模式）
const { logAI, updateLogStatus } = require('./logSeam')

// system 提示词的长度上限（2026-09-22 全面审计 · AI 侧 P1）
// MAX_INPUT（16000）的语义是"**用户输入**闸门"（防超长输入烧 token / 拖垮函数），
// 但 _secureInput 原先对**每一条** message 一律按 MAX_INPUT 截断，system 消息也未能幸免。
// 实测代价：reportAI 的 system prompt = 16330 字（warm 语气 = 16753），被截到 16000 →
//   ① 「## 输出前红线重申」第 2~8 条（数据原貌 / 禁病种 / 禁止重算缺口 / 收入口径 / 话术腔…）
//      全部没送进模型，只剩第 1 条的前半句；
//   ② warm（共情版）整块 423 字位于截断点之后 → **共情语气 100% 无效**，而 agent_logs
//      照旧记 metrics.tone='warm'，从日志上完全看不出功能是空的。
// 提示词是开发者自己写的常量，不是用户输入，故不设"输入闸门"；仍给一个足够大的硬上限，
// 防的是"将来有人把用户内容拼进 system"这类回归把请求撑爆。
const SYSTEM_PROMPT_MAX = 100000

function _secureInput(messages, opts) {
  const userMax = (opts && opts.maxInput) || undefined
  return messages.map(m => {
    let content = sanitize(m.content || '', m.role === 'system' ? SYSTEM_PROMPT_MAX : userMax)
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
  // ctx.maxInput：按调用路径放宽 user 侧上限（如 OCR 的长保单文本，见 ocr-extractor 的 OCR_TEXT_MAX_LEN）。
  // system 消息不受该上限约束（见 _secureInput）。
  const secured = _secureInput(messages, ctx)
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

// calcTokenUsage / bumpAgentTokens 已移至 _shared/ai-accounting.js（架构审查候选 3：
// 「算价 → 计配额」与直连通道手写副本合并为单一事实源），本文件在顶部 require 后
// 于 module.exports 原样 re-export，旧调用点（tool-orchestration 等）无需改动。

/**
 * 共享调用核心：guard → contentSafe(输入) → invokeAI → audit → contentSafe(输出) ∥ writeLog → secureOutput
 * invokeAI(secured) → { text, toolCalls?, usage? }
 * 返回 { text, toolCalls, usage, logId, blocked? }
 *   `blocked: { code, reason }`（2026-09-28 新增）—— 命中审查链任一闸门时给出**显式拒绝通道**，
 *   调用方据此分流；**不得**再把拦截原因当模型输出解析（见下方注释）。
 */
async function _runSecuredPipeline(messages, ctx, invokeAI) {
  const guard = await _pipelineGuard(messages, ctx, ctx.skipInjection)
  // 2026-09-28 全面审计 P1（已实测复现）：被 guard 拦下时必须区分"拒绝"与"模型输出"。
  // 原实现只把原因塞进 `text`，而返回契约里没有任何标记 → 所有调用方都当模型文本处理：
  // reportAI 拿去 parseAIJSON 必然失败 → 记 `report_parse_fail`、用户看到"报告生成失败，
  // 30 秒后可重试"，真实原因（本月 AI 用量已达上限 / 请求过于频繁 / 输入校验未通过）被吞掉，
  // 且指标把"配额拦截"混进"模型格式故障"（实测配额拦截被记为 report_parse_fail）。
  if (guard.blocked) return { text: guard.reason, toolCalls: [], usage: {}, logId: null, blocked: { code: guard.code || 'BLOCKED', reason: guard.reason } }

  const userText = guard.secured.filter(m => m.role === 'user').map(m => m.content).join('\n')
  const inputSafe = await _checkContentSafe(ctx.cloud, userText, ctx.skipContentSafety)
  if (!inputSafe.pass) {
    await _writeLog(ctx, { status: 'blocked', error: { code: 'CONTENT_UNSAFE', message: inputSafe.reason, step: 'content_safety' } })
    return { text: inputSafe.reason, toolCalls: [], usage: {}, logId: null, blocked: { code: 'CONTENT_UNSAFE', reason: inputSafe.reason } }
  }

  let result
  try {
    result = await invokeAI(guard.secured)
  } catch (e) {
    // 日志审计 #2：AI 调用异常（网络/超时/空响应）也落 agent_logs——失败调用已消耗输入 token，
    // 缺失会导致成本核算系统性低估、AI 异常率无日志支撑。
    // 2026-09-12 补 tokens/cost：ai-client 现会把已收到的 usage 挂到 err.usage（ai_empty/ai_format
    // 其实已拿到 res.data.usage），原先失败只落 status='fail' 不记 token，等于把这部分消耗丢掉。
    const failUsage = (e && e.usage) || {}
    const failTokens = calcTokenUsage(failUsage, ctx.model)
    await _writeLog(ctx, {
      status: 'fail',
      error: {
        code: 'AI_CALL_FAIL',
        reason: (e && e.code) ? String(e.code) : '',
        message: (e && e.message) || 'AI调用异常',
        step: 'invoke'
      },
      tokens: { input: failTokens.input, output: failTokens.output, total: failTokens.total },
      cost: failTokens.cost,
      currency: failTokens.currency
    })
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
  const { input, output, total, cost, currency } = calcTokenUsage(usage, ctx.model)

  // P0：用户月度 token 配额原子累加（仅成功调用可计费；DB 不可用/失败不阻断主流程）
  await bumpAgentTokens(ctx.db, ctx.openid, total)

  // C 方案：输出内容安全审核与日志预写并行，减少串行等待
  const outputSafeP = _checkContentSafe(ctx.cloud, result.text || '', ctx.skipContentSafety)
  const logIdP = _writeLog(ctx, {
    status: 'success',
    tokens: { input, output, total },
    cost,
    currency,
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
