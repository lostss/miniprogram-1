/**
 * tool-orchestration.js — 工具编排内核（深模块）
 *
 * 单通道 v10（2026-08-29 改造）：放弃流式/双通道，一次 function calling 一步到位。
 * 解决 A 通道 {TOOL_INTENT} 标识 malformed 整类缺陷 + v9.0 断言误导（5 轮修复）根因。
 *
 * 接口契约：
 *   orchestrate({
 *     familyId, openid, sid, userText, auditText, history,  // 输入（无 intent/aText 协议）
 *     dispatch, ctxCache, toolDefs,                  // 依赖注入（路由 + 缓存 + schema）
 *     toolSummaries, buildToolSystemPrompt           // 依赖注入（摘要表 + prompt 构建器）
 *   }) → { cleanText, suggestions, pending_confirms, toolResults }
 *
 *   - history: 最近对话历史（[{role, content}]），function calling 决策上下文
 *   - dispatch(tool, params, openid) → result         （由调用方注入，便于测试）
 *   - ctxCache.get(familyId + ':' + openid) / invalidate（R3v2 #3 多租户隔离）
 *   - toolDefs: TOOL_DEFINITIONS（工具 schema 单一事实源）
 *   - toolSummaries: { [toolName]: (tr) => string|null }  仅 summary 函数
 *   - buildToolSystemPrompt: prompts.js 导出（单通道主 prompt）
 *
 * 工具分类（确认策略，2026-08-29 用户决策；2026-09-22 审计后已收敛为两份清单）：
 *   - CONFIRM_TOOLS_KEEP（addPolicy / updatePolicy / createFamily）→ 不 dispatch，
 *     构造 write_confirm 确认卡，前端确认后二次执行
 *   - DEFAULT_EXEC_UNDO_TOOLS（upsertMember / updateFinances / addFact）→ 默认执行 + 撤销记录
 *   - delete* → dispatch 时 409 待确认（现状保留）
 *   - query* / triggerAnalysis → 直接执行
 *
 * 设计要点：
 *   - 模块内部 lazy require ai-client/ai-gateway/policyFactSplitter，避免启动期炸裂
 *   - suggestion 生成委托 suggestion-builder（buildSuggestions / buildWriteConfirms，纯函数）
 *   - 429 退避重试封装在内部，调用方不感知
 */
const cloud = require('wx-server-sdk')
const { buildSuggestions, buildWriteConfirms } = require('./suggestion-builder')
const { withRetry } = require('./_shared/retry')
// purpose 枚举（观测/成本归因单一事实源）。
// 注意：必须用 ai-purposes（无依赖）而非 config——config 在模块顶层执行 cloud.init()，
// 本文件承诺"懒加载以避免启动期炸裂"，顶层 require config 会在加载期就要求 SDK 可用。
const { AI_PURPOSE } = require('./_shared/ai-purposes')

// 工具分流（2026-09-22 全面审计 · 死代码清理）：
// 原此处有一个 `CONFIRM_TOOLS = ['upsertMember','updateFinances','addPolicy','updatePolicy','createFamily']`
// 常量并在文件尾导出，但它与真正的分流清单**矛盾**（把已改免确认的 upsertMember/updateFinances
// 仍列为"需确认"），且全仓零引用（生产/测试/文档均无 import）——文件头 L22-23 也复述了这个过期分类。
// 真实分流只有下面两处（A 类默认执行+可撤销 / B 类保留确认卡），定义已提到模块级以便导出与单测复用。
const DEFAULT_EXEC_UNDO_TOOLS = ['updateFinances', 'upsertMember', 'addFact']
const CONFIRM_TOOLS_KEEP = ['addPolicy', 'updatePolicy', 'createFamily']

// token 成本审计 P2：按用户意图裁剪工具 schema（全量 14 个注入是每消息固定 9-12K tokens 开销）
// 高频查询工具常驻；写/管理工具按意图关键词追加；无意图命中或用户主动要求"全部"时回退全量（保能力优先）
const BASE_TOOLS = ['queryPolicies', 'queryMembers', 'queryFacts', 'queryMemberProfile']
const INTENT_TOOLS = [
  { kw: ['成员', '家人', '孩子', '配偶', '老人', '父母', '加人', '添加', '老婆', '老公', '媳妇', '丈夫', '妻子', '妈', '爸', '爹', '娘', '儿子', '女儿', '娃', '儿媳', '女婿', '岳父', '岳母', '婆婆', '公公', '爷爷', '奶奶', '外公', '外婆', '孙子', '孙女', '外孙', '外孙女', '兄弟', '姐妹', '哥哥', '弟弟', '姐姐', '妹妹'], tools: ['upsertMember', 'deleteMember'] },
  { kw: ['收入', '支出', '负债', '总负债', '财务', '年薪', '月薪', '预算'], tools: ['updateFinances'] },
  { kw: ['保单', '保险', '保额', '投保', '续保', '合同', '重疾险', '医疗险', '寿险', '意外险'], tools: ['addPolicy', 'updatePolicy', 'deletePolicy'] },
  { kw: ['事实', '记一下', '记录', '注意', '患有', '过敏', '职业', '血压', '手术', '烟酒'], tools: ['addFact', 'deleteFact'] },
  { kw: ['分析', '报告', '生成', '检视', '评估'], tools: ['triggerAnalysis'] },
  { kw: ['新建', '创建', '新客户', '添加家庭'], tools: ['createFamily'] }
]
function filterToolDefs(defs, userText) {
  if (!defs || !Array.isArray(defs) || !userText) return defs
  const t = String(userText)
  if (t.includes('全部') || t.includes('所有') || t.includes('帮助')) return defs
  const nameOf = (d) => (d.function ? d.function.name : d.name)
  const base = defs.filter(d => BASE_TOOLS.indexOf(nameOf(d)) !== -1)
  const extra = new Set()
  for (const it of INTENT_TOOLS) {
    if (it.kw.some(k => t.includes(k))) it.tools.forEach(n => extra.add(n))
  }
  if (extra.size === 0) return defs // 无法判断意图，回退全量保证工具能力不降级
  const rest = defs.filter(d => BASE_TOOLS.indexOf(nameOf(d)) === -1 && extra.has(nameOf(d)))
  return base.concat(rest)
}

