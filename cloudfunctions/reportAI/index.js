/**
 * reportAI — 保障报告生成（AI 产出画像/点评/规划/建议）
 *
 * 架构（#7 重构后）：
 *   - prompts.js           : REPORT_PROMPT 常量（336 行角色设定 + 思维链 + 写作指南）
 *   - report-versions.js   : 版本归档 + 清理（archivePrevious）
 *   - report-coverage.js   : 结构化保单清单 + 一致性提示（buildStructuredCoverage）
 *   - report-context.js    : 3 段上下文整合（summary + structured + prev → enrichedContext）
 *   - _shared/parse-ai-json: AI 输出 JSON 容错解析（与 ocr-extractor 共用）
 *   - index.js             : 仅保留编排（节流 → 上下文构建 → AI 调用 → 解析 → 写回）
 *
 * 输入: familyId
 * 输出: { code, data: { portrait, review, plan, suggestions, milestones, disclaimer } }
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { calcCompletenessScore } = require('./_shared/completeness')
const { buildFamilyContext: buildV2Context } = require('./_shared/v2-context')
const { getFamily } = require('./_shared/db-helpers')
const { loadFamilyView } = require('./_shared/familyView')
const { ensureStatusBatch } = require('./_shared/policy-status')
const { loadActivePolicies } = require('./_shared/policy-read')
const { toWriteFields, toReadReport } = require('./_shared/report-fields')
const { REPORT_THROTTLE_MS, REPORT_KEEP_VERSIONS, AI } = require('./_shared/config')
const { parseAIJSON } = require('./_shared/parse-ai-json')
const { writeSeam, advanceStage } = require('./_shared/writeSeam')
const { REPORT_PROMPT } = require('./prompts')
const { archivePrevious } = require('./report-versions')
const { buildReportContext } = require('./report-context')
// 架构审计第 6 轮：日志写入统一走 logSeam
const { logAI } = require('./_shared/logSeam')
// 架构审计第 14 轮候选 #2：错误格式化统一委托 errorHandler
const { wrapError } = require('./_shared/errorHandler')

exports.main = async (event, context) => {
  const { familyId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  const wxContext = cloud.getWXContext()
  const openid = wxContext?.OPENID || wxContext?.openId
  if (!openid) return { code: 401, msg: '未登录' }

  try {
    // ponytail: buildV2Context 内部已并行查询 family/members/finances/facts/cashValues 5 集合
    // v2-context 接口收敛：消费 familyMeta/birthMap/datasets 显式契约，不再触碰 ctx.raw
    // 架构审计第 16 轮候选 #1：policies 读取走 loadActivePolicies 接缝（_openid 注入 + 过滤 deleted）
    // ensureStatus 关闭——下方需先注入 insured_birth_date/insured_age 再调用 ensureStatusBatch（依赖 age）
    const [ctx, rawPolicies] = await Promise.all([
      buildV2Context(db, familyId, openid, 'report'),
      loadActivePolicies(db, familyId, openid, { ensureStatus: false, limit: 50 })
    ])
    const fm = ctx.familyMeta
    if (!fm || !fm.family_id) return { code: 404, msg: '客户不存在' }
    // B1: 30s 节流防抖，避免短时间重复调用 AI
    if (fm.last_analysis_at) {
      const elapsed = Date.now() - new Date(fm.last_analysis_at).getTime()
      if (elapsed < REPORT_THROTTLE_MS) {
        // 节流返回需完整 family 记录给 toReadReport，单独查一次（节流命中是冷路径，避免常驻内存）
        const f = await getFamily(db, familyId, openid)
        return { code: 200, data: toReadReport(f), throttled: true }
      }
    }
    const birthMap = ctx.birthMap

    // 注入被保人出生日期+年龄，支撑「至XX周岁」期限解析
    // ensureStatus 依赖 insured_age，故先 map 再 ensureStatusBatch
    const nowTs = Date.now()
    const policies = ensureStatusBatch(rawPolicies.map(p => {
      const bd = birthMap.get(p.member_id)
      if (!bd) return p
      const age = Math.floor((nowTs - new Date(bd).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      return Object.assign({}, p, { insured_birth_date: bd, insured_age: age })
    }))
    // 3 段上下文整合：v2.markdown + 保单汇总 + 结构化清单 + 一致性提示 + 上一版参考
    // 抽到 report-context.js，本处仅组合调用（避免主流程被字符串拼接淹没）
    // facts/cashValues 由 buildReportContext 从 v2ctx.datasets 自取（避免双源读取）
    const enrichedContext = buildReportContext({
      v2ctx: ctx,
      policies,
      familyMeta: fm
    })

    try {
      // B5: JSON 解析失败重试 1 次（首轮 AI 输出偶发带噪声/截断，第二轮提示更严格输出格式）
      const { text: aiText1 } = await _callAI(enrichedContext, { cloud, db, openid, familyId })
      let cleaned = _cleanMarkdown(aiText1)
      let parsed = parseAIJSON(cleaned)
      let lastRawText = cleaned || ''
      if (!parsed || !parsed.portrait) {
        // 重试：追加「仅输出严格 JSON」的硬约束
        const retryCtx = enrichedContext + '\n\n## ⚠️ 上次输出无法解析为 JSON，请严格只输出一个 JSON 对象，不要包含任何 Markdown 代码块、注释或额外文字'
        try {
          const { text: aiText2 } = await _callAI(retryCtx, { cloud, db, openid, familyId })
          cleaned = _cleanMarkdown(aiText2)
          parsed = parseAIJSON(cleaned)
          lastRawText = (lastRawText + '\n---RETRY---\n' + (cleaned || '')).substring(0, 800)
        } catch (e) {
          lastRawText = (lastRawText + '\n---RETRY_ERR---\n' + e.message).substring(0, 800)
        }
      }
      if (!parsed || !parsed.portrait) {
        // 解析失败：经 logSeam 记录日志（统一 _openid 注入 + schema），返回错误
        // （不写假数据到 families，保持 insight_stale=true 允许重试）
        await logAI(db, {
          openid, familyId,
          action: 'report_parse_fail',
          status: 'fail',
          rawText: lastRawText,
          error: { message: 'AI 返回非预期 JSON 格式（含 1 次重试）' }
        })
        return { code: 500, msg: '报告生成失败，请重试' }
      }
      const now = new Date()
      // 归档/写回需完整 family 记录（last_*/completeness_score 等），冷路径单独查一次
      const f = await loadFamilyView(db, openid, familyId)
      // B4: 归档上一版报告到 reports 集合，保留最近 REPORT_KEEP_VERSIONS 版
      await archivePrevious(db, {
        familyId, openid,
        prevFamily: f,
        keepVersions: REPORT_KEEP_VERSIONS,
        now
      })
      // 写入 families 经 writeSeam 收编（自动注入 _openid/updated_at 不变量）
      // 用 silentUpdateWhere 因下方显式调 advanceStage，避免钩子重复触发
      const ws = writeSeam(db, openid, familyId)
      await ws.silentUpdateWhere('families', { _id: familyId }, Object.assign(toWriteFields(parsed), {
        completeness_score: calcCompletenessScore(f, policies),
        insight_stale: false,
        last_analysis_at: now
      }))
      // 触发 advanceStage：completeness_score 写入后阶段可能从 profiling → analyzing
      // （stageMachine 依赖 completeness_score >= 80 判定，原裸写不触发钩子导致阶段滞后）
      await advanceStage(db, familyId, openid)
      // P2：记录报告生成日志，含 AI 自报的激活维度（委托 logSeam.logAI）
      await logAI(db, {
        openid, familyId,
        action: 'report_generate',
        status: 'success',
        activatedDimensions: Array.isArray(parsed.activated_dimensions) ? parsed.activated_dimensions : [],
        coreInsights: Array.isArray(parsed.core_insights) ? parsed.core_insights : [],
        metrics: { completeness: calcCompletenessScore(f, policies) },
        promptVersion: 'reportAI_v2'
      })
      return { code: 200, data: { portrait: parsed.portrait, review: parsed.review, plan: parsed.plan, summary: String(parsed.summary || ''), analysis: String(parsed.analysis || ''), conclusion: String(parsed.conclusion || ''), suggestions: parsed.suggestions, milestones: String(parsed.milestones || ''), disclaimer: parsed.disclaimer || '', core_insights: Array.isArray(parsed.core_insights) ? parsed.core_insights : [] } }
    } catch (e) {
      return wrapError('报告生成', e)
    }
  } catch (e) {
    return wrapError('处理', e)
  }
}


async function _callAI(context, deps) {
  const { text: aiText, usage, logId } = await require('./_shared/ai-gateway').safeCallChat(
    [{ role: 'system', content: REPORT_PROMPT }, { role: 'user', content: context }],
    require('./_shared/ai-client').callChat,
    { cloud: deps.cloud, db: deps.db, openid: deps.openid, familyId: deps.familyId, sessionId: 'report_' + Date.now().toString(36), model: AI.CHAT_MODEL, action: 'report_generate' },
    { maxTokens: 2600, temperature: 0.5, responseFormat: { type: 'json_object' }, timeoutMs: 30000 }
  )
  return { text: aiText, usage, logId }
}

function _cleanMarkdown(text) {
  if (!text) return ''
  return text.replace(/<[^>]+>/g, '').replace(/```json\s*/g, '').replace(/```\s*/g, '')
}
