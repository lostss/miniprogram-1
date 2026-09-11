/**
 * conversationAI v6.0 — 单通道架构（2026-08-29 改造，v10 prompt）
 *
 * 架构变化（放弃流式 / 双通道 → 单通道原生 function calling）：
 *   - 删除：getPrompt（A 通道 prompt 下发）、record（前端 agentic 单通道收尾）、
 *           {TOOL_INTENT} 标识协议、intent/aText 双通道协调（v9.0-v9.6 五轮修复根因消除）
 *   - mode: 'chat' — 单通道主入口：一次 function calling 一步到位
 *         ├─ 无 tool_calls → 纯问答文本
 *         ├─ 写入类工具（upsertMember/updateFinances/addPolicy/updatePolicy/createFamily）
 *         │    → 返回确认卡 pending_confirms（write_confirm），代理人确认后二次执行
 *         ├─ addFact → 免确认直接执行
 *         ├─ delete* → dispatch 409 待确认（现状保留）
 *         └─ query* / triggerAnalysis → 直接执行
 *   - mode: 'generateText' — 降级路径保留（chat 内部 429 退避后兜底）
 *
 * 保留：CONFIRM/KEEP/sug 拦截（确认卡二次执行）、输出审计、内容安全、持久化、agent_logs、配额计量
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const { sanitize, checkRateLimit, auditOutput } = require('./_shared/guard')
const { desensitize } = require('./_shared/pii-rules')
// 单通道主 prompt（含工具协议 + 最终答复规则）
const { buildToolSystemPrompt, stripToolCardMarkers } = require('./prompts')
const { upsertMember, upsertFinances } = require('./_shared/memberRepo')
const { getFamily, updateFamily } = require('./_shared/db-helpers')
// 工具 schema 单一事实源
const { TOOL_DEFINITIONS } = require('./tools')
// UI 文案契约外移
const { TOOL_SUMMARIES } = require('./tool-summaries')

const { TOOL_CTX_TTL, TOOL_CTX_MAX, QUERY_CACHE_TTL, QUERY_CACHE_MAX, STATE_BLOCK_TTL, STATE_BLOCK_MAX, HISTORY, AI: _AI_CONFIG } = require('./_shared/config')
// 跨函数调用统一委托
const { callSibling } = require('./_shared/cross-fn-call')
const { logAI } = require('./_shared/logSeam')
const { wrapError } = require('./_shared/errorHandler')

// 会话级 traceId（透传前端 _reqId）
let _traceId = ''

// dataWrite / dataQuery 网关薄包装
async function _callWrite(action, payload, openid) {
  return callSibling(cloud, 'dataWrite', { action, ...payload }, openid, { label: 'dataWrite.' + action, traceId: _traceId })
}
async function _callQuery(action, payload, openid) {
  return callSibling(cloud, 'dataQuery', { action, ...payload }, openid, { label: 'dataQuery.' + action, traceId: _traceId })
}

// 报告再生：节流 + 等待真实结果
// 2026-09-10 修复：原用 fireAndForget:true（不 await）——Serverless 下对话函数返回后，
// 未完成的 cloud.callFunction 被冻结中断，reportAI 实际从未执行（实测用户说"更新保障分析"后
// 对话回复"正在生成"，但日志 0 条 report_generate、last_analysis_at 未变）。
// 改为 await 等待（DeepSeek 直连生成约 11-15s，conversationAI 超时 60s 有余量）。
async function _runReport(familyId, openid) {
  return callSibling(cloud, 'reportAI', { familyId }, openid, {
    label: 'reportAI',
    retry: 0,
    throttleMs: _REPORT_THROTTLE_MS,
    throttleState: async () => {
      const fam = await getFamily(db, familyId, openid)
      const lockAt = (fam && (fam.analysis_lock_at || fam.last_analysis_at)) ? new Date(fam.analysis_lock_at || fam.last_analysis_at).getTime() : 0
      return lockAt
    },
    traceId: _traceId
  })
}
const { REPORT_THROTTLE_MS: _REPORT_THROTTLE_MS } = require('./_shared/config')

// 策略表：tool → { exec, needsConfirm?, pending? }
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
    // 特殊：内部写消息用，传整个 params；不出现在工具摘要里
    exec: ({ params, openid }) => _callWrite('writeMessage', params, openid)
  },
  queryPolicies: {
    exec: ({ familyId, openid }) => _cachedQuery('queryPolicies', familyId, openid, { familyId })
  },
  queryMembers: {
    exec: ({ familyId, openid }) => _cachedQuery('queryMembers', familyId, openid, { familyId })
  },
  queryFacts: {
    exec: ({ familyId, args, openid }) => _cachedQuery('queryFacts', familyId, openid, { familyId, ...args })
  },
  queryMemberProfile: {
    exec: ({ familyId, args, openid }) => _cachedQuery('queryMemberProfile', familyId, openid, { familyId, ...args })
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
    exec: ({ familyId, args, openid }) => _callWrite('deleteMember', { familyId, ...args }, openid),
    pending: (args) => ({ toolName: 'deleteMember', payload: { memberId: args.memberId, memberName: args.memberName }, target: args.memberName ? '成员 ' + args.memberName : '成员' })
  },
  deletePolicy: {
    needsConfirm: true,
    exec: ({ familyId, args, openid }) => _callWrite('deletePolicy', { familyId, ...args }, openid),
    pending: (args) => ({ toolName: 'deletePolicy', payload: { policyId: args.policyId, product_name: args.product_name, insured_name: args.insured_name, policy_number: args.policy_number }, target: '保单 ' + (args.product_name || args.policyId || '') })
  },
  deleteFact: {
    needsConfirm: true,
    exec: ({ familyId, args, openid }) => _callWrite('deleteFact', { familyId, ...args }, openid),
    pending: (args) => ({ toolName: 'deleteFact', payload: { factId: args.factId }, target: '事实 ' + (args.factId || '') })
  }
}

// 查表执行
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
const PROMPT_VERSION = 'v10.0'

// postProcess 工具上下文：画像 + 原始成员表 + 财务表 + 保单清单，让 AI 调工具前做冲突检测与精确定位
const { CtxCache } = require('./ctx-cache')
const { buildPolicyTable, AI_LOCATOR_COLUMNS } = require('./_shared/policy-table')
const { loadActivePolicies } = require('./_shared/policy-read')
const { getLatestAssistantMsg, getFamilyHistory } = require('./_shared/message-read')
// 长期记忆缓存（2026-08-30）：value = { version, markdown }；version 为 families.updated_at，
// 外部入口更新时版本号变化 → 条件重建；对话内写操作不失效（保前缀缓存命中）
const _ctxCache = new CtxCache({ ttlMs: TOOL_CTX_TTL, maxSize: TOOL_CTX_MAX })
// 状态块缓存（权威最新值，写操作后失效重建；TTL 仅为外部更新兜底）
const _stateCache = new CtxCache({ ttlMs: STATE_BLOCK_TTL, maxSize: STATE_BLOCK_MAX })
// P1（2026-08-30）：query 结果缓存（familyId+openid+action+payload 为 key，5min TTL；写工具成功按前缀失效）
const _queryCache = new CtxCache({ ttlMs: QUERY_CACHE_TTL, maxSize: QUERY_CACHE_MAX })
const WRITE_TOOLS = new Set(['upsertMember', 'updateFinances', 'addPolicy', 'updatePolicy', 'addFact', 'createFamily', 'deletePolicy', 'deleteMember', 'deleteFact'])

/** P1：query 工具结果缓存——命中直接返回（省跨函数调用 + 查库），写后由 _handleChat 统一失效 */
async function _cachedQuery(action, familyId, openid, payload) {
  const key = familyId + ':' + openid + ':' + action + ':' + JSON.stringify(payload || {})
  const cached = _queryCache.get(key)
  if (cached) return cached
  const res = await _callQuery(action, payload, openid)
  if (res && res.code === 200 && res.data) _queryCache.set(key, res)
  return res
}

