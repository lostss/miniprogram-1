/**
 * policy-status 生命周期状态单元测试
 *
 * 覆盖：
 * - 手动终止状态不被系统自动覆盖
 * - 显式 active（写入判定/手动恢复）被尊重，读取层不重算
 * - calcStatus 按保障期限判定（录入落库时使用）
 * - 到期终止(expired)保持终态
 */

const {
  calcStatus,
  ensureStatus,
  ensureStatusBatch,
  STATUS_LABELS,
  MANUAL_STATUSES,
  AUTO_STATUSES
} = require('../cloudfunctions/_shared/policy-status')

function makePolicy(overrides = {}) {
  return Object.assign({
    _id: 'p1',
    id: 'pol_1',
    family_id: 'fam1',
    product_name: '测试保单',
    insured_name: '张三',
    sum_assured: 100000,
    annual_premium: 5000,
    insurance_period: '终身',
    contract_effective_date: '2020-01-01',
    effective_date: '2020-01-01',
    insured_age: 30,
    status: 'active'
  }, overrides)
}

describe('policy-status 状态枚举', () => {
  test('状态文案包含新状态', () => {
    expect(STATUS_LABELS.lapsed).toBe('失效')
    expect(STATUS_LABELS.surrendered).toBe('退保')
    expect(STATUS_LABELS.claim_terminated).toBe('理赔终止')
    expect(STATUS_LABELS.expired).toBe('到期终止')
  })

  test('手动终止状态列表包含失效/退保/理赔终止', () => {
    expect(MANUAL_STATUSES).toEqual(expect.arrayContaining(['lapsed', 'surrendered', 'claim_terminated']))
  })

  test('系统自动状态为 expired', () => {
    expect(AUTO_STATUSES).toContain('expired')
  })
})

describe('ensureStatus 自动判断', () => {
  test('active 且未到期保持 active', () => {
    const p = makePolicy({ insurance_period: '终身' })
    const r = ensureStatus(p)
    expect(r.status).toBe('active')
  })

  test('一年期产品不因生效满一年自动过期（保证续保场景）', () => {
    const p = makePolicy({
      status: 'active',
      insurance_period: '1年',
      effective_date: '2010-01-01'
    })
    const r = ensureStatus(p)
    expect(r.status).toBe('active')
  })

  test('显式 active 被尊重，不因明确到期日自动转为 expired（手动恢复有效场景）', () => {
    const p = makePolicy({
      status: 'active',
      insurance_period: '至2020-12-31',
      effective_date: '2010-01-01'
    })
    const r = ensureStatus(p)
    expect(r.status).toBe('active')
  })

  test('calcStatus 对明确到期日仍判 expired（写入层录入时据此落库）', () => {
    const p = makePolicy({
      insurance_period: '至2020-12-31',
      effective_date: '2010-01-01'
    })
    const r = calcStatus(p)
    expect(r.status).toBe('expired')
  })

  test('手动失效状态不被自动覆盖', () => {
    const p = makePolicy({
      status: 'lapsed',
      insurance_period: '1年',
      effective_date: '2010-01-01'
    })
    const r = ensureStatus(p)
    expect(r.status).toBe('lapsed')
  })

  test('退保状态不被自动覆盖', () => {
    const p = makePolicy({ status: 'surrendered', insurance_period: '1年', effective_date: '2010-01-01' })
    const r = ensureStatus(p)
    expect(r.status).toBe('surrendered')
  })

  test('理赔终止状态不被自动覆盖', () => {
    const p = makePolicy({ status: 'claim_terminated', insurance_period: '1年', effective_date: '2010-01-01' })
    const r = ensureStatus(p)
    expect(r.status).toBe('claim_terminated')
  })

  test('expired 终态不被重算', () => {
    const p = makePolicy({ status: 'expired', insurance_period: '终身' })
    const r = ensureStatus(p)
    expect(r.status).toBe('expired')
  })
})

describe('ensureStatusBatch', () => {
  test('批量保持手动状态并自动判断 active', () => {
    const list = [
      makePolicy({ _id: 'p1', status: 'active', insurance_period: '终身' }),
      makePolicy({ _id: 'p2', status: 'lapsed', insurance_period: '1年', effective_date: '2010-01-01' }),
      makePolicy({ _id: 'p3', status: 'surrendered', insurance_period: '1年', effective_date: '2010-01-01' })
    ]
    const result = ensureStatusBatch(list)
    expect(result.map(p => p.status)).toEqual(['active', 'lapsed', 'surrendered'])
  })
})

describe('calcStatus 兼容性', () => {
  test('未知期限时返回 active 占位', () => {
    const r = calcStatus(makePolicy({ status: undefined, insurance_period: '' }))
    expect(r.status).toBe('active')
  })
})
