/**
 * 字段一致性测试：工具 schema（模型契约）⊆ 数据白名单（数据契约）
 *
 * 背景：income 丢失根因——新增合法字段只改 schema 忘改白名单，字段被静默拒绝。
 * 防线：断言每个写工具 schema 的 properties 字段都在对应白名单内。
 * 新增/修改集合字段时：改 schema 必改白名单，否则本测试红。
 */
const { TOOL_DEFINITIONS } = require('../cloudfunctions/conversationAI/tools')
const { _MEMBER_FIELDS, FINANCE_FIELD_MAP } = require('../cloudfunctions/conversationAI/_shared/memberRepo')
const { POLICY_EDITABLE } = require('../cloudfunctions/dataWrite/policy-write')

// 从 TOOL_DEFINITIONS 取工具 schema 的 data.properties 键
function schemaFields(toolName, paramKey) {
  const d = TOOL_DEFINITIONS.find(t => (t.function || t).name === toolName)
  const fn = d.function || d
  const props = (fn.parameters && fn.parameters.properties && fn.parameters.properties[paramKey] &&
    fn.parameters.properties[paramKey].properties) || {}
  return Object.keys(props)
}

describe('字段一致性：schema ⊆ 白名单', () => {
  test('upsertMember schema.data 字段 ⊆ _MEMBER_FIELDS', () => {
    const fields = schemaFields('upsertMember', 'data')
    const missing = fields.filter(f => !_MEMBER_FIELDS.includes(f))
    expect(missing).toEqual([]) // 漏白名单 → 列出缺失字段
  })

  test('updateFinances schema 顶层字段 ⊆ FINANCE_FIELD_MAP', () => {
    const d = TOOL_DEFINITIONS.find(t => (t.function || t).name === 'updateFinances')
    const fn = d.function || d
    const props = (fn.parameters && fn.parameters.properties) || {}
    const fields = Object.keys(props)
    const missing = fields.filter(f => !FINANCE_FIELD_MAP[f])
    expect(missing).toEqual([])
  })

  test('updatePolicy schema.data 字段 ⊆ POLICY_EDITABLE', () => {
    const fields = schemaFields('updatePolicy', 'data')
    const missing = fields.filter(f => !POLICY_EDITABLE.includes(f))
    expect(missing).toEqual([])
  })
})
