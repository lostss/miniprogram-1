/**
 * family-compat 契约测试 — 响应向后兼容字段的单一事实源 + 测试工厂的"不可漂移"性质。
 *
 * 对应流程审计 2026-09-18 P1-3 的机制修复：原先是"handler 里各写一份 + 测试 fixture 再仿造一份"，
 * 三份之中任何一份漏字段都会造成"测试全绿、线上失效"。现在 handler 与测试工厂共用同一实现。
 */
const { applyFamilyCompat } = require('../cloudfunctions/_shared/family-compat')
const { familyResponse } = require('./helpers/family-response')
const { evaluateReadiness } = require('../cloudfunctions/_shared/readiness')

describe('family-compat — 向后兼容字段的单一实现', () => {
  test('family_name → name；financial_snapshot → family_income / debt', () => {
    const f = applyFamilyCompat({ family_name: '李阳勇家庭', financial_snapshot: { income: 30, debt: { amount: 100, type: '房贷' } } })
    expect(f.name).toBe('李阳勇家庭')
    expect(f.family_income).toBe(30)
    expect(f.debt).toEqual({ amount: 100, type: '房贷' })
  })

  test('已有值不被覆盖（幂等）', () => {
    const f = applyFamilyCompat({ name: '甲', family_income: 0, debt: { amount: 5, type: '' } })
    expect(f.name).toBe('甲')
    expect(f.family_income).toBe(0)
    expect(f.debt).toEqual({ amount: 5, type: '' })
  })

  test('缺失收入被补成 0 —— 这是**兼容层语义**（抹平"缺失"与"显式 0"），需区分时必须读原始字段', () => {
    expect(applyFamilyCompat({ family_name: 'x', financial_snapshot: {} }).family_income).toBe(0)
    expect(applyFamilyCompat({ family_name: 'x' }).family_income).toBe(0)
  })

  test('空文档原样返回', () => {
    expect(applyFamilyCompat(null)).toBe(null)
  })
})

describe('tests/helpers/family-response — 工厂复用生产实现，fixture 不可能与真实响应漂移', () => {
  test('工厂输出经过生产兼容层（name / family_income / debt 与真实 getFamily 同规则）', () => {
    const r = familyResponse({ family_name: '李阳勇家庭' })
    expect(r.name).toBe('李阳勇家庭')
    expect(r.family_income).toBe(0)
    expect(r.debt).toEqual({ amount: 0, type: '' })
  })

  test('默认挂齐 buildReportView 依赖的子集合与 report 对象', () => {
    const r = familyResponse({})
    expect(r.policies).toEqual([])
    expect(r.cashValues).toEqual([])
    expect(r.unmatchedCashValues).toEqual([])
    expect(r.report).toBeDefined()
  })

  test('把 P1-3 的失效机理钉住：按该形状重推 tier 会恒判 ok，与后端（finances 空 → degraded）不一致', () => {
    // 这不是"期望行为"，而是记录"为什么不能前端重推"：
    // 合成层把缺失收入补成 0 → readiness 的 `annual_income != null` 判为已填 → tier=ok。
    // 故 degraded 判定改由后端在生成时刻落库（readiness_tier），前端只读不推。
    const r = familyResponse({
      members: [{ name: '张三', role: '本人', birth_date: '1980-01-01' }],
      policies: [{ id: 'p1' }]
    })
    const fin = { annual_income: r.family_income, income: r.family_income }
    const tier = evaluateReadiness({ familyMeta: r, members: r.members, finances: [fin], policies: r.policies }).tier
    expect(tier).toBe('ok')

    // 后端同数据的真实输入（finances 集合为空文档数组）→ degraded
    const beTier = evaluateReadiness({ familyMeta: r, members: r.members, finances: [], policies: r.policies }).tier
    expect(beTier).toBe('degraded')
  })
})