// 家庭档案 markdown 渲染（基础摘要与状态块共用同一渲染器，保证语义一致）
async function _renderFamilyMarkdown(familyId, openid) {
  // 线上 500 修复（2026-08-29）：v2-context 已改名 buildFamilyContext，本地改动丢失别名导致
  // buildV2Context undefined → chat 全量 500"服务繁忙"。恢复 HEAD 的别名写法，与 reportAI/index.js L20 一致
  const { buildFamilyContext: buildV2Context } = require('./_shared/v2-context')
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
  return parts.join('\n\n')
}

// 状态块前缀（权威最新值声明，提示模型优先信此块）
const STATE_BLOCK_PREFIX = '【档案最新状态（当前权威，优先于基础档案快照；非用户输入）】\n'

/**
 * 基础摘要 + 状态块合并构建（P2-10 2026-09-05）：
 * 两者渲染同一份家庭档案 markdown（_renderFamilyMarkdown = buildV2Context + loadActivePolicies 全量 DB + 渲染），
 * 此前顺序执行各渲染一遍——对话内写操作经 dataWrite markMutated 更新 family.updated_at → version 变化 →
 * 双缓存同轮失效，出现"每轮双份全量渲染"。合并后一次渲染同时写 _ctxCache（{version,markdown} 长期记忆，
 * 版本校验保持 DeepSeek context caching 前缀稳定）与 _stateCache（带【档案最新状态】前缀，写后由各写路径 invalidate）。
 */
