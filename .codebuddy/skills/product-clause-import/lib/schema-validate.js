/**
 * schema-validate.js — 校验 AI 概念化输出（产品条款导入 skill）
 *
 * 规则：字段必须来自概念字典键；值允许 null（未找到，不编造）；未知键收集到 unrecognized；非法类型标记 error。
 */
const { CONCEPT_DICT } = require('./concept-dict')

function validateProduct(productJson) {
  const errors = []
  const unrecognized = []
  const knownKeys = new Set(
    Object.values(CONCEPT_DICT.categories).flatMap(c => Object.keys(c.concepts))
  )
  if (!productJson || typeof productJson !== 'object') return { valid: false, errors: ['非对象输出'], unrecognized: [] }

  for (const k of Object.keys(productJson)) {
    if (!knownKeys.has(k)) { unrecognized.push(k); continue }
    const v = productJson[k]
    if (v === null || v === undefined || v === '') continue // null/空 = 未找到，合法
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      errors.push(k + ': 非法类型 ' + typeof v)
    }
  }
  return { valid: errors.length === 0, errors: errors, unrecognized: unrecognized }
}

module.exports = { validateProduct }