// P2-D 修复（2026-08-29 线上实测）：hy3 对"修改家庭收入"未调 updateFinances，却回复
// "已为您安排更新…(系统将展示确认卡,您确认后正式写入)" → toolResults=[] 且无确认卡，
// 代理人误以为已修改实际未写入。检测"写声称 + 无工具调用"→ 强指令重试一次兜底。
const WRITE_CLAIM_RE = /(已(为您|经)?(安排|更新|修改|调整|保存|完成)|确认卡|正式写入)/
function _isWriteClaim(text, userText) {
  if (!text || !userText) return false
  if (!WRITE_CLAIM_RE.test(text)) return false
  // 用户输入需含写意图，防止纯问答（如复述确认卡机制）误触发重试
  return /(修改|更新|调整|改成|改为|变更|设置|新增|补录|录入|收入|支出|负债|总负债|财务|年薪|月薪|成员|家人|保单|保险|投保|保额|新建|创建)/.test(userText)
}

/**
 * 直连通道记账（agent_logs + 用户月度配额）——2026-09-12 补齐。
 *
 * 为什么不让直连走 ai-gateway：gateway 的 _secureInput 会对**每条 message**（含塞满工具协议
 * 与客户档案的 system prompt）做 sanitize，而 sanitize 按 SECURITY.MAX_INPUT 截断
 * （见 pii-rules.js `if (s.length > limit) s = s.substring(0, limit)`）→ 会截断 prompt、
 * 直接损坏工具决策。因此直连保持裸调用，成本与配额在此显式补记，口径与 gateway 一致
 * （2026-09-15 候选 3 起由 `_shared/ai-accounting.recordAIUsage` 统一提供，不再是人工对齐）。
 */
async function _recordDirectUsage({ openid, familyId, sessionId, usage, status, error }) {
  if (!openid) return
  try {
    const db = cloud.database()
    // 架构审查候选 3：口径统一收敛到 _shared/ai-accounting（算价 → 按状态计配额 → 写 agent_logs）。
    // 此前这里手写「calcTokenUsage + bumpAgentTokens + logAI」三联，与 ai-gateway 的实现各写一遍，
    // 靠人工对齐口径——正是 2026-09-12 之前"直连既不写 agent_logs 也不计配额"漏账口的成因土壤。
    const { recordAIUsage } = require('./_shared/ai-accounting')
    const { AI } = require('./_shared/config')
    await recordAIUsage(db, {
      openid,
      familyId,
      sessionId: sessionId || '',
      action: 'conversation_tools',
      model: AI.DIRECT_MODEL,
      usage,
      status,
      error
    })
  } catch (e) {
    console.warn('[tool-orchestration] 直连记账失败（不阻断对话）:', (e && e.message) || e)
  }
}

