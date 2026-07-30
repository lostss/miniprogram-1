/**
 * pii-rules.js — PII 脱敏规则（权威源，前后端共用）
 *
 * 纯函数，不依赖任何配置，可在小程序环境和云函数运行时使用。
 * 前端：miniprogram/utils/pii-rules.js（由 sync-shared.js CONTRACT_FILES 同步）
 * 后端：cloudfunctions/_shared/pii-rules.js（闭包式同步到各云函数）
 */

// 常见 PII 正则模式（mask 函数定义脱敏策略）
var PII_PATTERNS = [
  // 身份证（18位/15位）：保留前6位地区码+出生日期，其余脱敏
  { pattern: /\b(\d{6})(\d{4})(\d{2})(\d{2})(\d{3}[\dXx])\b/g, mask: function (m, a, b, c, d, e) { return a + b + '-' + c + '-' + d + '-****' } },
  // 手机号：保留前3后4
  { pattern: /\b(1[3-9]\d)\d{4}(\d{4})\b/g, mask: '$1****$2' },
  // 银行卡号（16-19位）：保留后4位
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4,7}\b/g, mask: function (m) { return '****' + m.slice(-4) } },
  // 纯数字银行卡（连续16-19位，不含分隔符，需排除已匹配的手机号/身份证）
  {
    pattern: /\b(\d{16,19})\b/g,
    mask: function (m) {
      // 排除已匹配的手机号（11位）和身份证（18位/15位带日期特征）
      if (/^1[3-9]\d{9}$/.test(m)) return m
      if (/^\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(m)) return m
      if (/^\d{6}\d{6}\d{3}$/.test(m)) return m // 15位身份证
      return '****' + m.slice(-4)
    }
  }
]

/**
 * desensitize: PII 脱敏
 * - 身份证：保留地区码+出生日期，掩码其余
 * - 手机号：保留前3后4
 * - 银行卡号：保留后4位
 * @param {string} s - 输入文本
 * @returns {string} 脱敏后文本
 */
function desensitize(s) {
  if (typeof s !== 'string') return ''
  for (var i = 0; i < PII_PATTERNS.length; i++) {
    var p = PII_PATTERNS[i]
    s = s.replace(p.pattern, p.mask)
  }
  return s
}

/**
 * sanitize: 清洗用户输入（前后端共用基础版）
 * - NFKC 归一化（全角→半角等）
 * - 去除零宽字符
 * - 截断到 maxLen 字符（默认 16000）
 * - 去除"客户说："前缀
 * @param {string} s - 输入文本
 * @param {number} [maxLen=16000] - 最大长度
 * @returns {string} 清洗后文本
 */
function sanitize(s, maxLen) {
  if (typeof s !== 'string') return ''
  var limit = typeof maxLen === 'number' ? maxLen : 16000
  // NFKC 归一化（小程序环境可能不支持 String.prototype.normalize，做兜底）
  try {
    if (String.prototype.normalize) s = s.normalize('NFKC')
  } catch (_) {}
  // 去除零宽字符
  s = s.replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u2061\u2062\u2063\u2064]/g, '')
  // 截断
  if (s.length > limit) s = s.substring(0, limit)
  // 去除"客户说："/"客户："前缀（及其变体，支持不带"说"字的形式）
  s = s.replace(/^客户说[：:]?\s*|^客户[：:]\s*/g, '')
  return s.trim()
}

module.exports = { PII_PATTERNS, desensitize, sanitize }
