/**
 * tool-orchestration.js — 工具编排内核（深模块）
 *
 * 解决问题：postProcess 内联 ~120 行工具编排逻辑（构建消息→429 退避→并发 dispatch
 * →suggestion 生成→summary 拼接），与消息持久化/审计/CONFIRM 拦截纠缠，
 * 难以针对"工具链失败"场景单测。
 *
 * 接口契约：
 *   orchestrate({
 *     familyId, openid, sid, userText, auditText, aText, history, intent,  // 输入
 *     dispatch, ctxCache, toolDefs,                  // 依赖注入（路由 + 缓存 + schema）
 *     toolSummaries, buildToolSystemPrompt           // 依赖注入（摘要表 + prompt 构建器）
 *   }) → { cleanText, suggestions, pending_confirms, toolResults }
 *
 *   - aText: 通道 A 的整理后回复（工具执行成功后原样返回，避免覆盖 A 的断言文本；失败时由 B 提示替换）
 *   - history: 最近对话历史（[{role, content}]），function calling 兜底时用于理解上下文
 *   - intent: 通道 A 已决策的工具意图 [{name, args}]（v9.1：A 决策 → B 只执行，不走 function calling，
 *     消除"B 看到 A 断言文本误以为已写入而不调工具"的根因）；为空时回退 function calling 兜底
 *   - dispatch(tool, params, openid) → result         （由调用方注入，便于测试）
 *   - ctxCache.get(familyId + ':' + openid) / ctxCache.invalidate(familyId + ':' + openid)（R3v2 #3 多租户隔离）
 *   - toolDefs: TOOL_DEFINITIONS（工具 schema 单一事实源）
 *   - toolSummaries: { [toolName]: (tr) => string|null }  仅 summary 函数（架构审计第 13 轮：接口收窄）
 *   - buildToolSystemPrompt: prompts.js 导出（通道 B 工具执行 prompt）
 *
 * 设计要点：
 *   - 模块内部 lazy require ai-client/ai-gateway/policyFactSplitter，避免启动期炸裂
 *   - suggestion 生成委托 suggestion-builder.buildSuggestions（纯函数）
 *   - 429 退避重试封装在内部，调用方不感知
 *   - toolSummaries 经参数注入，避免与 index.js 形成循环依赖
 */
const cloud = require('wx-server-sdk')
const { buildSuggestions } = require('./suggestion-builder')
const { withRetry } = require('./_shared/retry')

