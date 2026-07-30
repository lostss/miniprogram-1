/**
 * v2-context 单元测试 — buildFamilyContext 场景化裁剪契约
 *
 * 被测对象：cloudfunctions/conversationAI/_shared/v2-context.js
 * 设计契约（来自源文件注释 + 接口说明）：
 *   - 返回 { markdown, familyMeta, birthMap, datasets }
 *   - 5 场景：list / conversation / analysis(默认) / report / tool
 *   - familyMeta 仅暴露白名单字段（family_id/family_name/last_analysis_at/
 *     last_summary/last_conclusion/financial_snapshot/engagement_stage）
 *   - birthMap 始终填充（memberId → birth_date）
 *   - datasets 按场景填充：report 暴露 facts/cashValues；tool 暴露 members/finances
 *
 * Mock 策略：calc-age / db-helpers / familyPortrait 全部 mock，db 通过 _data 字段提供数据
 */
const { buildFamilyContext } = require('../cloudfunctions/conversationAI/_shared/v2-context')

jest.mock('../cloudfunctions/conversationAI/_shared/calc-age', () => ({
  calcAge: jest.fn(() => 35)
}))
jest.mock('../cloudfunctions/conversationAI/_shared/db-helpers', () => ({
  safeQuery: jest.fn((db, collection, where, openid, opts) =>
    Promise.resolve({ data: db._data[collection] || [] })
  ),
  getFamily: jest.fn((db, familyId, openid) =>
    Promise.resolve((db._data.families || []).find(f => f._id === familyId) || null)
  )
}))
jest.mock('../cloudfunctions/conversationAI/_shared/familyPortrait', () => ({
  buildPortrait: jest.fn((members, facts) => ({ members, facts, _mock: true })),
  renderPortraitMarkdown: jest.fn(() => '## 画像内容\n张三 经济支柱 35岁')
}))

const { safeQuery } = require('../cloudfunctions/conversationAI/_shared/db-helpers')
const { renderPortraitMarkdown } = require('../cloudfunctions/conversationAI/_shared/familyPortrait')

function makeDb(data) {
  return { _data: data }
}

const BASE_FAMILY = {
  _id: 'f1',
  family_name: '张家',
  last_analysis_at: '2025-01-01T00:00:00Z',
  last_summary: '家庭保障评估摘要',
  last_conclusion: '家庭保障结论',
  financial_snapshot: { income: '30', debt: { amount: '50', type: '房贷' } },
  engagement_stage: 'analyzed',
  // 非白名单字段（不应泄露到 familyMeta）
  created_at: '2024-01-01',
  _openid: 'openid1',
  extra_field: 'should_not_leak'
}

const BASE_MEMBERS = [
  { _id: 'm1', member_id: 'm1', name: '张三', role: '本人', birth_date: '1990-01-01', gender: '男', health: '良好', occupation: '工程师', income: 30 },
  { _id: 'm2', member_id: 'm2', name: '李四', role: '家庭成员', birth_date: '1995-05-05', gender: '女', health: '健康', occupation: '教师', income: 10 },
  { _id: 'm3', member_id: 'm3', name: '王五', role: '家庭成员', birth_date: '1960-01-01', gender: '男', health: '一般', occupation: '退休' }
]

const BASE_FINANCES = [
  { _id: 'fin1', family_id: 'f1', annual_income: '30', total_debt: '50', fixed_annual_expense: '8', debt_type: '房贷' }
]

