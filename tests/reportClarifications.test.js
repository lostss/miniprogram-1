/**
 * reportAI 待澄清项挑选（2026-09-19）。
 *
 * 背景：`clarifications` 原为 `readiness.missing.slice(0, 5)`，而 missing 按「成员 → 财务」排列。
 * P1-2 起投保人/受益人也建档，成员数变多 → 前 5 条可能全是"某某缺性别/职业/健康"，
 * 把「家庭年收入未填写」挤出列表，而那正是 degraded/定性模式的信号。
 * 实测（4 成员家庭）：missing 共 11 条，原样 slice(0,5) 收入锚点不在列。
 */
jest.mock('wx-server-sdk', () => ({
  init: jest.fn(),
  DYNAMIC_CURRENT_ENV: 'env-mock',
  database: jest.fn(() => ({ collection: jest.fn(() => ({})) })),
  getWXContext: jest.fn(() => ({ OPENID: 'o1' }))
}))

const { _pickClarifications } = require('../cloudfunctions/reportAI/index')
const { evaluateReadiness } = require('../cloudfunctions/_shared/readiness')

const PILLAR = { member_id: 'm1', name: '张三', role: '本人', age: 35, gender: '男', occupation: '工程师', health: '良好' }
const SPOUSE = { member_id: 'm2', name: '谢敏', role: '配偶', age: 33 }
const KID = { member_id: 'm3', name: '小明', role: '子女', age: 8 }
const HOLDER = { member_id: 'm4', name: '王芳', role: '', age: 40 }

function readiness() {
  return evaluateReadiness({
    familyMeta: {},
    members: [PILLAR, SPOUSE, KID, HOLDER],
    finances: [],
    policies: [{ _id: 'p1', product_name: '康宁', sum_assured: 50, member_id: 'm1' }]
  })
}

describe('reportAI 待澄清项挑选', () => {
  test('前置事实：该家庭确实处于 degraded，且原样 slice(0,5) 会挤掉金融锚点', () => {
    const r = readiness()
    expect(r.tier).toBe('degraded')
    expect(r.missing.length).toBeGreaterThan(5)
    expect(r.missing.slice(0, 5).some(x => x.field === 'finance.annual_income')).toBe(false)
  })

  test('金融锚点保底在列（非成员类优先）', () => {
    const picked = _pickClarifications(readiness().missing, 5)
    expect(picked.map(x => x.field)).toContain('finance.annual_income')
  })

  test('同类去重：同一字段类型只留一条（不再一人连占三行）', () => {
    const picked = _pickClarifications(readiness().missing, 5)
    const kinds = picked.map(x => String(x.field).split('.').pop())
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  test('总量不超过上限', () => {
    expect(_pickClarifications(readiness().missing, 5).length).toBeLessThanOrEqual(5)
    expect(_pickClarifications(readiness().missing, 2).length).toBeLessThanOrEqual(2)
  })

  test('缺省/空输入安全', () => {
    expect(_pickClarifications(undefined, 5)).toEqual([])
    expect(_pickClarifications([], 5)).toEqual([])
  })
})