// token 成本审计 P2：按用户意图裁剪工具 schema（TOOL_DEFINITIONS 11+ 个全量注入是每消息固定 9-12K tokens 开销）
// 高频查询工具常驻；写/管理工具按意图关键词追加；无意图命中或用户主动要求"全部"时回退全量（保能力优先）
const BASE_TOOLS = ['queryPolicies', 'queryMembers', 'queryFacts', 'queryMemberProfile']
const INTENT_TOOLS = [
  { kw: ['成员', '家人', '孩子', '配偶', '老人', '父母', '加人', '添加', '老婆', '老公', '媳妇', '丈夫', '妻子', '妈', '爸', '爹', '娘', '儿子', '女儿', '娃', '儿媳', '女婿', '岳父', '岳母', '婆婆', '公公', '爷爷', '奶奶', '外公', '外婆', '孙子', '孙女', '外孙', '外孙女', '兄弟', '姐妹', '哥哥', '弟弟', '姐姐', '妹妹'], tools: ['upsertMember', 'deleteMember'] },
  { kw: ['收入', '支出', '负债', '财务', '年薪', '月薪', '预算'], tools: ['updateFinances'] },
  { kw: ['保单', '保险', '保额', '投保', '续保', '合同', '重疾险', '医疗险', '寿险', '意外险'], tools: ['addPolicy', 'updatePolicy', 'deletePolicy'] },
  { kw: ['事实', '记一下', '记录', '注意', '患有', '过敏', '职业', '血压', '手术', '烟酒'], tools: ['addFact', 'deleteFact'] },
  { kw: ['分析', '报告', '生成', '检视', '评估'], tools: ['triggerAnalysis'] },
  { kw: ['新建', '创建', '新客户', '添加家庭'], tools: ['createFamily'] }
]
function filterToolDefs(defs, userText) {
  if (!defs || !Array.isArray(defs) || !userText) return defs
  const t = String(userText)
  if (t.includes('全部') || t.includes('所有') || t.includes('帮助')) return defs
  // 修复：TOOL_DEFINITIONS 结构为 {type, function:{name}}，原 d.name 取不到导致裁剪恒回退全量（意图裁剪从未生效）
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

/**
 * 工具编排主流程
 * @returns {Promise<{cleanText: string, suggestions: array, pending_confirms: array, toolResults: array}>}
 */
// 工具结果回流（v9.3）：把执行结果（成功=模板句，失败=错误详情）回流模型再生成最终回复。
// - 失败场景：生成失败提示（"为什么没写成 + 下一步"），覆盖 A 的断言文本
// - 成功场景：基于真实执行结果组织确认语，消除 A 执行前断言的细节偏差（如部分字段落库差异）
// v9.4：注入最近对话历史（≤4 条）——回流模型需理解"这次为准"类确认语的所指，
// 否则孤立消息导致文本与执行结果矛盾（实测：工具已成功更新，文本却说"无法执行"）。
// 注意：不注入本轮 A 的断言文本（v9.0 根因），历史仅限之前轮次。
// query* 类工具：回流时携带精简结果数据（B 据此组织明细回复；summary 只有计数，模型看不到数据）
const REFLOW_QUERY_TOOLS = ['queryPolicies', 'queryMembers', 'queryFacts', 'queryMemberProfile']
function _reflowToolContent(tr, toolSummaries) {
  if (!tr.success) return JSON.stringify({ error: tr.error || '执行失败' })
  // query* 类：序列化精简数据（截断 2000 字符，去除大字段），让 B 能看到实际查询结果
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
  // 非 query 类：summary 模板句（写类确认语）
  return toolSummaries[tr.toolName] ? toolSummaries[tr.toolName](tr) : '执行成功'
}
async function _reflowWithResults({ toolResults, userText, aText, cleanText, ctxCache, familyId, openid, sid, history, toolSummaries, buildToolSystemPrompt }) {
  const ctx = ctxCache.get(familyId + ':' + openid) || ''
  try {
    const { callChat } = require('./_shared/ai-client')
    const { safeCallChat } = require('./_shared/ai-gateway')
    const toolResultMsgs = toolResults.map(tr => ({
      role: 'tool',
      tool_call_id: tr.toolCallId,
      content: _reflowToolContent(tr, toolSummaries)
    }))
    const histMsgs = (history || []).slice(-4).map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: (h.content || '').substring(0, 500)
    }))
    const refineMsgs = [
      { role: 'system', content: buildToolSystemPrompt() + '\n\n工具已执行完成，请基于工具执行结果组织回复并确认已执行的操作；若用户输入不完整，以工具实际执行结果为准，不要声称"未执行"。\n\n当前客户信息：\n' + ctx },
      ...histMsgs,
      { role: 'user', content: userText },
      ...toolResultMsgs
    ]
    const phase2 = await safeCallChat(
      refineMsgs, callChat,
      { cloud, db: cloud.database(), openid, familyId, sessionId: sid, model: 'hy3', action: 'conversation_tool_refine', skipRateLimit: true },
      { maxTokens: 800 }
    )
    if (phase2.text && phase2.text.trim()) return phase2.text.trim()
  } catch (e) {
    console.warn('[tool-orchestration] 失败回流再生成失败，回退模板:', (e && e.message) || e)
  }
  return cleanText || aText || ''
}

// 工具结果 → 归一化 toolResult 记录（L3 校验 + dispatch + 成功判定；与 function calling 分支共用）
async function _dispatchIntentTools({ intent, toolDefs, dispatch, familyId, openid }) {
  const { validateArgs } = require('./schema-validate')
  const results = await Promise.all((intent || []).map(async it => {
    const toolName = it.name
    const args = (it.args && typeof it.args === 'object') ? it.args : {}
    const val = validateArgs(toolName, args, toolDefs)
    if (!val.ok) {
      return { toolName, toolCallId: toolName, success: false, error: '参数校验失败：' + val.errors.join('；'), validation: true, args }
    }
    // S3-8 修复：familyId 放在 ...args 之后，防止 AI 被提示注入在工具参数塞 familyId 覆盖显式值
    return dispatch(toolName, { ...args, familyId }, openid)
      // T-M3 修复：needsConfirm（code 409）是"待确认"而非失败，不应记 success:false
      .then(r => ({ toolName, toolCallId: toolName, success: !(r && (r.success === false || ((r.code && r.code !== 200) && !r.needsConfirm))), result: r, args }))
      .catch(e => ({ toolName, toolCallId: toolName, success: false, error: e.message, args }))
  }))
  return results
}