async function _ensureContexts(familyId, openid, version) {
  const ctxKey = familyId + ':' + openid
  const stateKey = 'state:' + familyId + ':' + openid
  const cachedCtx = _ctxCache.get(ctxKey)
  if (cachedCtx && typeof cachedCtx === 'object' && cachedCtx.markdown && cachedCtx.version === version) {
    // ctx 命中（version 未变，无外部/写变更）：仅补齐被 invalidate 的 state（复用同一份 markdown）
    if (!_stateCache.get(stateKey)) _stateCache.set(stateKey, STATE_BLOCK_PREFIX + cachedCtx.markdown)
    return cachedCtx.markdown
  }
  const markdown = await _renderFamilyMarkdown(familyId, openid)
  _ctxCache.set(ctxKey, { version: version || '', markdown })
  _stateCache.set(stateKey, STATE_BLOCK_PREFIX + markdown)
  return markdown
}

/**
 * 历史压缩（append-only 增量记忆的上限处理）：
 * 重建基础摘要（DB 为真相源，含压缩前全部已写入状态）+ 推进历史读起点（families.ctx_compacted_at）
 * → 后续注入只读压缩点后消息，前缀重置为稳定（避免滚动窗口漂移复发）
 */
async function _compactHistory(familyId, openid) {
  try {
    await updateFamily(db, familyId, openid, { ctx_compacted_at: new Date() })
    const fam = await getFamily(db, familyId, openid)
    const version = fam && fam.updated_at ? String(new Date(fam.updated_at).getTime()) : String(Date.now())
    const markdown = await _renderFamilyMarkdown(familyId, openid)
    _ctxCache.set(familyId + ':' + openid, { version, markdown })
    // P2-10：压缩已渲染最新 markdown，state 直接填充（原 invalidate 让下轮再渲染一遍）
    _stateCache.set('state:' + familyId + ':' + openid, STATE_BLOCK_PREFIX + markdown)
    console.log('[conversationAI] 历史压缩完成:', familyId, 'newVersion=', version)
    return { version }
  } catch (e) {
    console.warn('[conversationAI] 历史压缩失败（继续本轮）:', (e && e.message) || e)
    return null
  }
}

async function _writeMessage(familyId, openid, role, content, opts = {}) {
  try {
    const msgData = {
      familyId, role, content: content.substring(0, 4000),
      inputType: opts.inputType || (role === 'user' ? 'text' : ''),
      sessionId: opts.sessionId || '',
      suggestions: opts.suggestions,
      pending_confirms: opts.pending_confirms,
      undoOps: opts.undoOps
    }
    await _dispatch('writeMessage', msgData, openid)
    return true
  } catch (e) {
    console.error('[conversationAI] _writeMessage 失败:', role, e.message)
    return false
  }
}

