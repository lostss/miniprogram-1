/**
 * _shared/ai-accounting.js — AI 用量记账的唯一事实源（定价 / 配额 / 日志）
 *
 * 架构审查候选 3：此前「算价 → 计配额 → 写 agent_logs」这个序列在两处各写一遍：
 *   1) `ai-gateway._runSecuredPipeline`（gateway 通道，成功/失败路径各自内联）
 *   2) `conversationAI/tool-orchestration._recordDirectUsage`（DeepSeek 直连通道，手写 15 行）
 * 两处口径必须一致（同一 PRICING、同一 `agents` 计数），却靠人工对齐 → 直连通道 2026-09-12
 * 才发现"既不写 agent_logs 也不计配额"的最大漏账口（对话是最高频调用）。
 *
 * 现收敛为三层，各司其职：
 *   - `calcTokenUsage`  算价（本文件唯一实现；原在 ai-gateway，纯搬运）
 *   - `bumpAgentTokens` 配额累加（原在 ai-gateway，纯搬运）
 *   - `recordAIUsage`   组合：算价 → 按状态计配额 → 写日志（直连等"非流水线"场景单点调用）
 *
 * 依赖方向：ai-accounting → (config, logSeam)；**不反向依赖 ai-gateway**（避免环）。
 * ai-gateway 反向 require 本文件，并 re-export calcTokenUsage/bumpAgentTokens（兼容旧调用点）。
 */
const { COST_PER_1K, PRICING } = require('./config')

/**
 * 自然月键 'YYYY-MM'（配额跨月重置判据；与 guard 取用同一实现 —— guard 从这里 require）
 *
 * 2026-09-28 复审（dsh 审计项③）：改用**北京时间（UTC+8）**，不再随运行时本地时区。
 * 云函数运行时为 UTC，原实现（`getFullYear/getMonth`，即本地时区）会让北京时间
 * **每月 1 日 00:00–08:00 仍判为上月** —— 月配额不重置、用户月初被提示"本月 AI 用量已达上限"。
 * 实现取下限明确的方式：把时间戳平移 8h 后一律用 getUTC*，与运行时 TZ 无关（可复现、可测）。
 */
function _monthKey(d) {
  const x = new Date((d || new Date()).getTime() + 8 * 3600 * 1000)
  return x.getUTCFullYear() + '-' + ('0' + (x.getUTCMonth() + 1)).slice(-2)
}
const { logAI } = require('./logSeam')

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
  // currency 随 model 变动（hy3=USD、deepseek-*=CNY）：消费方**禁止跨货币直接相加 cost**，
  // 必须按 currency 分组汇总（详见 config.PRICING 上方的警告）。原返回值不带货币，
  // 导致任何跨模型求和都静默地把两种货币当成同一种（2026-09-15 查实）。
  const currency = price ? (price.currency || 'CNY') : 'CNY'
  return { input, output, total, cost: Math.round(cost * 1e6) / 1e6, currency }
}

/**
 * 用户月度 token 配额原子累加（agents.token_used_monthly/total，只加不减）。
 * 供 ai-gateway 内部与 conversationAI 直连通道共用；DB 不可用/失败不抛错。
 */