describe('buildFamilyContext — 返回契约', () => {
  beforeEach(() => jest.clearAllMocks())

  test('1. 返回 4 字段且类型正确（list 场景）', async () => {
    const db = makeDb({ families: [BASE_FAMILY], members: BASE_MEMBERS, finances: BASE_FINANCES })
    const result = await buildFamilyContext(db, 'f1', 'openid1', 'list')
    expect(result).toHaveProperty('markdown')
    expect(result).toHaveProperty('familyMeta')
    expect(result).toHaveProperty('birthMap')
    expect(result).toHaveProperty('datasets')
    expect(typeof result.markdown).toBe('string')
    expect(result.birthMap).toBeInstanceOf(Map)
    expect(typeof result.datasets).toBe('object')
    expect(result.datasets).not.toBeNull()
  })

  test('2. familyMeta 仅暴露白名单字段', async () => {
    const db = makeDb({ families: [BASE_FAMILY], members: BASE_MEMBERS, finances: BASE_FINANCES })
    const { familyMeta } = await buildFamilyContext(db, 'f1', 'openid1', 'list')
    expect(familyMeta).not.toBeNull()
    const allowedKeys = [
      'family_id', 'family_name', 'last_analysis_at',
      'last_summary', 'last_conclusion', 'financial_snapshot', 'engagement_stage'
    ]
    Object.keys(familyMeta).forEach(k => {
      expect(allowedKeys).toContain(k)
    })
    // 非白名单字段不应泄露
    expect(familyMeta).not.toHaveProperty('created_at')
    expect(familyMeta).not.toHaveProperty('_openid')
    expect(familyMeta).not.toHaveProperty('extra_field')
    // 白名单字段值正确
    expect(familyMeta.family_id).toBe('f1')
    expect(familyMeta.family_name).toBe('张家')
    expect(familyMeta.last_analysis_at).toBe('2025-01-01T00:00:00Z')
    expect(familyMeta.last_summary).toBe('家庭保障评估摘要')
    expect(familyMeta.last_conclusion).toBe('家庭保障结论')
    expect(familyMeta.engagement_stage).toBe('analyzed')
    expect(familyMeta.financial_snapshot).toEqual({ income: '30', debt: { amount: '50', type: '房贷' } })
  })

  test('3. birthMap 派生 memberId → birth_date', async () => {
    const db = makeDb({ families: [BASE_FAMILY], members: BASE_MEMBERS, finances: BASE_FINANCES })
    const { birthMap } = await buildFamilyContext(db, 'f1', 'openid1', 'list')
    expect(birthMap).toBeInstanceOf(Map)
    expect(birthMap.size).toBe(3)
    expect(birthMap.get('m1')).toBe('1990-01-01')
    expect(birthMap.get('m2')).toBe('1995-05-05')
    expect(birthMap.get('m3')).toBe('1960-01-01')
  })
})

describe('list 场景', () => {
  beforeEach(() => jest.clearAllMocks())

  test('4. 简化成员表：只渲染 _id/member_id/name/role，不渲染其他字段', async () => {
    const db = makeDb({ families: [BASE_FAMILY], members: BASE_MEMBERS, finances: BASE_FINANCES })
    const { markdown } = await buildFamilyContext(db, 'f1', 'openid1', 'list')
    // 应包含 name 和 role
    expect(markdown).toContain('张三')
    expect(markdown).toContain('李四')
    expect(markdown).toContain('王五')
    // 不应包含原始 health/occupation/birth_date/income 值（list 场景映射时已剥离）
    expect(markdown).not.toContain('良好')
    expect(markdown).not.toContain('工程师')
    expect(markdown).not.toContain('1990-01-01')
    expect(markdown).not.toContain('30万')
    expect(markdown).not.toContain('10万')
  })

  test('5. 不查 facts 集合', async () => {
    const db = makeDb({
      families: [BASE_FAMILY],
      members: BASE_MEMBERS,
      finances: BASE_FINANCES,
      facts: [],
      policy_cash_values: []
    })
    await buildFamilyContext(db, 'f1', 'openid1', 'list')
    const collections = safeQuery.mock.calls.map(c => c[1])
    expect(collections).not.toContain('facts')
    expect(collections).not.toContain('policy_cash_values')
    // list 场景应查 members 和 finances（基础层并行加载）
    expect(collections).toContain('members')
    expect(collections).toContain('finances')
  })
})