// 强指令重试：hy3/hunyuan-exp 工具遵从差（2026-08-29 两轮实测"修改家庭收入"均不输出
// tool_calls，连强指令重试也拒调），重试优先切 DeepSeek 直连 function calling
// （OpenAI 兼容、遵从度高）；无 DEEPSEEK_API_KEY 或直连失败时 fallback 回 hy3 强指令重试。
async function _retryForceToolCall({ toolMessages, filteredDefs, userText, ctx, familyId, openid, sid }) {
  const forceMsg = '\n\n【系统强制提示】你上一条回复声称已为用户安排修改，但没有调用任何工具，这是错误的。' +
    '修改档案必须调用对应工具，否则系统不会展示确认卡、也不会写入任何数据。' +
    '若用户要求修改数据，必须调用对应的写工具（updateFinances/upsertMember/addPolicy/updatePolicy/createFamily），并输出 tool_calls，不得只输出文字。'
  const retryMsgs = (toolMessages || []).map(m =>
    m.role === 'system' ? { ...m, content: m.content + forceMsg } : m
  )

  // 通道 1：DeepSeek 直连 function calling
  try {
    const { callChatWithToolsDirect } = require('./_shared/ai-client')
    // openid 透传观测归因（裸直连不经 ai-gateway，须显式传）
    const directPhase = await callChatWithToolsDirect(retryMsgs, filteredDefs, { maxTokens: 1200, openid, purpose: AI_PURPOSE.CONVERSATION_RETRY_DIRECT })
    console.log('[tool-orchestration] 强指令重试(DeepSeek 直连): toolCalls=%d text=%s',
      (directPhase.toolCalls || []).length, String(directPhase.text || '').slice(0, 300))
    if (directPhase.toolCalls && directPhase.toolCalls.length > 0) {
      await _recordDirectUsage({ openid, familyId, sessionId: sid, usage: directPhase.usage })
      return directPhase
    }
    console.warn('[tool-orchestration] 强指令重试(DeepSeek 直连) 仍无 tool_calls，回退 hy3 强指令重试')
  } catch (e) {
    console.warn('[tool-orchestration] 强指令重试(DeepSeek 直连) 失败，回退 hy3 强指令重试:', (e && e.message) || e)
  }

  // 通道 2：hy3 强指令重试（直连不可用/失败时）
  try {
    const { callChatWithTools } = require('./_shared/ai-client')
    const { safeCallChatWithTools } = require('./_shared/ai-gateway')
    return await withRetry(
      () => safeCallChatWithTools(
        retryMsgs, filteredDefs, callChatWithTools,
        { cloud, db: cloud.database(), openid, familyId, sessionId: sid, model: 'hy3', action: 'conversation_tools_retry', skipRateLimit: true },
        { maxTokens: 1200, purpose: AI_PURPOSE.CONVERSATION_RETRY_HY3 }
      ),
      { maxAttempts: 2, backoff: 'exponential', delayMs: 2000, retryOn: (e) => (e.message || '').includes('429'), label: 'tool-orchestration 强制工具调用重试(hy3)' }
    )
  } catch (e) {
    console.warn('[tool-orchestration] 强指令重试失败:', (e && e.message) || e)
    return null
  }
}

// 主通道 ①（2026-08-30 极简重构）：DeepSeek 直连 function calling 优先（OpenAI 兼容、遵从高、
// 429 罕见、DEEPSEEK_API_KEY 已配置），hy3/SDK 作 fallback。两通道共用同一 toolMessages/filteredDefs，
// 返回结构均为 { text, toolCalls, usage }（toolCalls 为 {id,type,function:{name,arguments}} 规范化格式）。
async function _callPhase1(toolMessages, filteredDefs, ctx, sid) {
  const { callChatWithToolsDirect } = require('./_shared/ai-client')

  // 通道 1：DeepSeek 直连（仅 429 退避重试；缺 key/网络/格式错误直接回退 hy3，不空耗重试）
  //
  // 2026-09-20（流程审计 P1-B4 (b)/(c) 收口 · **决定不做**）：
  //   (b) 给 phase1 传更紧的 timeoutMs（现吃 ai-client 默认 30000）
  //   (c) 前端超时与函数时限同为 60s（"前端先放弃 → 用户重试 → 双计费"，前端见
  //       miniprogram/components/chat-panel/index.js 的 `{ timeout: 60000 }`）
  // **不做的依据**：(b) 定阈值需要 agent_logs 里 conversation_phase1 的**耗时分布**，而云函数日志
  //   CLI 不可读（本项目多处记载），当前拿不到数据；无数据收紧会把偶发慢请求变成确定性失败。
  //   已知直连实测 11-15s，30s 对它是余量而非浪费。
  // **复核修正审计的一处数字**：审计算的"最坏 30+1.5+30=61.5s"不成立——下方 retryOn 只匹配 429
  //   （服务端**立刻**返回），超时**不**重试，故单通道最坏 ≈31.5s。真正的超预算路径是
  //   **通道回退链**：直连 30s 超时 → 回落 hy3 再最坏 30s → 60s+。
  // ⚠️ 将来若要收口，切入点不是"把 30s 改小"，而是给 phase1 一个**跨通道总预算**，
  //    否则只是把超时点从一个通道挪到另一个。改之前先取耗时分布。
  // 2026-09-28 复审（dsh 审计项②）：直连通道此前**只记账不校验**月度配额 ——
  // `_recordDirectUsage` 是事后累加，于是配额对 phase1 这条**最高频**路径实际不封顶
  // （trial 的 30000 token 用满后照常对话，只有落到通道 2 的请求才会被拦）。
  // 现改为入口预检：配额耗尽即**跳过直连**，直接走通道 2 —— ai-gateway 的 _pipelineGuard
  // 必定查配额（该处无 skip 开关），会拦下并给出可操作原因（dsh 本轮新增的 blocked 通道）。
  // 效果等价于让网关拦，但省掉一次注定超额的模型调用（约 11-15s + 计费）。
  const _quota = await _directQuotaAllowed(ctx)
  if (!_quota.allowed) {
    console.warn('[tool-orchestration] 月度配额已耗尽 → 跳过 phase1 直连，交由通道 2 拦下:', _quota.reason)
    return _callPhase2Hy3(toolMessages, filteredDefs, ctx, sid)
  }

  try {
    const direct = await withRetry(
      // 2026-09-12 观测修复：补 openid（实测该路 operation_logs 记录 openid 为空 → 归因/配额全部漏掉
      // 这条最高频调用）+ purpose（原不传导致 purpose 只能反映客户端函数名，无法按业务场景聚合）
      () => callChatWithToolsDirect(toolMessages, filteredDefs, { maxTokens: 1200, openid: ctx.openid, purpose: AI_PURPOSE.CONVERSATION_PHASE1 }),
      {
        maxAttempts: 2,
        backoff: 'exponential',
        delayMs: 1500,
        retryOn: (e) => (e && (e.code === '429' || String(e.message || '').includes('429'))),
        label: 'phase1 direct 429 退避'
      }
    )
    if (direct && Array.isArray(direct.toolCalls)) {
      console.log('[tool-orchestration] phase1(DeepSeek 直连): toolCalls=%d text=%s',
        direct.toolCalls.length, String(direct.text || '').slice(0, 200))
      // 2026-09-12 记账补齐：直连不经 ai-gateway（gateway 的 sanitize 会截断 prompt），
      // 原先既不写 agent_logs 也不计用户配额——对话是最高频调用，这是最大的漏账口。
      await _recordDirectUsage({ openid: ctx.openid, familyId: ctx.familyId, sessionId: sid, usage: direct.usage })
      return direct
    }
    console.warn('[tool-orchestration] phase1 直连返回异常，回退 hy3')
  } catch (e) {
    console.warn('[tool-orchestration] phase1 直连失败，回退 hy3:', (e && e.message) || e)
    // 失败也留痕（带已收到的 usage，如 ai_empty/ai_format 的已消耗输入）
    await _recordDirectUsage({
      openid: ctx.openid, familyId: ctx.familyId, sessionId: sid, usage: e && e.usage, status: 'fail',
      error: { code: (e && e.code) || 'AI_CALL_FAIL', message: (e && e.message) || '' }
    })
  }

  // 通道 2：hy3（SDK）
  return _callPhase2Hy3(toolMessages, filteredDefs, ctx, sid)
}

