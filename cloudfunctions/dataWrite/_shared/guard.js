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
const MAX_INPUT = SECURITY.MAX_INPUT
const RATE_LIMIT_WINDOW_MS = SECURITY.RATE_LIMIT_WINDOW_MS
const RATE_LIMIT_MAX = SECURITY.RATE_LIMIT_MAX
const ZERO_WIDTH = /[\u200b\u200c\u200d\u200e\u200f\ufeff]/g
const CONFUSABLE_MAP = { '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0391': 'A', '\u0395': 'E', '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X', '\u0392': 'B' }
const CONFUSABLE_RE = new RegExp('[' + Object.keys(CONFUSABLE_MAP).join('') + ']', 'g')
const INJECTION_RULES = [
  /忽略(以上|前面|系统|规则|指令|提示|prompt)/i, /无视.*(指令|规则|限制|系统|prompt)/i,
  /你是.*(模型|AI|机器人|助手之外)/i, /system\s*prompt/i,
  /扮演\s*(你|自己)?\s*(是|为|成|起|当)\s*(系统|模型|AI|机器人|助手)/i, /假装你是|从现在起你是|你现在是/i, /忘记.*(之前|上面|所有)/i,
  /(不要|别再|禁止).*(作为|扮演|充当)/i, /ignore\s+(all\s+)?(previous|above|instructions|system)/i,
  /you\s+are\s+(now\s+)?(a\s+)?(different|another)/i, /pretend\s+you\s+are/i
]

// sanitize: 复用 pii-rules 的基础实现，传入后端 MAX_INPUT 配置
function sanitize(text) {
  return _sanitizeInput(text, MAX_INPUT)
}

function detectConfusables(text) {
  if (!text) return { found: false, chars: [] }
  const found = []; let m
  CONFUSABLE_RE.lastIndex = 0
  while ((m = CONFUSABLE_RE.exec(text)) !== null) found.push(m[0] + '\u2192' + CONFUSABLE_MAP[m[0]])
  return { found: found.length > 0, chars: [...new Set(found)] }
}

function detectInjection(text) {
  if (!text) return { injected: false }
  const conf = detectConfusables(text)
  if (conf.found && conf.chars.length >= 3) return { injected: true, rule: 'unicode_confusable', confusables: conf.chars }
  for (const r of INJECTION_RULES) { r.lastIndex = 0; if (r.test(text)) return { injected: true, rule: r.source } }
  return { injected: false }
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
      action: _.nin(['ocr_extract', 'ocr_extract_batch', 'ocr_recognize', 'ocr_only_batch', 'ai_extract_batch', 'ai_extract_parallel', 'ocr_ai_extract'])
    }).count()
    if (count.total > RATE_LIMIT_MAX) return { allowed: false, reason: '请求过于频繁，请稍后重试' }
  } catch (e) { console.error('[guard] checkRateLimit 查询失败:', e.message) }
  return { allowed: true }
}

// ---- 输出审计 ----

// 禁止的赔付/收益承诺模式
const FORBIDDEN_CLAIMS = [
  /(保证|肯定|一定|100%|必定|绝对)(能|可以|会)?\s*(赔付|赔偿|理赔|报销|拿到|获赔)/,
  /(保证|承诺|确保|锁定)\s*(收益|回报|利率|分红)/,
  /年(化)?收益[率达]?\s*[\d.]+%?/,
  /(稳赚|保本|兜底|包赔)/,
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

module.exports = { sanitize, detectInjection, detectConfusables, checkRateLimit, auditOutput }