describe('conversation 场景', () => {
  beforeEach(() => jest.clearAllMocks())

  test('6. markdown 含标题 + 画像 + 经济状况表', async () => {
    const db = makeDb({ families: [BASE_FAMILY], members: BASE_MEMBERS, finances: BASE_FINANCES, facts: [] })
    const { markdown } = await buildFamilyContext(db, 'f1', 'openid1', 'conversation')
    expect(markdown).toContain('# 家庭保障档案')
    expect(markdown).toContain('## 画像内容')
    expect(markdown).toContain('## 经济状况')
    // last_conclusion 作为引用注入
    expect(markdown).toContain('家庭保障结论')
  })

  test('7. 查 facts 且 where 含 status:active', async () => {
    const db = makeDb({ families: [BASE_FAMILY], members: BASE_MEMBERS, finances: BASE_FINANCES, facts: [] })
    await buildFamilyContext(db, 'f1', 'openid1', 'conversation')
    const factsCall = safeQuery.mock.calls.find(c => c[1] === 'facts')
    expect(factsCall).toBeDefined()
    expect(factsCall[2]).toMatchObject({ family_id: 'f1', status: 'active' })
  })

  test('8. datasets 为空（无 facts/cashValues/members/finances）', async () => {
    const db = makeDb({ families: [BASE_FAMILY], members: BASE_MEMBERS, finances: BASE_FINANCES, facts: [] })
    const { datasets } = await buildFamilyContext(db, 'f1', 'openid1', 'conversation')
    expect(datasets.facts).toBeUndefined()
    expect(datasets.cashValues).toBeUndefined()
    expect(datasets.members).toBeUndefined()
    expect(datasets.finances).toBeUndefined()
  })

  test('conversation 场景 buildPortrait compact:true', async () => {
    const db = makeDb({ families: [BASE_FAMILY], members: BASE_MEMBERS, finances: BASE_FINANCES, facts: [] })
    await buildFamilyContext(db, 'f1', 'openid1', 'conversation')
    expect(renderPortraitMarkdown).toHaveBeenCalled()
    const opts = renderPortraitMarkdown.mock.calls[0][1]
    expect(opts).toEqual({ compact: true })
  })
})

describe('report 场景', () => {
  beforeEach(() => jest.clearAllMocks())

  test('9. datasets.facts + cashValues 填充', async () => {
    const facts = [
      { _id: 'fact1', family_id: 'f1', subject: 'm1', predicate: '寿险保额', object_value: '100万', status: 'active' }
    ]
    const cashValues = [
      { _id: 'cv1', family_id: 'f1', product_name: '金佑人生', insured_name: '张三', total_years: 20, cash_values: [{ y: 1, v: 5000 }, { y: 2, v: 10000 }] }
    ]
    const db = makeDb({
      families: [BASE_FAMILY],
      members: BASE_MEMBERS,
      finances: BASE_FINANCES,
      facts,
      policy_cash_values: cashValues
    })
    const { datasets } = await buildFamilyContext(db, 'f1', 'openid1', 'report')
    expect(Array.isArray(datasets.facts)).toBe(true)
    expect(datasets.facts.length).toBe(1)
    expect(datasets.facts[0]._id).toBe('fact1')
    expect(Array.isArray(datasets.cashValues)).toBe(true)
    expect(datasets.cashValues.length).toBe(1)
    expect(datasets.cashValues[0]._id).toBe('cv1')
  })

  test('10. markdown 含现金价值表', async () => {
    const cashValues = [
      { _id: 'cv1', family_id: 'f1', product_name: '金佑人生', insured_name: '张三', total_years: 20, cash_values: [{ y: 1, v: 5000 }, { y: 2, v: 10000 }] }
    ]
    const db = makeDb({
      families: [BASE_FAMILY],
      members: BASE_MEMBERS,
      finances: BASE_FINANCES,
      facts: [],
      policy_cash_values: cashValues
    })
    const { markdown } = await buildFamilyContext(db, 'f1', 'openid1', 'report')
    expect(markdown).toContain('## 保单现价数据')
    expect(markdown).toContain('金佑人生')
    expect(markdown).toContain('张三')
  })

  test('report 场景 buildPortrait compact:false', async () => {
    const db = makeDb({
      families: [BASE_FAMILY],
      members: BASE_MEMBERS,
      finances: BASE_FINANCES,
      facts: [],
      policy_cash_values: []
    })
    await buildFamilyContext(db, 'f1', 'openid1', 'report')
    expect(renderPortraitMarkdown).toHaveBeenCalled()
    const opts = renderPortraitMarkdown.mock.calls[0][1]
    expect(opts).toEqual({ compact: false })
  })
})