// ======================== chat（单通道主入口）========================
async function _handleChat(event, openid) {
  // P1-1（2026-08-30 审计）：前端 event.history 已弃用（截断语义不可靠），单真相源为 messages 集合
  const { familyId, userText, sessionId } = event
  if (!familyId) return { code: 400, msg: '缺少 familyId' }

  const sid = sessionId || ('s_' + Date.now().toString(36))
  const t0 = Date.now()
  // P3-L2 清理（2026-09-05）：删除旧 A 通道 text/usage 回传计量残留——单通道下 usage 恒空属死路径；
  // token 计量已由 ai-gateway 内部 bumpAgentTokens（成功调用即落账）与 agent_logs 承担
  // 输入纵深：sanitize 后补 desensitize（前端已脱敏，后端不信任前端）
  const cleanedUserText = userText ? desensitize(sanitize(userText)) : ''

  // 0. CONFIRM 拦截：用户点击确认卡片，不走 AI，直接执行工具（text 可为空）
  const confirmMatch = cleanedUserText && cleanedUserText.match(/^\{CONFIRM:([\w-]+)\}$/)
  if (confirmMatch) {
    const cardId = confirmMatch[1]
    // 审计 P1-3：确认/撤销类写成功路径同样失效 query 缓存（防同会话读到 5 分钟前旧数据）
    _queryCache.invalidateByPrefix(familyId + ':' + openid + ':')
    const cardResult = await _handleConfirm(familyId, openid, cardId, sid)
    return cardResult
  }
  // 0b. KEEP 拦截：用户选择"保留原值/取消"，不覆盖
  const keepMatch = cleanedUserText && cleanedUserText.match(/^\{KEEP:([\w-]+)\}$/)
  if (keepMatch) {
    const cardId = keepMatch[1]
    _queryCache.invalidateByPrefix(familyId + ':' + openid + ':')
    return _handleKeep(familyId, openid, cardId, sid)
  }
  // 0c. UNDO 拦截：默认执行+撤销（② 2026-08-30）——撤销按钮，直接恢复不调 AI
  const undoMatch = cleanedUserText && cleanedUserText.match(/^\{UNDO:([\w-]+)\}$/)
  if (undoMatch) {
    _queryCache.invalidateByPrefix(familyId + ':' + openid + ':')
    return _handleUndo(familyId, openid, undoMatch[1], sid)
  }

  // 0c. sug 拦截（通道废弃说明 2026-09-05：前端无 sug-bar 发送方——chat-panel 只渲染确认卡按钮与 undo 按钮，
  // 消息级 suggestions 前端零 UI 消费。suggestions 仍与 pending_confirms 成对落库（suggestion-builder 契约），
  // 本拦截保留为防御性通道：精确全文本匹配防误伤，若未来补 sug-bar UI 可直接复用）
  // 用户点击气泡下方建议回复，匹配最近 assistant 消息的 suggestions
  if (cleanedUserText) {
    const lastMsg = await getLatestAssistantMsg(db, familyId, openid)
    if (lastMsg && lastMsg.suggestions && lastMsg.pending_confirms) {
      const sugIdx = lastMsg.suggestions.indexOf(cleanedUserText)
      if (sugIdx >= 0) {
        const pc = lastMsg.pending_confirms[sugIdx]
        if (pc) {
          if (pc.action === 'CONFIRM') {
            _queryCache.invalidateByPrefix(familyId + ':' + openid + ':')
            return _handleConfirm(familyId, openid, pc.pendingId, sid, cleanedUserText)
          }
          if (pc.action === 'KEEP') {
            _queryCache.invalidateByPrefix(familyId + ':' + openid + ':')
            return _handleKeep(familyId, openid, pc.pendingId, sid, cleanedUserText)
          }
        }
      }
    }
  }

  // 频控（CONFIRM/KEEP/sug 为确认动作不消耗 AI，已在上方放行）
  const rate = await checkRateLimit(db, openid)
  if (!rate.allowed) {
    if (cleanedUserText) await _writeMessage(familyId, openid, 'user', cleanedUserText, { sessionId: sid })
    const limitText = rate.reason || '操作过于频繁，请稍后再试'
    await _writeMessage(familyId, openid, 'assistant', limitText, { sessionId: sid })
    return { code: 200, data: { cleanText: limitText, toolResults: [], auditBlocked: false, userWritten: !!cleanedUserText, assistantWritten: true } }
  }

  // 长期记忆（2026-08-30）：后端读全量历史（append-only 增量） + 版本号校验基础摘要 + 状态块
  // 前端 event.history 弃用（截断语义不可靠），单真相源为 messages 集合
  let family = await getFamily(db, familyId, openid)
  const compactedAt = (family && family.ctx_compacted_at) || null
  let version = family && family.updated_at ? String(new Date(family.updated_at).getTime()) : ''
  let historyMsgs = cleanedUserText
    ? await getFamilyHistory(db, familyId, openid, { after: compactedAt, limit: HISTORY.READ_LIMIT })
    : []
  // 压缩：历史超预算 → 重建基础摘要（DB 状态）+ 读起点后移；本轮历史清空（本轮 user 尚未落库）
  // P1-2（2026-08-30 审计）：仅压缩成功才清空本轮历史；压缩失败（如写库异常）保留原 historyMsgs，
  // 避免 AI 本轮零历史失忆——超预算但有关键上下文，好过被清空
  const totalChars = historyMsgs.reduce((s, h) => s + (h.content || '').length, 0)
  if (historyMsgs.length > HISTORY.MAX_MSGS || totalChars > HISTORY.CHAR_BUDGET) {
    const compact = await _compactHistory(familyId, openid)
    if (compact) {
      historyMsgs = []
      family = await getFamily(db, familyId, openid)
      version = family && family.updated_at ? String(new Date(family.updated_at).getTime()) : version
    } else {
      console.warn('[conversationAI] 压缩失败，本轮保留历史注入（可能超预算）')
    }
  }
  if (cleanedUserText) {
    // 基础摘要 + 状态块合并构建（P2-10：单次渲染双写缓存，原双份全量渲染）
    await _ensureContexts(familyId, openid, version)
  }
  const { orchestrate } = require('./tool-orchestration')
  const orchResult = await orchestrate({
    familyId, openid, sid,
    userText: cleanedUserText,
    auditText: '',                     // A 通道已删（2026-09-05 P3-L2），恒空保留参数兼容
    history: historyMsgs,
    stateBlock: _stateCache.get('state:' + familyId + ':' + openid) || '',
    dispatch: _dispatch,
    ctxCache: _ctxCache,
    // P1-C1 修复（2026-09-05）：写路径失效须打在 _stateCache（状态块真实缓存）——此前仅传 _ctxCache
    // 导致 orchestrate 的 invalidate('state:…') 落空，写后旧状态块最长存活 60s
    stateCache: _stateCache,
    toolDefs: TOOL_DEFINITIONS,
    toolSummaries: TOOL_SUMMARIES,
    buildToolSystemPrompt
  })
  let cleanText = orchResult.cleanText
  const suggestions = orchResult.suggestions
  const pending_confirms = orchResult.pending_confirms
  const toolResults = orchResult.toolResults

  // P1：写工具成功 → 按 familyId+openid 前缀失效 query 缓存（保一致性，避免 AI 写入后读到旧数据）
  if (toolResults.some(tr => tr.success && WRITE_TOOLS.has(tr.toolName))) {
    _queryCache.invalidateByPrefix(familyId + ':' + openid + ':')
  }

  // 确认卡兜底文案（2026-08-29 线上实测）：AI 只调写工具未产出文本（phase1Text 空）时，
  // cleanText 为空会导致带 pending_confirms 的 assistant 消息不落库 → 点确认报"未找到待确认项"
  if (!cleanText && pending_confirms.length > 0) {
    cleanText = '请确认以下操作'
  }

  // 1. 输出审计（禁止承诺 + PII 脱敏）
  const audit = auditOutput(cleanText)

  // 2. 清理标记（兜底，防旧协议残留）
  cleanText = stripToolCardMarkers(cleanText).trim()

  // 3. 输出内容安全（事后复核；违规内容已短暂展示的残余风险已接受，覆写 + agent_logs 留痕）
  let outputUnsafe = false
  if (cleanText) {
    const { checkContentSafe } = require('./_shared/ai-gateway')
    const safe = await checkContentSafe(cloud, cleanText)
    if (!safe.pass) {
      cleanText = '回复内容安全审核未通过，已移除'
      outputUnsafe = true
    }
  }

  // 4. 持久化消息（user + assistant 统一落库；确认卡随 assistant 消息挂载）
  let userWritten = false
  if (cleanedUserText) {
    userWritten = await _writeMessage(familyId, openid, 'user', cleanedUserText, { sessionId: sid })
  }
  // P2-A 修复：orchestrate 吞错返回空 cleanText 时不落库空 assistant 消息（防污染 history/空气泡）
  // 2026-08-29 补充：带确认卡/建议的 assistant 消息必须落库——否则确认时 getLatestAssistantMsg
  // 取不到卡片消息 → 点确认报"未找到待确认项"（AI 只调工具无文本时 cleanText 可能为空）
  // C3（2026-08-30 审计）：undo 展示信息落库（仅 opId/summary/ttl，不含 before 快照防泄漏），
  // 前端刷新历史后经 history-store 恢复撤销按钮；过期由后端 expires_at 兜底
  const undoOps = toolResults
    .filter(tr => tr.undo && tr.undo.opId)
    .map(tr => ({ opId: tr.undo.opId, summary: tr.undo.summary || '操作已执行', ttlSec: tr.undo.ttlSec || 300 }))
  let assistantWritten = false
  if (cleanText || pending_confirms.length > 0 || suggestions.length > 0) {
    assistantWritten = await _writeMessage(familyId, openid, 'assistant', cleanText || '请确认以下操作', {
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      pending_confirms: pending_confirms.length > 0 ? pending_confirms : undefined,
      undoOps: undoOps.length > 0 ? undoOps : undefined,
      sessionId: sid
    })
  }

  // 5. 写 agent_logs
  await logAI(db, {
    openid, familyId, sessionId: sid,
    action: 'conversation_chat',
    model: _AI_CONFIG.CHAT_MODEL,
    status: outputUnsafe ? 'blocked' : 'success',
    error: outputUnsafe ? { code: 'OUTPUT_UNSAFE', message: '回复内容安全审核未通过', step: 'content_safety' } : undefined,
    userText: (cleanedUserText || '').substring(0, 200),
    replyText: cleanText.substring(0, 800),
    // P3-L2（2026-09-05）：token 计量由 ai-gateway 内部日志承担（bumpAgentTokens + agent_logs），此处不再回传 usage
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
      toolResults: toolResults.map(tr => ({ tool: tr.toolName, success: tr.success, error: tr.error || null, result: tr.result, undo: tr.undo || undefined })),
      auditBlocked: !audit.pass,
      userWritten,
      assistantWritten
    }
  }
}

