/**
 * _shared/injection-guard.js — 输入注入检测（权威源）
 *
 * 从 guard.js 拆出（架构审计 R3v2 #1）：guard.js 依赖 config.js 不适合整体同步前端，
 * 本文件纯规则无外部依赖，经 sync-shared.js CONTRACT_FILES 同步到 miniprogram/utils/，
 * 前端流式直调（chat-panel onSend）与后端 guard.js 共用同一注入规则。
 */
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

module.exports = { detectInjection, detectConfusables, INJECTION_RULES }