describe('tool 场景', () => {
  beforeEach(() => jest.clearAllMocks())

  test('11. datasets.members + finances 填充，deleted 成员被过滤', async () => {
    const membersWithDeleted = [
      ...BASE_MEMBERS,
      { _id: 'm4', member_id: 'm4', name: '赵六', role: '家庭成员', birth_date: '2000-01-01', status: 'deleted' }
    ]
    const db = makeDb({
      families: [BASE_FAMILY],
      members: membersWithDeleted,
      finances: BASE_FINANCES,
      facts: []
    })
    const { datasets } = await buildFamilyContext(db, 'f1', 'openid1', 'tool')
    expect(Array.isArray(datasets.members)).toBe(true)
    // deleted 成员被过滤
    expect(datasets.members.find(m => m._id === 'm4')).toBeUndefined()
    expect(datasets.members.length).toBe(3)
    expect(Array.isArray(datasets.finances)).toBe(true)
    expect(datasets.finances.length).toBe(1)
    expect(datasets.finances[0]._id).toBe('fin1')
  })

  test('12. markdown 含冲突检测成员表 + 报告结论摘要', async () => {
    const db = makeDb({ families: [BASE_FAMILY], members: BASE_MEMBERS, finances: BASE_FINANCES, facts: [] })
    const { markdown } = await buildFamilyContext(db, 'f1', 'openid1', 'tool')
    expect(markdown).toContain('## 成员数据（冲突检测用）')
    expect(markdown).toContain('## 报告结论（供引用，禁止照抄）')
    expect(markdown).toContain('**摘要**：家庭保障评估摘要')
    expect(markdown).toContain('**结论**：家庭保障结论')
  })
})

describe('默认/analysis 场景', () => {
  beforeEach(() => jest.clearAllMocks())

  test('13. 仅基础 markdown（标题 + 经济状况表），无画像/成员表/报告结论', async () => {
    const db = makeDb({ families: [BASE_FAMILY], members: BASE_MEMBERS, finances: BASE_FINANCES, facts: [] })
    const { markdown } = await buildFamilyContext(db, 'f1', 'openid1', 'analysis')
    expect(markdown).toContain('# 家庭保障档案')
    expect(markdown).toContain('## 经济状况')
    // 不应含画像/成员表/报告结论/现价数据
    expect(markdown).not.toContain('## 画像内容')
    expect(markdown).not.toContain('## 成员数据（冲突检测用）')
    expect(markdown).not.toContain('## 报告结论（供引用，禁止照抄）')
    expect(markdown).not.toContain('## 保单现价数据')
  })
})

describe('边界场景', () => {
  beforeEach(() => jest.clearAllMocks())

  test('14. family 不存在 → 不抛错，familyMeta 为默认值对象', async () => {
    // 注意：源码 buildFamilyContext 第 114 行 `getFamily(...).then(f => f || {})` 会把 null 强转为 {}，
    // _deriveFamilyMeta({}) 返回默认值对象（family_id: undefined 等），而非 null。
    // 此处按源码实际行为验证：不抛错 + familyMeta 非空但字段为默认值。
    const db = makeDb({ families: [], members: BASE_MEMBERS, finances: BASE_FINANCES })
    const result = await buildFamilyContext(db, 'not_exist', 'openid1', 'conversation')
    expect(result.familyMeta).not.toBeNull()
    expect(result.familyMeta.family_id).toBeUndefined()
    expect(result.familyMeta.family_name).toBe('')
    expect(result.familyMeta.last_analysis_at).toBeNull()
    expect(typeof result.markdown).toBe('string')
  })

  test('15. members 为空（list 场景）→ markdown 为空字符串', async () => {
    const db = makeDb({ families: [BASE_FAMILY], members: [], finances: BASE_FINANCES })
    const { markdown } = await buildFamilyContext(db, 'f1', 'openid1', 'list')
    expect(markdown).toBe('')
  })

  test('16. finances 为空 + 无 financial_snapshot → 不含 ## 经济状况', async () => {
    const familyNoSnap = {
      _id: 'f1',
      family_name: '张家',
      last_conclusion: '结论内容'
      // 无 financial_snapshot
    }
    const db = makeDb({ families: [familyNoSnap], members: BASE_MEMBERS, finances: [] })
    const { markdown } = await buildFamilyContext(db, 'f1', 'openid1', 'analysis')
    expect(markdown).not.toContain('## 经济状况')
    // 标题和 last_conclusion 仍应存在
    expect(markdown).toContain('# 家庭保障档案')
    expect(markdown).toContain('结论内容')
  })
})
