/**
 * schema-validate.js — 工具参数校验层（L3）
 *
 * 基于 tools.js TOOL_DEFINITIONS（function calling schema 单一事实源）做参数校验：
 * 必填字段、枚举取值、数字类型。校验失败 → 结构化错误 → 经 P2.5 失败回流让 AI 修正参数重试。
 *
 * 原则：校验逻辑与 schema 单一事实源绑定，不手写第二套规则。
 * 未注册工具不在此拦截（交由 dispatch 策略表拒绝）。
 */

function getDefName(def) {
  return def && def.function ? def.function.name : (def ? def.name : undefined)
}

/**
 * @param {string} toolName
 * @param {object} args
 * @param {Array} toolDefs  TOOL_DEFINITIONS（兼容 {name} 与 {function:{name}} 两种形态）
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateArgs(toolName, args, toolDefs) {
  if (!toolDefs || !Array.isArray(toolDefs)) return { ok: true, errors: [] }
  const def = toolDefs.find(d => getDefName(d) === toolName)
  if (!def) return { ok: true, errors: [] }

  const schema = (def.function && def.function.parameters) || {}
  const props = schema.properties || {}
  const required = schema.required || []
  const errors = []

  for (const key of required) {
    const v = args[key]
    if (v === undefined || v === null || v === '') {
      errors.push('缺少必填字段 ' + key)
    }
  }
  for (const key of Object.keys(props)) {
    const v = args[key]
    if (v === undefined || v === null || v === '') continue
    const spec = props[key]
    if (Array.isArray(spec.enum) && spec.enum.indexOf(v) === -1) {
      errors.push('字段 ' + key + ' 取值非法：' + v + '（可选：' + spec.enum.join('/') + '）')
    }
    if (spec.type === 'number' && isNaN(Number(v))) {
      errors.push('字段 ' + key + ' 应为数字，收到 ' + typeof v)
    }
  }

  return { ok: errors.length === 0, errors }
}

module.exports = { validateArgs }
