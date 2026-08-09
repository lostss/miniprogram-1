/**
 * upsertFinances 字段白名单 + 别名归一化测试
 *
 * 背景：对话 AI 手写 updateFinances args 字段名不可控（曾产出 liability/monthly_expense_ex_premium），
 * 透传落库导致读取端（total_debt/fixed_annual_expense）读不到 → 只更新收入。
 * 修复：upsertFinances 入口白名单 + 别名映射，非白名单字段丢弃。
 */
const mockWs = {
  silentUpdateDoc: jest.fn().mockResolvedValue({}),
  silentAdd: jest.fn().mockResolvedValue({ _id: 'fin_new' }),
  triggerHooks: jest.fn().mockResolvedValue({})
}

jest.mock('wx-server-sdk', () => ({
  init: jest.fn(),
  DYNAMIC_CURRENT_ENV: 'env-mock',
  database: jest.fn(() => ({})),
  getWXContext: jest.fn(() => ({ OPENID: 'o1' }))
}), { virtual: true })
jest.mock('../cloudfunctions/_shared/config', () => ({}))
jest.mock('../cloudfunctions/_shared/guard', () => ({
  detectInjection: jest.fn(() => ({ injected: false })),
  sanitize: jest.fn(t => t),
  checkRateLimit: jest.fn(async () => ({ allowed: true })),
  auditOutput: jest.fn(t => ({ text: t, pass: true }))
}))
jest.mock('../cloudfunctions/_shared/ai-client', () => ({ callChat: jest.fn(), callAIWithRetry: jest.fn() }))
jest.mock('../cloudfunctions/_shared/ai-gateway', () => ({}))
jest.mock('../cloudfunctions/_shared/writeSeam', () => ({
  writeSeam: () => mockWs
}))
jest.mock('../cloudfunctions/_shared/db-helpers', () => ({
  safeQuery: jest.fn(),
  getFamily: jest.fn()
}))
const { safeQuery } = require('../cloudfunctions/_shared/db-helpers')
const { upsertFinances } = require('../cloudfunctions/_shared/memberRepo')

beforeEach(() => {
  jest.clearAllMocks()
})

describe('upsertFinances - 字段归一化', () => {
  test('标准字段直通（annual_income/total_debt/fixed_annual_expense）', async () => {
    safeQuery.mockResolvedValue({ data: [] })
    const r = await upsertFinances({}, 'fam_1', 'op_1', { annual_income: 250000, total_debt: 200000, fixed_annual_expense: 96000 })
    expect(r.code).toBe(200)
    expect(mockWs.silentAdd).toHaveBeenCalledWith('finances', expect.objectContaining({
      annual_income: 250000, total_debt: 200000, fixed_annual_expense: 96000
    }))
  })

  test('A 通道别名（liability/monthly_expense_ex_premium）归一化到标准字段', async () => {
    safeQuery.mockResolvedValue({ data: [] })
    const r = await upsertFinances({}, 'fam_1', 'op_1', { annual_income: 250000, liability: 200000, monthly_expense_ex_premium: 8000 })
    expect(r.code).toBe(200)
    const added = mockWs.silentAdd.mock.calls[0][1]
    expect(added.annual_income).toBe(250000)
    expect(added.total_debt).toBe(200000)
    expect(added.fixed_annual_expense).toBe(8000)
    // 别名键不应残留
    expect(added.liability).toBeUndefined()
    expect(added.monthly_expense_ex_premium).toBeUndefined()
  })

  test('非白名单字段丢弃（防静默写脏字段）', async () => {
    safeQuery.mockResolvedValue({ data: [] })
    const r = await upsertFinances({}, 'fam_1', 'op_1', { annual_income: 100000, malicious: 'x', extra: 1 })
    expect(r.code).toBe(200)
    const added = mockWs.silentAdd.mock.calls[0][1]
    expect(added.annual_income).toBe(100000)
    expect(added.malicious).toBeUndefined()
    expect(added.extra).toBeUndefined()
  })

  test('全为无效字段 → 400 不写库', async () => {
    safeQuery.mockResolvedValue({ data: [] })
    const r = await upsertFinances({}, 'fam_1', 'op_1', { foo: 1, bar: 2 })
    expect(r.code).toBe(400)
    expect(mockWs.silentAdd).not.toHaveBeenCalled()
  })

  test('更新已存在记录（别名同样归一化）', async () => {
    safeQuery.mockResolvedValue({ data: [{ _id: 'fin_1' }] })
    const r = await upsertFinances({}, 'fam_1', 'op_1', { liability: 150000 })
    expect(r.code).toBe(200)
    expect(mockWs.silentUpdateDoc).toHaveBeenCalledWith('finances', 'fin_1', expect.objectContaining({ total_debt: 150000 }))
  })
})
