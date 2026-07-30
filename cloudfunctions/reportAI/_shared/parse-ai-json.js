/**
 * parse-ai-json.js — AI 输出 JSON 容错解析器（前后端共用权威源）
 *
 * 设计动机：ocr-extractor 与 reportAI 各自实现了一份几乎相同的 _parseAIJSON，
 * 行为略异（ocr 版支持 [] 起始，reportAI 版只支持 {}）。本文件统一为超集实现，
 * 消除双写。两个调用方均按需消费同一事实源。
 *
 * 接口契约：
 *   parseAIJSON(text) → object | array | null
 *     - 优先 JSON.parse 直解
 *     - 失败时从首个 { 或 [ 出发，平衡括号截取后重试
 *     - 字符串中的括号不计入深度（处理嵌套字符串里的 {}）
 *     - 仍失败返回 null（由调用方降级兜底）
 */

/**
 * 平衡括号提取 JSON —— 处理嵌套 {} / [] 与首尾噪声
 * @param {string} text - AI 原始输出
 * @returns {object|array|null}
 */
function parseAIJSON(text) {
  if (!text || typeof text !== 'string') return null
  // 优先直接解析（最常见路径，零成本）
  try { return JSON.parse(text) } catch (_) {}

  // 直解失败：从首个 { 或 [ 出发（取更早出现的那个）
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  const start = (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) ? arrStart : objStart
  if (start === -1) return null

  const open = text[start]
  const close = open === '{' ? '}' : ']'

  // 字符串感知的括号平衡：避免字符串里的 { } [ ] 干扰深度计数
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inStr = false
    } else {
      if (ch === '"') inStr = true
      else if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) {
          try { return JSON.parse(text.substring(start, i + 1)) } catch (_) { return null }
        }
      }
    }
  }
  return null
}

module.exports = { parseAIJSON }
