/**
 * conversationAI v5.0 — 三模式架构（PRD v1.4 对齐）
 *
 * 模式划分：
 *   getPrompt    — 构建系统提示词 + 上下文（含报告内容），前端流式用
 *   generateText — 降级路径用，走完整安全网关调 AI 返回文本（无工具）
 *   postProcess  — 流式/降级后调用：审计 + 工具执行 + 卡片解析 + 持久化
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const { sanitize, checkRateLimit, auditOutput } = require('./_shared/guard')
// ponytail: ai-client/ai-gateway 按需加载（generateText 才用），避免 getPrompt 启动时因 @cloudbase/node-sdk 依赖炸裂
const { buildAdvisorSystemPrompt, buildStreamingPrompt, stripToolCardMarkers } = require('./prompts')
const { upsertMember, upsertFinances } = require('./_shared/memberRepo')
const { buildFamilyContext: buildV2Context } = require('./_shared/v2-context')
const { getFamily } = require('./_shared/db-helpers')
// 工具 schema 单一事实源（架构审计 A1：从编排文件外移）
const { TOOL_DEFINITIONS } = require('./tools')
// 架构审计第 15 轮候选 #1：UI 文案契约外移到 tool-summaries.js，编排文件聚焦"调谁"
const { TOOL_SUMMARIES } = require('./tool-summaries')

// ponytail: 成员/财务走 memberRepo（进程内）；保单/事实经 dataWrite 网关（Fork A 统一写入缝）
const { REPORT_THROTTLE_MS: _REPORT_THROTTLE_MS, AI: _AI_CONFIG } = require('./_shared/config')
// 架构审计第 10 轮：跨函数调用统一委托 cross-fn-call seam（消除 _callWrite/_callQuery/_runReport 三处重复模板）
const { callSibling } = require('./_shared/cross-fn-call')
// 架构审计第 12 轮：补 logAI 导入（原 postProcess 引用未导入，回归 bug）
const { logAI } = require('./_shared/logSeam')
// 架构审计第 14 轮候选 #2：错误格式化统一委托 errorHandler
const { wrapError } = require('./_shared/errorHandler')

// dataWrite 网关薄包装（label 区分 action 便于排障）
async function _callWrite(action, payload, openid) {
  return callSibling(cloud, 'dataWrite', { action, ...payload }, openid, { label: 'dataWrite.' + action })
}

// dataQuery 网关薄包装（与 _callWrite 对称）
async function _callQuery(action, payload, openid) {
  return callSibling(cloud, 'dataQuery', { action, ...payload }, openid, { label: 'dataQuery.' + action })
}

// 报告再生：节流 + fire-and-forget（不阻塞对话返回）
// S1-2/S2-1 修复：reportAI timeout=60s，await 必然导致 conversationAI(30s) 超时
// 改为 fire-and-forget：节流校验后立即返回 triggered:true，reportAI 后台异步执行
// S2-1 修复：retry:0 遵守 maxAttempts=1 硬约束，避免双倍 AI 调用
async function _runReport(familyId, openid) {
  const fam = await getFamily(db, familyId, openid)
  const lastAt = (fam && fam.last_analysis_at) ? new Date(fam.last_analysis_at).getTime() : 0
  const now = Date.now()
  if (now - lastAt < _REPORT_THROTTLE_MS) return { code: 200, skipped: true }

  // fire-and-forget：不 await，错误仅记录日志，不影响对话返回
  callSibling(cloud, 'reportAI', { familyId }, openid, {
    label: 'reportAI',
    retry: 0
  }).catch(e => console.error('[conversationAI] reportAI 后台失败:', e.message))

  return { code: 200, triggered: true }
}

// 策略表：tool → { exec, needsConfirm?, pending? }
// 新增工具只改此表，不再修改 _dispatch / _toolResultSummary（架构审计第 10 轮：策略表；第 12 轮：合并 summary hook）
// 架构审计第 15 轮候选 #1：summary 函数外移到 tool-summaries.js，本表仅保留执行契约 + 交互契约
const TOOL_DISPATCHERS = {
  upsertMember: {
    exec: ({ familyId, args, openid }) => upsertMember(db, familyId, openid, { ...args, confirmOnConflict: true })
  },
  updateFinances: {
    exec: ({ familyId, args, openid }) => upsertFinances(db, familyId, openid, args)
  },
  addPolicy: {
    exec: ({ familyId, args, openid }) => _callWrite('writePolicy', { familyId, data: args }, openid)
  },
  addFact: {
    exec: ({ familyId, args, openid }) => _callWrite('addFact', { familyId, ...args }, openid)
  },
  updateFactConfidence: {
    // 置信度升级由 _handleConfirm 处理，不出现在正常工具链
    exec: ({ familyId, args, openid }) => _callWrite('updateFactConfidence', { familyId, ...args }, openid)
  },
  triggerAnalysis: {
    exec: ({ familyId, openid }) => _runReport(familyId, openid)
  },
  writeMessage: {
    // 特殊：postProcess 内部写消息用，传整个 params（含 familyId）；不出现在工具摘要里
    exec: ({ params, openid }) => _callWrite('writeMessage', params, openid)
  },
  queryPolicies: {
    exec: ({ familyId, openid }) => _callQuery('queryPolicies', { familyId }, openid)
  },
  queryMembers: {
    exec: ({ familyId, openid }) => _callQuery('queryMembers', { familyId }, openid)
  },
  queryFacts: {
    exec: ({ familyId, args, openid }) => _callQuery('queryFacts', { familyId, ...args }, openid)
  },
  createFamily: {
    // 新建客户家庭档案（底层要求至少一个成员），返回新建家庭 ID
    exec: ({ args, openid }) => _callWrite('createFamily', args, openid)
  },
  updatePolicy: {
    exec: ({ familyId, args, openid }) => _callWrite('updatePolicy', { familyId, ...args }, openid)
  },
  deleteMember: {
    needsConfirm: true,
    // 删除走 sug 确认，confirmed 路径经 _handleConfirm；正常工具链不应到达 summary
    exec: ({ familyId, args, openid }) => _callWrite('deleteMember', { familyId, ...args }, openid),
    pending: (args) => ({ toolName: 'deleteMember', payload: { memberId: args.memberId, memberName: args.memberName }, target: args.memberName ? '成员 ' + args.memberName : '成员' })
  },
  deletePolicy: {
    needsConfirm: true,
    // 删除仅置 insight_stale，不自动刷新报告
    exec: ({ familyId, args, openid }) => _callWrite('deletePolicy', { familyId, ...args }, openid),
    pending: (args) => ({ toolName: 'deletePolicy', payload: { policyId: args.policyId, product_name: args.product_name, insured_name: args.insured_name, policy_number: args.policy_number }, target: '保单 ' + (args.product_name || args.policyId || '') })
  },
  deleteFact: {
    needsConfirm: true,
    exec: ({ familyId, args, openid }) => _callWrite('deleteFact', { familyId, ...args }, openid),
    pending: (args) => ({ toolName: 'deleteFact', payload: { factId: args.factId }, target: '事实 ' + (args.factId || '') })
  }
}

// 查表执行：新增工具只改 TOOL_DISPATCHERS，不再改此函数
async function _dispatch(tool, params, openid) {
  const { familyId, ...args } = params
  const dispatcher = TOOL_DISPATCHERS[tool]
  if (!dispatcher) return { success: false, error: '未注册工具: ' + tool }
  if (tool !== 'createFamily' && !familyId) return { success: false, error: '缺少 familyId' }
  // 删除类工具：未 confirmed 时返回待确认卡片，由 _handleConfirm 带 confirmed 执行
  if (dispatcher.needsConfirm && !args.confirmed) {
    const p = dispatcher.pending(args)
    return { code: 409, needsConfirm: true, confirmType: 'delete', ...p }
  }
  return dispatcher.exec({ familyId, args, params, openid })
}
const PROMPT_VERSION = 'v6.0'

// ponytail: v2 上下文直接查 5 集合
async function _buildContext(familyId, openid) {
  const ctx = await buildV2Context(db, familyId, openid, 'conversation')
  return ctx.markdown
}

// postProcess 专用：画像 + 原始成员表 + 财务表 + 保单清单 + 报告结论摘要，让 AI 在调工具前做冲突检测与精确定位
// 同 family 5s 内复用缓存，避免快速连续消息时重复查询 5 集合
// v2-context 接口收敛：调用 'tool' 场景，复用内部已查询的 members/finances，仅额外查 policies
// 架构审计 A3：模块级 Map → CtxCache 类（TTL/LRU 内聚，可注入测试）
// 架构审计第 12 轮：删除 _policyTable 浅包装，直接调 buildPolicyTable（接口与实现同构）
const { CtxCache } = require('./ctx-cache')
const { buildPolicyTable, AI_LOCATOR_COLUMNS } = require('./_shared/policy-table')
const { loadActivePolicies } = require('./_shared/policy-read')
// 架构审计第 17 轮候选 #2：sug 拦截所需"最近 assistant 消息"读取经 _shared/message-read 接缝
const { getLatestAssistantMsg } = require('./_shared/message-read')
const _ctxCache = new CtxCache({ ttlMs: 5000, maxSize: 20 })
async function _buildToolContext(familyId, openid) {
  const cached = _ctxCache.get(familyId)
  if (cached) return cached

  // 架构审计第 16 轮候选 #1：policies 读取走 loadActivePolicies 接缝
  // （_openid 注入 + 过滤 deleted，避免 AI 看到已作废保单导致误操作）
  const [ctx, policies] = await Promise.all([
    buildV2Context(db, familyId, openid, 'tool'),
    loadActivePolicies(db, familyId, openid, { ensureStatus: false, limit: 50 })
  ])
  const pt = buildPolicyTable(policies, {
    title: '## 保单清单（updatePolicy/deletePolicy 定位用）',
    columns: AI_LOCATOR_COLUMNS
  })
  const parts = [ctx.markdown]
  if (pt) parts.push(pt)
  const result = parts.join('\n\n')
  _ctxCache.set(familyId, result)
  return result
}

async function _writeMessage(familyId, openid, role, content, opts = {}) {
  try {
    const msgData = {
      familyId, role, content: content.substring(0, 4000),
      inputType: opts.inputType || (role === 'user' ? 'text' : ''),
      sessionId: opts.sessionId || '',
      cards: opts.cards,
      suggestions: opts.suggestions,
      pending_confirms: opts.pending_confirms
    }
    await _dispatch('writeMessage', msgData, openid)
    return true
  } catch (e) {
    console.error('[conversationAI] _writeMessage 失败:', role, e.message)
    return false
  }
}

// ======================== 模式 1：getPrompt ========================
async function _handleGetPrompt(event, openid) {
  const { familyId } = event
  const ctx = await _buildContext(familyId, openid)
  const systemPrompt = buildStreamingPrompt()
  return { code: 200, data: { systemPrompt, context: ctx, promptVersion: PROMPT_VERSION } }
}

// ======================== 模式 2：generateText（降级路径）========================
// 仅调 AI 返回文本，不做工具执行/持久化（由 postProcess 统一处理，避免双写）
async function _handleGenerateText(event, openid) {
  const { familyId, systemPrompt, messages, text, sessionId } = event
  if (!systemPrompt) return { code: 400, msg: '缺少 systemPrompt（请先调用 getPrompt）' }
  if (!text) return { code: 400, msg: '缺少 text' }

  const cleaned = sanitize(text)
  if (!cleaned) return { code: 200, data: { content: '输入无效' } }

  const rate = await checkRateLimit(db, openid)
  if (!rate.allowed) return { code: 200, data: { content: rate.reason } }

  // ponytail: ai-client/ai-gateway 按需加载，避免 getPrompt 启动时炸裂
  const { callChat } = require('./_shared/ai-client')
  const { safeCallChat } = require('./_shared/ai-gateway')

  const now = new Date()
  const dateHint = '当前日期：' + now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日'
  const userMsgs = (messages || []).slice(-15).map(m => ({
    role: m.role, content: (m.content || '').substring(0, 1500)
  }))

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...userMsgs,
    { role: 'user', content: dateHint + '\n\n用户：' + cleaned }
  ]

  const result = await safeCallChat(
    fullMessages, callChat,
    { cloud, db, openid, familyId, sessionId: sessionId || ('s_' + Date.now().toString(36)), model: _AI_CONFIG.CHAT_MODEL, action: 'conversation_generate' },
    { maxTokens: 1200 }
  )

  // 不写 messages（由 postProcess 统一写）
  // 不执行工具（由 postProcess 统一执行）
  return { code: 200, data: { content: result.text, logId: result.logId } }
}

// ======================== 模式 3：postProcess（关键）========================
// 流式/降级后调用：审计 + 工具执行 + 卡片解析 + 持久化
async function _handlePostProcess(event, openid) {
  const { familyId, userText, text, sessionId } = event
  if (!familyId) return { code: 400, msg: '缺少 familyId' }

  const sid = sessionId || ('s_' + Date.now().toString(36))
  const t0 = Date.now()
  const cleanedUserText = userText ? sanitize(userText) : ''

  // 0. CONFIRM 拦截：用户点击确认卡片，不走 AI，直接执行工具（text 可为空）
  const confirmMatch = cleanedUserText && cleanedUserText.match(/^\{CONFIRM:([\w-]+)\}$/)
  if (confirmMatch) {
    const cardId = confirmMatch[1]
    const cardResult = await _handleConfirm(familyId, openid, cardId, sid)
    return cardResult
  }
  // 0b. KEEP 拦截：用户选择"保留原值"，不覆盖历史
  const keepMatch = cleanedUserText && cleanedUserText.match(/^\{KEEP:([\w-]+)\}$/)
  if (keepMatch) {
    const cardId = keepMatch[1]
    return _handleKeep(familyId, openid, cardId, sid)
  }

  // 0c. sug 拦截：用户点击气泡下方建议回复，匹配最近 assistant 消息的 suggestions
  if (cleanedUserText) {
    const lastMsg = await getLatestAssistantMsg(db, familyId, openid)
    if (lastMsg && lastMsg.suggestions && lastMsg.pending_confirms) {
      const sugIdx = lastMsg.suggestions.indexOf(cleanedUserText)
      if (sugIdx >= 0) {
        const pc = lastMsg.pending_confirms[sugIdx]
        if (pc) {
          if (pc.action === 'CONFIRM') return _handleConfirm(familyId, openid, pc.pendingId, sid, cleanedUserText)
          if (pc.action === 'KEEP') return _handleKeep(familyId, openid, pc.pendingId, sid, cleanedUserText)
        }
      }
    }
  }

  // N-2 修复：流式模式下 postProcess 是实际入口，补齐与 generateText 一致的频控
  // （CONFIRM/KEEP/sug 为确认动作不消耗 AI，已在上方放行）
  const rate = await checkRateLimit(db, openid)
  if (!rate.allowed) {
    if (cleanedUserText) await _writeMessage(familyId, openid, 'user', cleanedUserText, { sessionId: sid })
    const limitText = rate.reason || '操作过于频繁，请稍后再试'
    await _writeMessage(familyId, openid, 'assistant', limitText, { sessionId: sid })
    return { code: 200, data: { cleanText: limitText, toolResults: [], auditBlocked: false, userWritten: !!cleanedUserText, assistantWritten: true } }
  }

  if (!text) return { code: 400, msg: '缺少 text（AI 输出）' }

  // 1. 输出审计（禁止承诺 + PII 脱敏）
  const audit = auditOutput(text)

  // 2. 工具编排（架构审计第 12 轮：抽 tool-orchestration.js，postProcess 仅编排 + 持久化）
  // 预构建 tool context 并写入 ctxCache，orchestrate 内部从缓存取
  if (cleanedUserText) {
    await _buildToolContext(familyId, openid)
  }
  const { orchestrate } = require('./tool-orchestration')
  const orchResult = await orchestrate({
    familyId, openid, sid,
    userText: cleanedUserText,
    auditText: audit.text,
    dispatch: _dispatch,
    ctxCache: _ctxCache,
    toolDefs: TOOL_DEFINITIONS,
    toolSummaries: TOOL_SUMMARIES,
    buildAdvisorSystemPrompt
  })
  let cleanText = orchResult.cleanText
  const suggestions = orchResult.suggestions
  const pending_confirms = orchResult.pending_confirms
  const toolResults = orchResult.toolResults

  // 3. 清理标记（架构审计第 12 轮：删除 legacy cards 死变量）
  cleanText = stripToolCardMarkers(cleanText).trim()

  // 4. 持久化消息
  let userWritten = false
  if (cleanedUserText) {
    userWritten = await _writeMessage(familyId, openid, 'user', cleanedUserText, { sessionId: sid })
  }
  const assistantWritten = await _writeMessage(familyId, openid, 'assistant', cleanText, {
    suggestions: suggestions.length > 0 ? suggestions : undefined,
    pending_confirms: pending_confirms.length > 0 ? pending_confirms : undefined,
    sessionId: sid
  })

  // 5. 写 agent_logs（委托 logSeam.logAI）
  await logAI(db, {
    openid, familyId, sessionId: sid,
    action: 'conversation_postprocess',
    model: _AI_CONFIG.CHAT_MODEL,
    status: 'success',
    userText: (cleanedUserText || '').substring(0, 200),
    replyText: cleanText.substring(0, 800),
    tools: toolResults.map(tr => ({ tool: tr.toolName, success: tr.success, error: tr.error || null, result: tr.result })),
    metrics: { total: Date.now() - t0, toolCount: toolResults.length },
    promptVersion: PROMPT_VERSION
  })

  return {
    code: 200,
    data: {
      cleanText,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      pending_confirms: pending_confirms.length > 0 ? pending_confirms : undefined,
      toolResults: toolResults.map(tr => ({ tool: tr.toolName, success: tr.success, error: tr.error || null, result: tr.result })),
      auditBlocked: !audit.pass,
      userWritten,
      assistantWritten
    }
  }
}

// ======================== CONFIRM/KEEP 处理（策略表驱动，外移到 confirm-handler.js）========================
// 委托给 confirm-handler.js，三分支骨架合并为单一流，注入 dispatch/writeMessage/ctxCache 即可独立测试
const { handleConfirm: _handleConfirmImpl, handleKeep: _handleKeepImpl } = require('./confirm-handler')

async function _handleConfirm(familyId, openid, pendingId, sid, userText) {
  // 架构审计第 17 轮候选 #2：经 _shared/message-read 接缝读取最近 assistant 消息
  const lastMsg = await getLatestAssistantMsg(db, familyId, openid)
  return _handleConfirmImpl({
    familyId, openid, pendingId, sid, userText,
    lastMsg, ctxCache: _ctxCache,
    dispatch: (action, payload, _openid) => _dispatch(action, payload, _openid),
    writeMessage: _writeMessage,
    db, promptVersion: PROMPT_VERSION
  })
}

async function _handleKeep(familyId, openid, pendingId, sid, userText) {
  // 架构审计第 17 轮候选 #2：经 _shared/message-read 接缝读取最近 assistant 消息
  const lastMsg = await getLatestAssistantMsg(db, familyId, openid)
  return _handleKeepImpl({
    familyId, openid, pendingId, sid, userText,
    lastMsg,
    writeMessage: _writeMessage,
    db, promptVersion: PROMPT_VERSION
  })
}

// ======================== 主入口 ========================
exports.main = async (event, context) => {
  const { familyId, mode } = event
  const wxContext = cloud.getWXContext()
  const openid = wxContext?.OPENID || wxContext?.openId
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!openid) return { code: 401, msg: '未登录' }
  try {
    switch (mode) {
      case 'getPrompt':
        return await _handleGetPrompt(event, openid)
      case 'generateText':
        return await _handleGenerateText(event, openid)
      case 'postProcess':
        return await _handlePostProcess(event, openid)
      default:
        return { code: 400, msg: '不支持的 mode：' + mode }
    }
  } catch (e) {
    return wrapError('处理', e)
  }
}