async function bumpAgentTokens(db, openid, total) {
  if (!db || !openid || !(total > 0) || typeof db.collection !== 'function') return
  try {
    const _ = db.command
    if (!(_ && typeof _.inc === 'function')) return
    const nowPeriod = _monthKey()
    const inc = { data: { token_used_monthly: _.inc(total), token_used_total: _.inc(total), quota_period: nowPeriod } }
    // 2026-09-12：原实现只 update——agents 文档不存在时命中 0 条、不报错、静默丢弃（配额虚高，
    // 用户实际用量远超记录的 token_used_monthly）。改为命中 0 条则补建文档；并发下 add 冲突
    // （已被别处建档）则回退重试一次累加。补建文档只带 token 字段：checkMonthlyQuota 读到
    // 缺失 token_monthly_limit → 视为无限制，不会误伤放行策略。
    //
    // 2026-09-22 全面审计 P1-2 / P1-3（两处修正）：
    //  ① 定位键从 `{openid, _openid}` 放宽为 `{openid, quota_period: 本月}`：原写法对
    //     "历史文档缺 _openid"命中 0 条 → 走补建分支造出**第二份 agents 文档**（无 token_monthly_limit），
    //     而 guard.checkMonthlyQuota 用 .limit(1) 取任意一份 → 取到补建那份即放行，配额永久失效。
    //     openid 来自服务端调用方（非客户端可控），单独作为定位键不产生越权面。
    //  ② 顺带实现跨月重置：quota_period 不是本月 → 走下方 reset 分支把本月计数重置为本次用量。
    //     这也让**存量文档**（无 quota_period，此前被 P1-2 永久封禁的老用户）在下次调用时自动解封。
    const res = await db.collection('agents').where({ openid, quota_period: nowPeriod }).update(inc)
    const updated = (res && res.stats && res.stats.updated) || 0
    if (updated === 0) {
      // 跨月重置（文档在、但计数是上月的；含存量无 quota_period 文档）
      const reset = { data: { token_used_monthly: total, token_used_total: _.inc(total), quota_period: nowPeriod } }
      const r2 = await db.collection('agents').where({ openid }).update(reset)
      if (((r2 && r2.stats && r2.stats.updated) || 0) === 0) {
        // 确认无文档 → 补建
        try {
          await db.collection('agents').add({
            data: { openid, _openid: openid, token_used_monthly: total, token_used_total: total, quota_period: nowPeriod, created_at: new Date() }
          })
        } catch (e) {
          console.warn('[ai-accounting] agents 建档冲突，回退累加:', e.message)
          await db.collection('agents').where({ openid }).update(inc)
        }
      }
    }
  } catch (e) { console.error('[ai-accounting] 配额累加异常:', e.message) }
}

/**
 * 一次 AI 调用的完整记账：算价 → 按状态计配额 → 写 agent_logs。
 *
 * 口径（两通道必须一致，历史教训见文件头）：
 *   - **仅成功调用计入配额**（status==='fail' 不累加），但**失败也写日志留痕**——
 *     失败调用已消耗输入 token，不记会导致成本系统性低估、异常率无日志支撑
 *     （ai-client 会把已收到的 usage 挂到 err.usage）。
 *   - cost 与 currency 一并落库：currency 不落库时，跨模型求和无法按货币分组，
 *     而 hy3 是 USD、deepseek-* 是 CNY，直接相加静默出错（config.PRICING 有专门警告）。
 *
 * @param {object} db
 * @param {object} opts
 *   - openid（必填，否则 logAI 缺 openid 归因）、action（必填）
 *   - familyId?, sessionId?, traceId?, model?
 *   - usage? AI 返回的 usage（失败时传 err.usage）
 *   - status? 'success' | 'fail' | 'blocked'（默认 success）
 *   - error? 失败详情
 *   - metrics? 附加指标（如输出审计命中）
 *   - countQuota? 默认 true；显式 false 可不计配额（如预检失败场景）
 *   - skipLog? 只计配额不写日志（对齐 ai-gateway 的 ctx.skipLog）
 * @returns {Promise<string|null>} logId
 */
async function recordAIUsage(db, opts) {
  const o = opts || {}
  const tk = calcTokenUsage(o.usage || {}, o.model)
  const status = o.status || 'success'
  if (o.countQuota !== false && status !== 'fail' && tk.total > 0) {
    await bumpAgentTokens(db, o.openid, tk.total)
  }
  if (o.skipLog || !o.action) return null
  return logAI(db, {
    openid: o.openid,
    familyId: o.familyId,
    sessionId: o.sessionId,
    traceId: o.traceId,
    action: o.action,
    model: o.model,
    status,
    tokens: { input: tk.input, output: tk.output, total: tk.total },
    cost: tk.cost,
    currency: tk.currency,
    error: o.error || undefined,
    metrics: o.metrics
  })
}

// `_monthKey` 一并导出：本模块是 `quota_period` 的**写入方**，月键口径应由写入方拥有，
// 读取方（guard.checkMonthlyQuota）从这里取用（2026-09-26 复审纠偏，原为两处各定义一份）。
module.exports = { calcTokenUsage, bumpAgentTokens, recordAIUsage, _monthKey }
