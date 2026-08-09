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
 * 输出: { code, data: { portrait, review, plan, suggestions, disclaimer } }（milestones 已移除，见 report-fields.js）
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
    // 全链路审计 RM1/RM5：节流时间源为 analysis_lock_at（CAS 占用字段）；last_analysis_at 仅表示"上次成功分析时间"，
    // 不再被 CAS 污染——归档 version_at（report-versions 读 last_analysis_at）因此保持"上次成功时间"，修复版本时间线错位
    // 旧数据无 analysis_lock_at 时回退 last_analysis_at（向后兼容）
    const lockAt = fm.analysis_lock_at || fm.last_analysis_at
    if (lockAt) {
      const elapsed = Date.now() - new Date(lockAt).getTime()
      if (elapsed < REPORT_THROTTLE_MS) {
        // 节流返回需完整 family 记录给 toReadReport，单独查一次（节流命中是冷路径，避免常驻内存）
        const f = await getFamily(db, familyId, openid)
        return { code: 200, data: toReadReport(f), throttled: true }
      }
    }
    // 全链路审计 RM5：失败提示附带剩余冷却秒数（CAS 锁定 30s，AI 失败后需等锁过期才能重试）
    // 锁开始时间 = casNow（CAS 占用值，DB 已写；fm 内存对象未同步故不可用）
    const _retrySuffix = () => {
      const remain = Math.ceil((new Date(casNow).getTime() + REPORT_THROTTLE_MS - Date.now()) / 1000)
      return remain > 0 ? ('，' + remain + '秒后可重试') : ''
    }
    // R3v2 审计 #5：CAS 原子占用 analysis_lock_at（独立字段），防并发双跑（两处节流读旧值竞态 → 双倍计费+重复归档）
    // 条件更新：仅当 analysis_lock_at 仍为读取时的旧值（或无值）才占用成功；并发请求条件失败 → 视同节流命中
    const _ = db.command
    const casNow = new Date()
    const casCond = fm.analysis_lock_at
      ? { analysis_lock_at: fm.analysis_lock_at }
      : { analysis_lock_at: _.exists(false) }
    const cas = await db.collection('families').where({ _id: familyId, ...casCond }).update({ data: { analysis_lock_at: casNow } })
    const casUpdated = cas.stats ? cas.stats.updated : (cas.updated || 0)
    if (casUpdated === 0) {
      const f2 = await getFamily(db, familyId, openid)
      return { code: 200, data: toReadReport(f2), throttled: true }
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
        // token 成本审计 P2：重试上下文裁剪"上一版参考"块（retry 时 prevMd 对解析无增益，体积约省 15-25%）
        const retryCtx = _compactForRetry(enrichedContext) + '\n\n## ⚠️ 上次输出无法解析为 JSON，请严格只输出一个 JSON 对象，不要包含任何 Markdown 代码块、注释或额外文字'
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
          // R3v2 审计 #9：透传前端 _reqId（会话 traceId）
          traceId: event._reqId || '',
          action: 'report_parse_fail',
          status: 'fail',
          rawText: lastRawText,
          error: { message: 'AI 返回非预期 JSON 格式（含 1 次重试）' }
        })
        // 全链路审计 RM5：失败提示附带剩余冷却秒数（CAS 锁 30s 未过期）
        return { code: 500, msg: '报告生成失败' + _retrySuffix() }
      }
      const now = new Date()
      // prompt 工程审计：字段级校验——记录缺失键，不静默入库（AI 输出格式漂移时可观测）
      const _missing = []
      for (const k of ['portrait', 'review', 'plan', 'summary', 'analysis', 'conclusion', 'suggestions', 'disclaimer']) {
        const v = parsed && parsed[k]
        if (v === undefined || v === null || String(v).trim() === '') _missing.push(k)
      }
      // suggestions 语义为字符串列表，AI 偶发输出数组时规范化（join('；')），避免污染后续消费
      if (parsed && Array.isArray(parsed.suggestions)) parsed.suggestions = parsed.suggestions.filter(x => x).join('；')
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
        last_analysis_at: now,
        // 全链路审计 RM1：分析成功即释放 CAS 锁（analysis_lock_at 仅表示"进行中"占用）
        analysis_lock_at: _.remove()
      }))
      // 触发 advanceStage：completeness_score 写入后阶段可能从 profiling → analyzing
      // （stageMachine 依赖 completeness_score >= 80 判定，原裸写不触发钩子导致阶段滞后）
      await advanceStage(db, familyId, openid)
      // P2：记录报告生成日志，含 AI 自报的激活维度（委托 logSeam.logAI）
      await logAI(db, {
        openid, familyId,
        // R3v2 审计 #9：透传前端 _reqId（会话 traceId）
        traceId: event._reqId || '',
        action: 'report_generate',
        status: 'success',
        activatedDimensions: Array.isArray(parsed.activated_dimensions) ? parsed.activated_dimensions : [],
        coreInsights: Array.isArray(parsed.core_insights) ? parsed.core_insights : [],
        metrics: { completeness: calcCompletenessScore(f, policies), missingFields: _missing },
        promptVersion: 'reportAI_v2'
      })
      // 全链路审计 RC1：删除 milestones 返回（FIELD_KEYS 不持久化 + 前端 parseMilestonesToTimeline 无消费调用，返回即契约断裂死值）
      return { code: 200, data: { portrait: parsed.portrait, review: parsed.review, plan: parsed.plan, summary: String(parsed.summary || ''), analysis: String(parsed.analysis || ''), conclusion: String(parsed.conclusion || ''), suggestions: parsed.suggestions, disclaimer: parsed.disclaimer || '', core_insights: Array.isArray(parsed.core_insights) ? parsed.core_insights : [] } }
    } catch (e) {
      // 全链路审计 RM5：通用失败同样附带剩余冷却秒数
      const r = wrapError('报告生成', e)
      if (r && typeof r.msg === 'string') r.msg += _retrySuffix()
      return r
    }
  } catch (e) {
    return wrapError('处理', e)
  }
}

/** 解析失败重试时裁剪"上一版报告参考"块（token 成本审计 P2：retry 对该块无增益，体积省 15-25%） */
function _compactForRetry(full) {
  return String(full || '').split('\n\n').filter(b => !/^##\s*上一版报告结论/.test(b)).join('\n\n')
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