/**
 * 通道 2：hy3（经 ai-gateway，配额/限流/内容安全全链生效）；skipRateLimit 保留
 * （工具调用 60/60s 用户级限流会误伤多工具并发，配额检查不受该开关影响）
 *
 * 2026-09-28 复审：从 `_callPhase1` 尾部提出为独立函数 —— 配额耗尽时需由 `_callPhase1`
 * **提前**转入本通道（原先只能顺序走到这里，直连已先吃掉一次超额调用）。
 */
async function _callPhase2Hy3(toolMessages, filteredDefs, ctx, sid) {
  const { callChatWithTools } = require('./_shared/ai-client')
  const { safeCallChatWithTools } = require('./_shared/ai-gateway')
  return withRetry(
    () => safeCallChatWithTools(
      toolMessages, filteredDefs, callChatWithTools,
      { cloud, db: cloud.database(), openid: ctx.openid, familyId: ctx.familyId, sessionId: sid, model: 'hy3', action: 'conversation_tools', skipRateLimit: true },
      { maxTokens: 1200, purpose: AI_PURPOSE.CONVERSATION_PHASE1_HY3 }
    ),
    {
      maxAttempts: 3,
      backoff: 'exponential',
      delayMs: 2000,
      retryOn: (e) => (e.message || '').includes('429'),
      label: 'tool-orchestration 429 退避'
    }
  )
}

/**
 * 直连通道的**入口**月度配额预检（2026-09-28 复审，dsh 审计项②）。
 * 预检自身失败一律放行（与 guard.checkMonthlyQuota 的口径一致：配额系统不可用不阻断业务）。
 */
async function _directQuotaAllowed(ctx) {
  try {
    const { checkMonthlyQuota } = require('./_shared/guard')
    const r = await checkMonthlyQuota(cloud.database(), ctx && ctx.openid)
    return { allowed: !(r && r.allowed === false), reason: (r && r.reason) || '' }
  } catch (e) {
    console.warn('[tool-orchestration] 直连配额预检失败（放行）:', (e && e.message) || e)
    return { allowed: true, reason: '' }
  }
}

// 工具结果回流：把执行结果（成功=模板句，失败=错误详情）回流模型再生成最终回复
const REFLOW_QUERY_TOOLS = ['queryPolicies', 'queryMembers', 'queryFacts', 'queryMemberProfile']
function _reflowToolContent(tr, toolSummaries) {
  if (!tr.success) return JSON.stringify({ error: tr.error || '执行失败' })
  if (REFLOW_QUERY_TOOLS.indexOf(tr.toolName) !== -1) {
    const d = (tr.result && tr.result.data) || {}
    const brief = { query: tr.toolName, count: 0, items: [] }
    if (d.policies && Array.isArray(d.policies)) {
      brief.count = d.policies.length
      brief.items = d.policies.map(p => ({
        product: p.product_name || '', category: p.insurance_category || '',
        insured: p.insured_name || '', sum: p.sum_assured || 0, premium: p.annual_premium || 0,
        effective: p.effective_date || '', status: p.status || ''
      }))
    } else if (d.members && Array.isArray(d.members)) {
      brief.count = d.members.length
      brief.items = d.members.map(m => ({ name: m.name || '', role: m.role || '', age: m.age || '', income: m.income || 0 }))
    } else if (d.facts && Array.isArray(d.facts)) {
      brief.count = d.facts.length
      brief.items = d.facts.slice(0, 20).map(f => ({ subject: f.subject_name || '', predicate: f.predicate || '', value: f.object_value || '' }))
    } else {
      brief.items = JSON.parse(JSON.stringify(d))
    }
    return '查询结果: ' + JSON.stringify(brief).substring(0, 2000)
  }
  return toolSummaries[tr.toolName] ? toolSummaries[tr.toolName](tr) : '执行成功'
}

