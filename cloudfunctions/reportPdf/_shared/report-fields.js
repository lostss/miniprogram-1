/**
 * report-fields.js — 报告对象字段契约（单一事实源）
 *
 * reportAI 写 families.last_* ↔ dataQuery 读前端报告 portrait/review/...
 * 改名或增删报告章节，只动此处，写入与读取自动对齐。
 * 同步脚本按闭包只把它复制到真正 require 它的云函数（reportAI / dataQuery）。
 */

const FIELD_KEYS = ['portrait', 'review', 'plan', 'suggestions', 'disclaimer', 'analysis', 'conclusion', 'summary']

// 数组型字段（AI JSON 中是 string[]，存储为 array；缺失时存空数组，避免 String([]) 退化成 'undefined'）
const ARRAY_FIELDS = ['core_insights']

// 把 AI 解析结果写入 families 的 last_* 字段
function toWriteFields(parsed) {
  const data = {}
  for (const k of FIELD_KEYS) data['last_' + k] = String((parsed && parsed[k]) || '')
  for (const k of ARRAY_FIELDS) {
    const v = parsed && parsed[k]
    data['last_' + k] = Array.isArray(v) ? v.filter(x => x).slice(0, 5) : []
  }
  return data
}

// 从 families 文档读出前端用的 no-prefix 报告对象
function toReadReport(f) {
  const r = {}
  for (const k of FIELD_KEYS) r[k] = (f && f['last_' + k]) || ''
  for (const k of ARRAY_FIELDS) r[k] = Array.isArray(f && f['last_' + k]) ? f['last_' + k] : []
  return r
}

module.exports = { FIELD_KEYS, toWriteFields, toReadReport }
