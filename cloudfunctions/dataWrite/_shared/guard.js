/**
 * _shared/guard.js — 安全检查 + 限流（权威源）
 *
 * PII 脱敏规则（desensitize/sanitize）由 pii-rules.js 提供，前后端共用同一事实源。
 * 本文件保留后端专有的注入检测、限流、输出审计逻辑。
 *
 * v2：auditOutput 改调 pii-rules.desensitize，删除本文件重复的 PII_PATTERNS。
 */
const { SECURITY } = require('./config')
const { desensitize, sanitize: _sanitizeInput } = require('./pii-rules')
// 注入检测规则拆至 injection-guard.js（纯规则无外部依赖，可同步前端；R3v2 #1）
const { detectInjection, detectConfusables } = require('./injection-guard')
// 自然月键的**单一事实源**在 ai-accounting —— 它同时是 `quota_period` 的写入方，口径应由写入方拥有。
// 2026-09-26 复审纠偏：此前此处**又定义了一份** `_monthKey`，两处注释都只写"改一处必须同改" ✗
// —— 而同源本可避免（两文件无循环依赖：ai-accounting 只 require config/logSeam）。
// 这类重复的失效方式是**静默**的：一处改了 → 月键与 quota_period 不再同口径 →
// 配额要么**永久锁死**（用户再也用不了报告/OCR）要么**永久放行**（配额形同虚设）。
const { _monthKey } = require('./ai-accounting')
const MAX_INPUT = SECURITY.MAX_INPUT
const RATE_LIMIT_WINDOW_MS = SECURITY.RATE_LIMIT_WINDOW_MS
const RATE_LIMIT_MAX = SECURITY.RATE_LIMIT_MAX

// sanitize: 复用 pii-rules 的基础实现，默认传入后端 MAX_INPUT 配置。
// 2026-09-22 全面审计（AI 侧 P1 的真正根因）：原实现 `function sanitize(text)` **只接受一个参数**，
// 把上游传来的长度上限**静默丢弃** → ai-gateway 想给 system 提示词（16330 字，warm 版本 16753 字）
// 放宽上限也无效，仍被 MAX_INPUT=16000 截断：报告提示词的「输出前红线重申」被截掉、
// warm（共情版）整块位于截断点之后 → 该功能 100% 失效且日志上看不出来。
// 现透传 maxLen；不传时行为与原来完全一致（pii-rules.sanitize 自身默认 16000）。
function sanitize(text, maxLen) {
  return _sanitizeInput(text, maxLen === undefined ? MAX_INPUT : maxLen)
}

async function checkRateLimit(db, openid) {
  if (!openid) return { allowed: true }
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS)
  try {
    // Bug-17 修复：OCR 提取（ocr_extract）是用户批量操作，不应耗尽对话限流配额
    // 9 张图 OCR 会产生 9-18 条 agent_logs，若计入限流会导致后续对话被误拒
    const _ = db.command
    const count = await db.collection('agent_logs').where({
      openid,
      timestamp: _.gte(windowStart),
      // 2026-09-28：排除表是"辅助/派生日志"，它们不该挤占用户的 60 次/60s 配额。
      // `report_ai_call` 是 2026-09-28 起 reportAI 走网关的那条 AI 调用行 —— 一次报告生成
      // 会同时产生它 + 业务行 `report_generate`（含 metrics），两条同名时一次生成被计 2 次
      // （上限实际只剩 30/60s）。改名后业务行仍在计数内 → 一次生成 = 1 次计数，口径不变。
      action: _.nin(['ocr_extract', 'ocr_extract_batch', 'ocr_recognize', 'ocr_only_batch', 'ai_extract_batch', 'ai_extract_parallel', 'ocr_ai_extract', 'report_ai_call'])
    }).count()
    if (count.total > RATE_LIMIT_MAX) return { allowed: false, reason: '请求过于频繁，请稍后重试' }
  } catch (e) { console.error('[guard] checkRateLimit 查询失败:', e.message) }
  return { allowed: true }
}