// ③④ 结果回流统一（2026-08-30 极简重构）：成功/失败回流共用同一消息序列
// system → hist → user → assistant(tool_calls) → tool → safeCallChat；返回文本或空串（回退由调用方决定）
async function _refineReply({ ctx, familyId, openid, sid, userText, histMsgs, toolCallMsgs, toolResultMsgs, systemHint, stateBlock, buildToolSystemPrompt }) {
  try {
    const { callChat } = require('./_shared/ai-client')
    const { safeCallChat } = require('./_shared/ai-gateway')
    const sb = stateBlock || ''
    const refineMsgs = [
      { role: 'system', content: buildToolSystemPrompt() + (systemHint || '') + '\n\n当前客户信息（基础档案，可能滞后于最近对话）：\n' + ctx },
      ...(histMsgs || []),
      { role: 'user', content: sb ? sb + '\n\n' + userText : userText },
      ...toolCallMsgs,
      ...toolResultMsgs
    ]
    const phase2 = await safeCallChat(
      refineMsgs, callChat,
      { cloud, db: cloud.database(), openid, familyId, sessionId: sid, model: 'hy3', action: 'conversation_tool_refine', skipRateLimit: true },
      { maxTokens: 800 }
    )
    if (phase2.text && phase2.text.trim()) return phase2.text.trim()
  } catch (e) {
    console.warn('[tool-orchestration] 结果回流失败:', (e && e.message) || e)
  }
  return ''
}

// 成功回流：工具全部成功 → 组织最终回复（失败回流用 _refineReply 的同构序列）
async function _reflowWithResults({ toolResults, userText, phase1Text, cleanText, ctxCache, familyId, openid, sid, history, stateBlock, toolSummaries, buildToolSystemPrompt }) {
  const cv = ctxCache.get(familyId + ':' + openid)
  const ctx = (cv && typeof cv === 'object' && cv.markdown) ? cv.markdown : (cv || '')
  const sb = stateBlock || ctxCache.get('state:' + familyId + ':' + openid) || ''
  const toolResultMsgs = toolResults.map(tr => ({
    role: 'tool',
    tool_call_id: tr.toolCallId,
    content: _reflowToolContent(tr, toolSummaries)
  }))
  // 2026-09-10 P2-2：与 phase-1 决策上下文（下方 slice(-6)）对齐——原为 -4，导致工具执行后生成最终答复时
  // 看到的历史比决策时更少，用户 5-6 条前给出的约束可能在落笔时丢失
  const histMsgs = (history || []).slice(-6).map(h => ({
    role: h.role === 'assistant' ? 'assistant' : 'user',
    content: (h.content || '').substring(0, 500)
  }))
  // 审计 P2-A（2026-08-29）：assistant tool_calls 前置（tool 消息须跟在含 tool_calls 的 assistant 之后）
  const toolCallMsgs = [{
    role: 'assistant',
    content: phase1Text || null,
    tool_calls: toolResults.map(tr => ({
      id: tr.toolCallId,
      type: 'function',
      function: { name: tr.toolName, arguments: JSON.stringify(tr.args || {}) }
    }))
  }]
  const systemHint = '\n\n工具已执行完成，请基于工具执行结果组织回复并确认已执行的操作；若用户输入不完整，以工具实际执行结果为准，不要声称"未执行"。'
  const text = await _refineReply({ ctx, familyId, openid, sid, userText, histMsgs, toolCallMsgs, toolResultMsgs, systemHint, stateBlock: sb, buildToolSystemPrompt })
  // 单通道：优先回流文本，再退 AI 第一版文本，最后退 auditText（通常为空）
  return text || phase1Text || cleanText || ''
}

// 工具结果 → 归一化 toolResult 记录（L3 校验 + dispatch + 成功判定）
async function _dispatchDirectTools({ directTools, toolDefs, dispatch, familyId, openid }) {
  const { validateArgs } = require('./schema-validate')
  return Promise.all((directTools || []).map(async p => {
    const { toolName, args, toolCallId } = p
    const val = validateArgs(toolName, args, toolDefs)
    if (!val.ok) {
      return { toolName, toolCallId, success: false, error: '参数校验失败：' + val.errors.join('；'), validation: true, args }
    }
    // S3-8 修复：familyId 放在 ...args 之后，防止 AI 被提示注入在工具参数塞 familyId 覆盖显式值
    return dispatch(toolName, { ...args, familyId }, openid)
      // T-M3 修复：needsConfirm（code 409）是"待确认"而非失败，不应记 success:false
      .then(r => ({ toolName, toolCallId, success: !(r && (r.success === false || ((r.code && r.code !== 200) && !r.needsConfirm))), result: r, args }))
      .catch(e => ({ toolName, toolCallId, success: false, error: e.message, args }))
  }))
}

