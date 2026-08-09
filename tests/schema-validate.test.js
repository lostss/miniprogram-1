/**
 * schema-validate + filterToolDefs 测试
 *
 * 覆盖：
 * - validateArgs：必填缺失 / 枚举非法 / 数字类型 / 未注册工具放行 / 空 defs 放行
 * - filterToolDefs：TOOL_DEFINITIONS 真实结构 {function:{name}} 下意图裁剪生效（修复 d.name 取不到 bug）
 */
jest.mock('wx-server-sdk', () => ({ database: () => ({}) }), { virtual: true })

const { validateArgs } = require('../cloudfunctions/conversationAI/schema-validate')
const { filterToolDefs } = require('../cloudfunctions/conversationAI/tool-orchestration')

const addFactDef = {
  type: 'function',
  function: {
    name: 'addFact',
    parameters: {
      type: 'object',
      properties: {
        predicate: { type: 'string', enum: ['拥有保障', '备注', '职业'] },
        objectValue: { type: 'string' },
        subjectName: { type: 'string' },
        confidence: { type: 'number' }
      },
      required: ['predicate', 'objectValue', 'subjectName']
    }
  }
}

describe('validateArgs', () => {
  test('参数完整合法 → ok', () => {
    const r = validateArgs('addFact', { predicate: '职业', objectValue: '教师', subjectName: '谢敏' }, [addFactDef])
    expect(r.ok).toBe(true)
  })

  test('缺少必填字段 → 校验失败并列出', () => {
    const r = validateArgs('addFact', { predicate: '职业', objectValue: '教师' }, [addFactDef])
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('subjectName')
  })

  test('枚举非法 → 校验失败', () => {
    const r = validateArgs('addFact', { predicate: '外星人', objectValue: 'x', subjectName: '谢敏' }, [addFactDef])
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('predicate')
  })

  test('数字字段收到非数字 → 校验失败', () => {
    const r = validateArgs('addFact', { predicate: '备注', objectValue: 'x', subjectName: '谢敏', confidence: '高' }, [addFactDef])
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('confidence')
  })

  test('未注册工具 → 放行（交由 dispatch 拒绝）', () => {
    const r = validateArgs('unknownTool', {}, [addFactDef])
    expect(r.ok).toBe(true)
  })

  test('toolDefs 为空/非数组 → 放行', () => {
    expect(validateArgs('addFact', {}, undefined).ok).toBe(true)
    expect(validateArgs('addFact', {}, null).ok).toBe(true)
  })

  test('兼容旧结构 {name}（无 function 包裹）', () => {
    const r = validateArgs('addFact', { predicate: '备注', objectValue: 'x', subjectName: '谢敏' }, [{ name: 'addFact' }])
    expect(r.ok).toBe(true)
  })
})

describe('filterToolDefs 意图裁剪（TOOL_DEFINITIONS 真实结构修复）', () => {
  const defs = [
    { type: 'function', function: { name: 'queryPolicies', parameters: {} } },
    { type: 'function', function: { name: 'queryMembers', parameters: {} } },
    { type: 'function', function: { name: 'addPolicy', parameters: {} } },
    { type: 'function', function: { name: 'addFact', parameters: {} } },
    { type: 'function', function: { name: 'updateFinances', parameters: {} } },
    { type: 'function', function: { name: 'triggerAnalysis', parameters: {} } }
  ]

  test('保单意图 → 常驻查询 + addPolicy（不含 addFact/updateFinances）', () => {
    const out = filterToolDefs(defs, '买了一份重疾险')
    const names = out.map(d => d.function.name).sort()
    expect(names).toEqual(['addPolicy', 'queryMembers', 'queryPolicies'].sort())
  })

  test('事实意图 → 常驻查询 + addFact', () => {
    const out = filterToolDefs(defs, '记一下谢敏的职业')
    const names = out.map(d => d.function.name).sort()
    expect(names).toEqual(['addFact', 'queryMembers', 'queryPolicies'].sort())
  })

  test('无意图命中 → 回退全量（保能力）', () => {
    const out = filterToolDefs(defs, '今天天气不错')
    expect(out.length).toBe(defs.length)
  })

  test('显式要求全部 → 回退全量', () => {
    const out = filterToolDefs(defs, '把所有工具都列出来')
    expect(out.length).toBe(defs.length)
  })

  test('空 defs / 空文本 → 原样返回', () => {
    expect(filterToolDefs(null, 'x')).toBeNull()
    expect(filterToolDefs(defs, '')).toEqual(defs)
  })
})