async function orchestrate({
  familyId, openid, sid, userText, auditText, aText, history, intent,
  dispatch, ctxCache, toolDefs,
  toolSummaries, buildToolSystemPrompt
}) {
  // 默认值：通道 A 的整理回复优先（工具成功后原样返回）；未传时退化 auditText
  let cleanText = aText || auditText || ''
  let toolResults = []

  if (!userText) {
    return { cleanText, suggestions: [], pending_confirms: [], toolResults }
  }

  try {
    // v9.2：通道 A 只输出意图（工具判定），B function calling 在 schema 约束下填参数。
    // - intent 带 args（旧协议兼容）→ 直接校验执行
    // - intent 只带 name（B 方向）→ 预选工具 schema，B 填参数（intentNames 供主链路限定）
    // 根因对齐：B 决策时注入 A 的"意图已判定"提示但不注入 A 的断言文本（v9.0 被断言误导的根因已消除）
    const intentNames = (intent || []).map(it => it.name).filter(Boolean)
    const intentHasArgs = (intent || []).some(it => it.args && Object.keys(it.args).length > 0)
    if (intent && intent.length > 0 && intentHasArgs) {
      // 旧协议兼容：intent 带 args 直接校验+执行（A 手写参数的过渡形态；新协议只带 name 走 function calling）
      toolResults = await _dispatchIntentTools({ intent, toolDefs, dispatch, familyId, openid })
      if (toolResults.some(tr => tr.success)) ctxCache.invalidate(familyId + ':' + openid)
      const { suggestions, pending_confirms } = buildSuggestions(toolResults)
      const failedResults = toolResults.filter(tr => !tr.success)
      const hasPending = suggestions.length > 0
      if (hasPending) {
        // v9.5 待确认：清空 A 断言（A 断言"已删除"会与实际待确认矛盾），由前端确认卡承载确认交互
        cleanText = ''
      } else if (failedResults.length > 0) {
        cleanText = await _reflowWithResults({ toolResults, userText, aText, cleanText, ctxCache, familyId, openid, sid, history, toolSummaries, buildToolSystemPrompt })
      }
      return { cleanText, suggestions, pending_confirms, toolResults }
    }

    const { callChatWithTools } = require('./_shared/ai-client')
    const { safeCallChatWithTools } = require('./_shared/ai-gateway')

    // tool context 由调用方预构建并缓存于 ctxCache，此处仅取
    // R3v2 #3：key 与 _buildToolContext 一致，带 openid（防跨租户污染）
    const ctx = ctxCache.get(familyId + ':' + openid) || ''

    // Phase 6：规则预提取保障描述，作为 AI 工具调用的参考
    let coverageHint = ''
    try {
      const { policyFactSplitter } = require('./policyFactSplitter')
      const split = policyFactSplitter(userText, { confidence: 0.9 })
      if (split.length) {
        coverageHint = '\n\n【规则预提取的保障（仅供参考，请用 addFact 确认后写入，勿直接照抄）】\n' +
          split.map(s => `- ${s.predicate}：${s.objectValue}`).join('\n')
      }
    } catch (e) { console.warn('[tool-orchestration] policyFactSplitter 失败:', e.message) }

    // token 成本审计 P2：按用户意图裁剪工具 schema（固定 9-12K 的 TOOL_DEFINITIONS 不再每消息全量注入）
    let filteredDefs = filterToolDefs(toolDefs, userText)
    // v9.2（B 方向）：通道 A 已判定工具 → 预选该工具 schema，B function calling 只需填参数
    //（工具选型不漂移；参数由 schema 约束，消除 A 手写字段名不可控问题）
    // 预选基于全量 toolDefs 而非裁剪集——A 判定的工具必须保留（即使关键词裁剪未命中）
    if (intentNames.length > 0) {
      const nameOf = (d) => (d.function ? d.function.name : d.name)
      const intentDefs = toolDefs.filter(d => intentNames.indexOf(nameOf(d)) !== -1)
      if (intentDefs.length > 0) filteredDefs = intentDefs
    }
    // v9 双通道：注入最近对话历史（≤6 条，截断 500 字）+ 用户原输入。
    // 注意：不注入 A 的断言文本（v9.0 根因——B 看到 assistant 断言"已更新"误以为已写入而不调工具）。
    const histMsgs = (history || []).slice(-6).map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: (h.content || '').substring(0, 500)
    }))
    // v9.2：注入 A 的意图判定提示（B 据此填参数，不自己判断是否该调工具）
    const intentHint = intentNames.length > 0
      ? '\n\n【意图已判定】本轮必须调用工具：' + intentNames.join('、') + '。参数从用户消息中提取，按 schema 填写，不要调用其他工具，不要只回复不调用。'
      : ''
    const toolMessages = [
      { role: 'system', content: buildToolSystemPrompt() + '\n\n当前客户信息：\n' + ctx + coverageHint + intentHint },
      ...histMsgs,
      { role: 'user', content: userText }
    ]

    // 429 退避重试（架构审计第 14 轮候选 #3：委托 withRetry，原指数退避 delayMs*attempt 由 backoff='exponential' 实现）
    // token 成本审计 P1：去掉 skipLog 使本调用落 usage 日志（最高频计费点可观测）；skipRateLimit 保留（工具调用 60/60s 用户级限流会误伤多工具并发）
    const phase1 = await withRetry(
      () => safeCallChatWithTools(
        toolMessages, filteredDefs, callChatWithTools,
        { cloud, db: cloud.database(), openid, familyId, sessionId: sid, model: 'hy3', action: 'conversation_tools', skipRateLimit: true },
        { maxTokens: 800 }
      ),
      {
        maxAttempts: 3,
        backoff: 'exponential',
        delayMs: 2000,
        retryOn: (e) => (e.message || '').includes('429'),
        label: 'tool-orchestration 429 退避'
      }
    )

    if (phase1.toolCalls && phase1.toolCalls.length > 0) {
      const dispatchPromises = []
      for (const tc of phase1.toolCalls) {
        if (tc.type === 'function' && tc.function) {
          const toolName = tc.function.name
          let args = {}
          try { args = JSON.parse(tc.function.arguments || '{}') } catch (_) {}
          // L3 参数校验：必填/枚举/数字类型，失败 → 结构化错误 → P2.5 失败回流让 AI 修正重试
          const { validateArgs } = require('./schema-validate')
          const val = validateArgs(toolName, args, filteredDefs)
          if (!val.ok) {
            dispatchPromises.push(Promise.resolve({
              toolName, toolCallId: tc.id || tc.function.name,
              success: false, error: '参数校验失败：' + val.errors.join('；'), validation: true, args
            }))
            continue
          }
          dispatchPromises.push(
            // S3-8 修复：familyId 放在 ...args 之后，防止 AI 被提示注入在工具参数塞 familyId 覆盖显式值
            // 原实现 { familyId, ...args } 中 args 的 familyId 会覆盖前面显式的 familyId，可误写同 openid 下其他家庭
            dispatch(toolName, { ...args, familyId }, openid)
              // T-M3 修复：needsConfirm（code 409）是"待确认"而非失败，不应记 success:false，
              // 避免 agent_logs 与客户端契约将待确认误报为失败
              .then(r => ({ toolName, toolCallId: tc.id || tc.function.name, success: !(r && (r.success === false || ((r.code && r.code !== 200) && !r.needsConfirm))), result: r, args }))
              .catch(e => ({ toolName, toolCallId: tc.id || tc.function.name, success: false, error: e.message, args }))
          )
        }
      }
      toolResults = await Promise.all(dispatchPromises)
      // 数据变更后失效上下文缓存（R3v2 #3：key 与 _buildToolContext 一致，带 openid）
      if (toolResults.some(tr => tr.success)) ctxCache.invalidate(familyId + ':' + openid)

      // suggestion 生成委托纯函数（架构审计第 13 轮：抽取局部性）
      const { suggestions, pending_confirms } = buildSuggestions(toolResults)

      // P2：phase1 文本 + 模板化工具结果摘要
      const phase1Text = (phase1.text || '').trim()
      const summaryParts = toolResults
        .filter(tr => tr.success)
        .map(tr => {
          const summaryFn = toolSummaries[tr.toolName]
          return summaryFn ? summaryFn(tr) : null
        })
        .filter(Boolean)
      const summary = summaryParts.length > 0 ? '\n\n' + summaryParts.join('\n') : ''
      const summaryText = ((phase1Text || cleanText) + summary).trim() // 模板兜底（不含 A 断言）
      const hasPending = suggestions.length > 0
      const failedResults = toolResults.filter(tr => !tr.success)
      // v9.5 成功回流排除项：triggerAnalysis（fire-and-forget，无数据可组织）、writeMessage（内部写消息）。
      // query* 从排除名单移除——用户主动查询时（如"看看保单信息"）工具结果必须回流展示实际数据，
      // 否则回复停在 A 的"为您查询..."过程语，数据丢失（实测 queryPolicies 返回 4 张保单未展示）。
      const REFLOW_SKIP = ['triggerAnalysis', 'writeMessage']
      const reflowable = toolResults.filter(tr => tr.success && REFLOW_SKIP.indexOf(tr.toolName) === -1)
      if (hasPending) {
        // 待确认：phase1 文本 + 确认卡
        cleanText = phase1Text || cleanText
      } else if (failedResults.length > 0) {
        // v9 失败场景：不保留通道 A 的断言文本（A 可能断言了未发生的操作），先用成功项模板兜底，
        // P2.5 失败回流再生成失败提示覆盖（"为什么没写成 + 下一步"）
        cleanText = summaryText
      } else if (reflowable.length > 0) {
        // v9.3 成功回流：写类工具全部成功 → 工具结果回流 B 生成最终回复
        // （B 基于真实执行结果组织确认语，消除 A 执行前断言的细节偏差，如部分字段落库差异）
        cleanText = await _reflowWithResults({ toolResults, userText, aText, cleanText, ctxCache, familyId, openid, sid, history, toolSummaries, buildToolSystemPrompt })
      } else {
        // v9 全部成功但无可回流工具（如仅 triggerAnalysis/query）：保留通道 A 的断言文本原样
        cleanText = aText || summaryText
      }

      // P2.5 失败回流：存在工具失败时，把执行结果（成功=模板句，失败=错误详情）回流模型再生成，
      // 让 AI 解释失败原因并给出下一步（重试/澄清/改法），而非模板丢弃错误（原 filter(success) 丢失败信息）。
      // 写类成功仍走模板（省 token），仅失败场景多一次调用（低频，成本可接受）。
      if (failedResults.length > 0 && !hasPending) {
        try {
          const { callChat } = require('./_shared/ai-client')
          const { safeCallChat } = require('./_shared/ai-gateway')
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
          const refineMsgs = [
            { role: 'system', content: buildToolSystemPrompt() + '\n\n当前客户信息：\n' + ctx },
            { role: 'user', content: userText },
            ...toolCallMsgs,
            ...toolResultMsgs
          ]
          const phase2 = await safeCallChat(
            refineMsgs, callChat,
            { cloud, db: cloud.database(), openid, familyId, sessionId: sid, model: 'hy3', action: 'conversation_tool_refine', skipRateLimit: true },
            { maxTokens: 800 }
          )
          if (phase2.text && phase2.text.trim()) cleanText = phase2.text.trim()
        } catch (e) {
          console.warn('[tool-orchestration] 失败回流再生成失败，回退模板拼接:', (e && e.message) || e)
        }
      }

      return { cleanText, suggestions, pending_confirms, toolResults }
    }
  } catch (e) {
    console.warn('[tool-orchestration] function calling 失败:', e.message)
  }

  return { cleanText, suggestions: [], pending_confirms: [], toolResults }
}

module.exports = { orchestrate, filterToolDefs }