// ② 默认执行+撤销（2026-08-30 极简重构）：A 类写工具（updateFinances/upsertMember/addFact）
// 执行前取 before 快照 → dispatch → 成功后落 undo_logs（op_id, pending 5min）并携带 undo 摘要给前端。
async function _dispatchUndoTools({ tools, toolDefs, dispatch, familyId, openid, toolSummaries }) {
  const { validateArgs } = require('./schema-validate')
  const { createUndo, UNDO_TTL_MS } = require('./undo-store')
  const { snapshotFinance, snapshotMember } = require('./_shared/memberRepo')
  const db = cloud.database()
  return Promise.all((tools || []).map(async p => {
    const { toolName, args, toolCallId } = p
    const val = validateArgs(toolName, args, toolDefs)
    if (!val.ok) {
      return { toolName, toolCallId, success: false, error: '参数校验失败：' + val.errors.join('；'), validation: true, args }
    }
    // 2026-09-17 审计 P1-B2：快照失败必须显式记账 —— `before=null` 在恢复侧被解释为"撤销新建"
    // （restoreFinance/restoreMember 的 null 分支会 silentRemoveDoc 当前文档），于是"没拿到快照"
    // 与"这条是新建的"两种语义撞车 → 撤销会把**存量**财务/成员文档整删（数据丢失级）。
    const needSnapshot = toolName === 'updateFinances' || toolName === 'upsertMember'
    let before = null
    let snapshotFailed = false
    try {
      if (toolName === 'updateFinances') before = await snapshotFinance(db, familyId, openid)
      else if (toolName === 'upsertMember') before = await snapshotMember(db, familyId, openid, args)
    } catch (e) {
      snapshotFailed = true
      console.warn('[tool-orchestration] 快照失败（本次不落 undo，避免撤销删存量）:', (e && e.message) || e)
    }
    const result = await dispatch(toolName, { ...args, familyId }, openid)
      .then(r => r)
      .catch(e => ({ success: false, error: e.message }))
    const success = !(result && (result.success === false || ((result.code && result.code !== 200) && !result.needsConfirm)))
    if (!success) {
      const errMsg = (result && result.error) || (result && result.msg) || '执行失败'
      return { toolName, toolCallId, success, result, args, error: errMsg }
    }
    if (success) {
      // after：撤销定位用（新建成员的 member_id / 新建事实的 factId）
      let after = null
      if (toolName === 'upsertMember' && result.data && result.data.memberId) after = { member_id: result.data.memberId, action: result.data.action }
      else if (toolName === 'addFact' && result.data && result.data.factId) after = { factId: result.data.factId }
      // 可撤销性是写入的**前置条件**，不是事后补齐：快照缺失时宁可撤销按钮不出现，
      // 也不能落一条 before=null 的 undo 记录（撤销时会被当作"新建"而删掉存量文档）。
      const opId = (needSnapshot && snapshotFailed)
        ? null
        : await createUndo(db, { familyId, openid, toolName, args, before, after })
      if (opId) {
        const summary = toolSummaries && toolSummaries[toolName]
          ? toolSummaries[toolName]({ toolName, success: true, result, args })
          : '已执行'
        return { toolName, toolCallId, success: true, result, args, undo: { opId, summary, ttlSec: Math.floor(UNDO_TTL_MS / 1000) } }
      }
    }
    return { toolName, toolCallId, success, result, args }
  }))
}

/**
 * 单通道编排主流程
 * @returns {Promise<{cleanText: string, suggestions: array, pending_confirms: array, toolResults: array}>}
 */