// ---- 月度 token 配额（用户级）----
// agents.token_used_monthly 由 ai-gateway 在每次 AI 调用成功后原子累加（只加不减），
// 此处仅读取比较。limit<=0、未建档或 DB 不可用时默认放行（配额缺失不阻断业务）。
async function checkMonthlyQuota(db, openid) {
  if (!db || !openid || typeof db.collection !== 'function') return { allowed: true }
  try {
    // 2026-09-22 全面审计 P1-3：定位键只用 openid（原为 `{openid, _openid}`）。
    // 原写法对"历史文档缺 _openid"读不到档案 → 直接放行（配额形同虚设）；而 openid 是 agents
    // 的逻辑唯一键、其值来自 wxContext 可信源，单独作 where 不产生越权面。
    const r = await db.collection('agents').where({ openid }).limit(5).get()
    // 2026-09-28 复审（dsh 审计项④）：并发首登会造出**两份** agents 文档（login 建档 + 计费补建），
    // 而原实现 `.limit(1)` 取任意一份 → 取到补建那份（无 token_monthly_limit）即放行，配额形同虚设。
    // 现取"最严"：只要**任一**文档限了额度就按其中最小限额判，用量取各文档最大值。
    // （与 09-22 P1-2 同根因的第三次发作：配额失效的形态永远是"读到了不该读的那一份"。）
    const list = (r && r.data) || []
    if (!list.length) return { allowed: true }
    const cur = _monthKey()
    const limits = list.map(a => Number(a.token_monthly_limit) || 0).filter(n => n > 0)
    if (!limits.length) return { allowed: true }
    const limit = Math.min.apply(null, limits)
    // 自然月重置（2026-09-22 全面审计 P1-2）：quota_period 由 ai-accounting.bumpAgentTokens 在累加时写入，
    // 与本月不一致即视为本月用量 0 —— 原实现只读比较、全仓无重置路径，trial 用户用满 30000 token 后
    // 恒返回"本月 AI 用量已达上限"却永不复原（只能人工改库）。存量无该字段的文档 ⇒ 放行一次，随后被写入本月。
    const used = list.reduce((mx, a) => (String(a.quota_period || '') === cur ? Math.max(mx, Number(a.token_used_monthly) || 0) : mx), 0)
    if (used >= limit) return { allowed: false, reason: '本月 AI 用量已达上限' }
  } catch (e) { console.error('[guard] checkMonthlyQuota 查询失败:', e.message) }
  return { allowed: true }
}

// （原此处自有一份 `_monthKey`，2026-09-26 复审已收敛到 ai-accounting 单一事实源，见文件头 import 注释）

// ---- 输出审计 ----

// 禁止的赔付/收益承诺模式
// 2026-09-10 修复误伤（线上事故）：原第 4 条为裸词 /(稳赚|保本|兜底|包赔)/，而「兜底」「保本」
// 在保险业务中是中性表述（"寿险需求按家庭年收入兜底估算""保本型年金"）。报告上下文含收入兜底口径时，
// AI 复述该口径 → 命中裸词 → auditOutput 把**整份报告 JSON 替换成一句拒答文案** → 必然解析失败，
// 重试同样被拦（23:20 事故：两次 output 2218/1846 tokens 全部丢弃，前端提示"分析失败"）。
// 现改为仅在构成"承诺"语境时拦截，保留合规能力、消除对业务中性词的误伤。
const FORBIDDEN_CLAIMS = [
  /(保证|肯定|一定|100%|必定|绝对)(能|可以|会)?\s*(赔付|赔偿|理赔|报销|拿到|获赔)/,
  /(保证|承诺|确保|锁定)\s*(收益|回报|利率|分红)/,
  /年(化)?收益[率达]?\s*[\d.]+%?/,
  // 取舍：「保本」保留裸词拦截（监管上保险产品不得宣传保本，含"保本理财/保本型"话术）；
  // 「兜底」仅在承诺语境拦截——"按家庭年收入兜底估算"是业务中性口径，裸词拦会把正常报告整体判违规
  /(稳赚|包赔|保本)/,
  /(保证|承诺|确保|锁定)\s*(兜底|兑付|不亏)/,
  /兜底\s*(赔付|理赔|收益|回报|兑付|不亏)/,
  /(每年|到期)?\s*(最高|最少|至少)\s*(可拿|可得|可领|可获)/,
]

// PII 检测正则（仅用于日志统计；脱敏统一调用 pii-rules.desensitize）
const PII_DETECTORS = [
  { re: /\b\d{15}(\d{2}[\dXx])?\b/g, label: '身份证号' },
  { re: /\b1[3-9]\d{9}\b/g, label: '手机号' },
  { re: /\b\d{16,19}\b/g, label: '银行卡号' },
]

function auditOutput(text) {
  if (!text) return { pass: true, text }

  // 1. 检测禁止承诺
  for (const rule of FORBIDDEN_CLAIMS) {
    if (rule.test(text)) {
      console.warn('[guard] 输出拦截：禁止承诺匹配规则', rule.source)
      return {
        pass: false,
        reason: '回复包含禁止的赔付/收益承诺，已被拦截',
        // 2026-09-10：带上命中规则，便于 warn 模式/日志定位是哪条正则误伤（原先只有笼统 reason）
        matchedRule: rule.source,
        text: '抱歉，作为AI助手我不能提供赔付或收益承诺相关的回答。'
      }
    }
  }

  // 2. 脱敏 PII（统一调用 pii-rules.desensitize，避免口径分裂）
  let piiCount = 0
  for (const { re, label } of PII_DETECTORS) {
    const matches = text.match(re)
    if (matches) {
      piiCount += matches.length
      console.warn('[guard] 输出脱敏：' + label + ' x' + matches.length)
    }
  }
  const clean = piiCount > 0 ? desensitize(text) : text

  return { pass: true, text: clean }
}

module.exports = { sanitize, detectInjection, detectConfusables, checkRateLimit, checkMonthlyQuota, auditOutput }