// ======================== CONFIRM/KEEP 处理（策略表驱动）========================
const { handleConfirm: _handleConfirmImpl, handleKeep: _handleKeepImpl } = require('./confirm-handler')

async function _handleConfirm(familyId, openid, pendingId, sid, userText) {
  const lastMsg = await getLatestAssistantMsg(db, familyId, openid)
  return _handleConfirmImpl({
    familyId, openid, pendingId, sid, userText,
    lastMsg, ctxCache: _ctxCache, stateCache: _stateCache,
    dispatch: (action, payload, _openid) => _dispatch(action, payload, _openid),
    writeMessage: _writeMessage,
    db, promptVersion: PROMPT_VERSION
  })
}

async function _handleKeep(familyId, openid, pendingId, sid, userText) {
  const lastMsg = await getLatestAssistantMsg(db, familyId, openid)
  return _handleKeepImpl({
    familyId, openid, pendingId, sid, userText,
    lastMsg,
    writeMessage: _writeMessage,
    db, promptVersion: PROMPT_VERSION
  })
}

// 默认执行+撤销（② 2026-08-30）：UNDO 拦截指令处理
async function _handleUndo(familyId, openid, opId, sid) {
  const { handleUndo } = require('./undo-handler')
  return handleUndo({ familyId, openid, opId, sid, db, writeMessage: _writeMessage, ctxCache: _ctxCache, stateCache: _stateCache })
}

// ======================== 主入口 ========================
exports.main = async (event, context) => {
  const { familyId, mode } = event
  _traceId = event._reqId || ''
  const wxContext = cloud.getWXContext()
  const openid = wxContext?.OPENID || wxContext?.openId
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!openid) return { code: 401, msg: '未登录' }
  try {
    switch (mode) {
      case 'chat':
        return await _handleChat(event, openid)
      default:
        return { code: 400, msg: '不支持的 mode：' + mode }
    }
  } catch (e) {
    return wrapError('处理', e)
  }
}