async function orchestrate({
  familyId, openid, sid, userText, auditText, history, stateBlock,
  dispatch, ctxCache, stateCache, toolDefs,
  toolSummaries, buildToolSystemPrompt
}) {
  let cleanText = auditText || ''
  let toolResults = []
  let suggestions = []
  let pending_confirms = []

  if (!userText) {
    return { cleanText, suggestions, pending_confirms, toolResults }
  }

  try {
    // 基础摘要（长期记忆）——缓存 value 兼容 { version, markdown } 与旧字符串
    const cv = ctxCache.get(familyId + ':' + openid)
    const ctx = (cv && typeof cv === 'object' && cv.markdown) ? cv.markdown : (cv || '')
    // 状态块（权威最新值）：拼在 user 消息前缀，保证 system+历史 前缀稳定
    const sb = stateBlock || ctxCache.get('state:' + familyId + ':' + openid) || ''

    // 规则预提取保障描述，作为 AI 工具调用的参考
    let coverageHint = ''
    try {
      const { policyFactSplitter } = require('./policyFactSplitter')
      const split = policyFactSplitter(userText, { confidence: 0.9 })
      if (split.length) {
        coverageHint = '\n\n【规则预提取的保障（仅供参考，请用 addFact 确认后写入，勿直接照抄）】\n' +
          split.map(s => `- ${s.predicate}：${s.objectValue}`).join('\n')
      }
    } catch (e) { console.warn('[tool-orchestration] policyFactSplitter 失败:', e.message) }

    // 意图裁剪工具 schema（token 成本审计 P2）
    let filteredDefs = filterToolDefs(toolDefs, userText)
    // coverageHint 指示"用 addFact 写入"时，保证 addFact 在可用工具列表（防裁剪后模型想调但工具不存在 → 放弃调用/文本幻觉）
    if (coverageHint && !filteredDefs.some(d => (d.function ? d.function.name : d.name) === 'addFact')) {
      const addFactDef = toolDefs.find(d => (d.function ? d.function.name : d.name) === 'addFact')
      if (addFactDef) filteredDefs = filteredDefs.concat(addFactDef)
    }

    // 注入最近对话历史（≤6 条，截断 500 字）+ 用户原输入
    const histMsgs = (history || []).slice(-6).map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: (h.content || '').substring(0, 500)
    }))
    const toolMessages = [
      { role: 'system', content: buildToolSystemPrompt() + '\n\n当前客户信息（基础档案，可能滞后于最近对话）：\n' + ctx + coverageHint },
      ...histMsgs,
      { role: 'user', content: sb ? sb + '\n\n' + userText : userText }
    ]

    // 主通道：DeepSeek 直连优先，hy3 fallback（见 _callPhase1）
    let phase1 = await _callPhase1(toolMessages, filteredDefs, { openid, familyId }, sid)

    let phase1Text = (phase1.text || '').trim()

    // ===== 无工具调用：纯问答 =====
    if (!phase1.toolCalls || phase1.toolCalls.length === 0) {
      // P2-D 修复：模型声称"已安排修改/将展示确认卡"却未调用工具 → 强指令重试一次，
      // 防止"假更新"空气卡误导代理人（档案实际未变）。重试仍无工具调用 → 诚实失败提示。
      if (_isWriteClaim(phase1Text, userText)) {
        const retry = await _retryForceToolCall({ toolMessages, filteredDefs, userText, ctx, familyId, openid, sid })
        if (retry && retry.toolCalls && retry.toolCalls.length > 0) {
          phase1 = retry
          phase1Text = (phase1.text || '').trim()
        } else {
          cleanText = '抱歉，系统未能完成该修改操作，档案未发生变化。请重试，或手动在档案页修改。'
          return { cleanText, suggestions, pending_confirms, toolResults }
        }
      } else {
        cleanText = phase1Text
        return { cleanText, suggestions, pending_confirms, toolResults }
      }
    }

    // ===== 有工具调用：解析 + 分类（需确认 vs 直接执行） =====
    const parsed = []
    for (const tc of phase1.toolCalls) {
      if (tc.type === 'function' && tc.function) {
        let args = {}
        try { args = JSON.parse(tc.function.arguments || '{}') } catch (_) {}
        // 2026-09-22 全面审计 P1-3：**剥离模型自带的 confirmed**。
        // 删除类工具的确认门完全依赖这一字段（index.js _dispatch：needsConfirm && !args.confirmed
        // → 409 待确认），它只应由服务端确认路径注入（_handleConfirm → dispatch(..., confirmed:true)）。
        // 原实现把模型输出原样透传 → 模型只要输出 deletePolicy{policyId, confirmed:true} 即可**跳过确认**
        // 直接软删保单 + supersede 保障 facts（且报告缺口结论随之变化、UI 无提示）。
        // 模型可被 system prompt 里的第三方文本（facts / OCR 产物 / 用户粘贴）诱导输出该字段。
        if (args && typeof args === 'object' && 'confirmed' in args) delete args.confirmed
        parsed.push({ toolName: tc.function.name, args, toolCallId: tc.id || tc.function.name })
      }
    }
    // ② 工具分流：A 类默认执行+撤销 / B 类保留确认 / 直接执行（query/delete/triggerAnalysis/writeMessage）
    // （两份清单在模块级定义，见文件头附近的说明）
    const undoableTools = parsed.filter(p => DEFAULT_EXEC_UNDO_TOOLS.indexOf(p.toolName) !== -1)
    const confirmTools = parsed.filter(p => CONFIRM_TOOLS_KEEP.indexOf(p.toolName) !== -1)
    const directTools = parsed.filter(p => DEFAULT_EXEC_UNDO_TOOLS.indexOf(p.toolName) === -1 && CONFIRM_TOOLS_KEEP.indexOf(p.toolName) === -1)

    // 1) B 类确认卡（保单/新建家庭）→ 构造 write_confirm 确认卡（不 dispatch）
    if (confirmTools.length > 0) {
      const wc = buildWriteConfirms(confirmTools)
      suggestions = wc.suggestions
      pending_confirms = wc.pending_confirms
    }

    // 2) A 类默认执行 + 撤销（before 快照 → dispatch → 落 undo_logs）
    if (undoableTools.length > 0) {
      // 2026-09-22 全面审计 P1-3：参数校验必须用**完整** toolDefs，不能用按用户文本裁剪过的
      // filteredDefs —— filterToolDefs 只按关键词挑出本轮「相关」工具，未命中的工具在
      // validateArgs 里 `if (!def) return { ok: true }`（无 def 即放行，schema-validate.js:24）
      // → 模型幻觉/被注入调用本轮未裁剪出的工具时，**完全绕过字段校验**（连未知字段检查都没有）。
      // filteredDefs 仍只用于「给模型看哪些工具」，不作为校验依据。
      toolResults = toolResults.concat(await _dispatchUndoTools({ tools: undoableTools, toolDefs, dispatch, familyId, openid, toolSummaries }))
    }

    // 3) 直接执行工具（query/delete/triggerAnalysis/writeMessage）→ dispatch（校验 + 执行）
    if (directTools.length > 0) {
      // 同上：校验用完整 toolDefs（filteredDefs 仅供模型可见性裁剪）
      toolResults = toolResults.concat(await _dispatchDirectTools({ directTools, toolDefs, dispatch, familyId, openid }))
    }

    // 数据变更后仅失效状态块（2026-08-30 长期记忆）：基础摘要为稳定前缀，保 DeepSeek context caching 命中；
    // 写后最新状态由下一轮状态块重建承载（本轮回流已携带 tool 执行结果）
    // P1-C1 修复：状态块实际存于 _stateCache（index 传入 stateCache），失效须打在它上面；
    // 旧调用（测试/历史路径）只传 ctxCache 时回退 ctxCache，保证兼容
    if (toolResults.some(tr => tr.success)) (stateCache || ctxCache).invalidate('state:' + familyId + ':' + openid)

    // 执行结果处理（待确认项合并 + 回流/文本生成）
    if (toolResults.length > 0) {
      // 执行结果里的待确认项（delete* 409 / 低置信度冲突）合并进确认卡
      const dRes = buildSuggestions(toolResults)
      suggestions = suggestions.concat(dRes.suggestions)
      pending_confirms = pending_confirms.concat(dRes.pending_confirms)

      // 回流处理
      const hasPending = dRes.pending_confirms.length > 0
      const failedResults = toolResults.filter(tr => !tr.success)
      const summaryParts = toolResults
        .filter(tr => tr.success)
        .map(tr => toolSummaries[tr.toolName] ? toolSummaries[tr.toolName](tr) : null)
        .filter(Boolean)
      const summary = summaryParts.length > 0 ? '\n\n' + summaryParts.join('\n') : ''
      const summaryText = (phase1Text + summary).trim()

      // 成功回流排除项：triggerAnalysis（fire-and-forget，无数据可组织）、writeMessage（内部写消息）
      const REFLOW_SKIP = ['triggerAnalysis', 'writeMessage']
      const reflowable = toolResults.filter(tr => tr.success && REFLOW_SKIP.indexOf(tr.toolName) === -1)

      if (hasPending) {
        // 待确认：phase1 文本 + 确认卡
        cleanText = phase1Text
      } else if (failedResults.length > 0) {
        // 失败场景：先用成功项模板兜底，失败回流再生成失败提示覆盖（与成功回流共用 _refineReply 序列）
        cleanText = summaryText
        try {
          const toolCallMsgs = (phase1.toolCalls || []).map(tc => ({
            role: 'assistant',
            content: phase1Text || null,
            tool_calls: [{
              id: tc.id || tc.function.name,
              type: 'function',
              function: { name: tc.function.name, arguments: tc.function.arguments || '{}' }
            }]
          }))
          const toolResultMsgs = toolResults.map(tr => ({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content: tr.success
              ? (toolSummaries[tr.toolName] ? toolSummaries[tr.toolName](tr) : '执行成功')
              : JSON.stringify({ error: tr.error || '执行失败' })
          }))
          const refined = await _refineReply({ ctx, familyId, openid, sid, userText, histMsgs: [], toolCallMsgs, toolResultMsgs, systemHint: '', buildToolSystemPrompt })
          if (refined) cleanText = refined
        } catch (e) {
          console.warn('[tool-orchestration] 失败回流再生成失败，回退模板拼接:', (e && e.message) || e)
        }
      } else if (reflowable.length > 0) {
        // 全部成功 → 工具结果回流 B 生成最终回复
        cleanText = await _reflowWithResults({ toolResults, userText, phase1Text, cleanText, ctxCache, familyId, openid, sid, history, stateBlock: sb, toolSummaries, buildToolSystemPrompt })
      } else {
        // 全部成功但无可回流工具（如仅 triggerAnalysis/query）
        cleanText = phase1Text || summaryText
      }
    } else {
      // 无执行结果（仅 B 类确认卡）：phase1 文本 + 确认卡
      cleanText = phase1Text
    }

    return { cleanText, suggestions, pending_confirms, toolResults }
  } catch (e) {
    console.warn('[tool-orchestration] function calling 失败:', e.message)
    // 审计 P2-14：工具可能已执行（toolResults 有值）但回复生成中断 → 原样返回会渲染"空气泡"，
    // 用户以为没执行；补兜底文案指向已返回的结果
    if (!cleanText && toolResults && toolResults.length) cleanText = '操作已完成，回复生成中断，请查看上方结果。'
  }

  return { cleanText, suggestions, pending_confirms, toolResults }
}

// `_callPhase1` / `_directQuotaAllowed` 导出仅供单测（直连配额预检的行为验证需要真实调用分支，
// 源码文本断言测不出"是否真的跳过了直连"）
module.exports = { orchestrate, filterToolDefs, DEFAULT_EXEC_UNDO_TOOLS, CONFIRM_TOOLS_KEEP, _callPhase1, _directQuotaAllowed }
