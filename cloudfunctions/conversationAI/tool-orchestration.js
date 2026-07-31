/**
 * tool-orchestration.js — 工具编排内核（深模块）
 *
 * 解决问题：postProcess 内联 ~120 行工具编排逻辑（构建消息→429 退避→并发 dispatch
 * →suggestion 生成→summary 拼接），与消息持久化/审计/CONFIRM 拦截纠缠，
 * 难以针对"工具链失败"场景单测。
 *
 * 接口契约：
 *   orchestrate({
 *     familyId, openid, sid, userText, auditText,    // 输入
 *     dispatch, ctxCache, toolDefs,                  // 依赖注入（路由 + 缓存 + schema）
 *     toolSummaries, buildAdvisorSystemPrompt        // 依赖注入（摘要表 + prompt 构建器）
 *   }) → { cleanText, suggestions, pending_confirms, toolResults }
 *
 *   - dispatch(tool, params, openid) → result         （由调用方注入，便于测试）
 *   - ctxCache.get(familyId) / ctxCache.invalidate(familyId)
 *   - toolDefs: TOOL_DEFINITIONS（工具 schema 单一事实源）
 *   - toolSummaries: { [toolName]: (tr) => string|null }  仅 summary 函数（架构审计第 13 轮：接口收窄）
 *   - buildAdvisorSystemPrompt: prompts.js 导出
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

/**
 * 工具编排主流程
 * @returns {Promise<{cleanText: string, suggestions: array, pending_confirms: array, toolResults: array}>}
 */
async function orchestrate({
  familyId, openid, sid, userText, auditText,
  dispatch, ctxCache, toolDefs,
  toolSummaries, buildAdvisorSystemPrompt
}) {
  // 默认值：调用方未传 auditText 时退化为 ''
  let cleanText = auditText || ''
  let toolResults = []

  if (!userText) {
    return { cleanText, suggestions: [], pending_confirms: [], toolResults }
  }

  try {
    const { callChatWithTools } = require('./_shared/ai-client')
    const { safeCallChatWithTools } = require('./_shared/ai-gateway')

    // tool context 由调用方预构建并缓存于 ctxCache，此处仅取
    const ctx = ctxCache.get(familyId) || ''

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

    const toolMessages = [
      { role: 'system', content: buildAdvisorSystemPrompt() + '\n\n当前客户信息：\n' + ctx + coverageHint },
      { role: 'user', content: userText }
    ]

    // 429 退避重试（架构审计第 14 轮候选 #3：委托 withRetry，原指数退避 delayMs*attempt 由 backoff='exponential' 实现）
    const phase1 = await withRetry(
      () => safeCallChatWithTools(
        toolMessages, toolDefs, callChatWithTools,
        { cloud, db: cloud.database(), openid, familyId, sessionId: sid, model: 'hy3', action: 'conversation_tools', skipLog: true, skipRateLimit: true },
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
          dispatchPromises.push(
            // S3-8 修复：familyId 放在 ...args 之后，防止 AI 被提示注入在工具参数塞 familyId 覆盖显式值
            // 原实现 { familyId, ...args } 中 args 的 familyId 会覆盖前面显式的 familyId，可误写同 openid 下其他家庭
            dispatch(toolName, { ...args, familyId }, openid)
              .then(r => ({ toolName, toolCallId: tc.id || tc.function.name, success: !(r && (r.success === false || (r.code && r.code !== 200))), result: r, args }))
              .catch(e => ({ toolName, toolCallId: tc.id || tc.function.name, success: false, error: e.message, args }))
          )
        }
      }
      toolResults = await Promise.all(dispatchPromises)
      // 数据变更后失效上下文缓存
      if (toolResults.some(tr => tr.success)) ctxCache.invalidate(familyId)

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
      const hasPending = suggestions.length > 0
      cleanText = hasPending ? phase1Text : ((phase1Text || cleanText) + summary).trim()

      return { cleanText, suggestions, pending_confirms, toolResults }
    }
  } catch (e) {
    console.warn('[tool-orchestration] function calling 失败:', e.message)
  }

  return { cleanText, suggestions: [], pending_confirms: [], toolResults }
}

module.exports = { orchestrate }
