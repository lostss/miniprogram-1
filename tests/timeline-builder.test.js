/**
 * timeline-builder.test.js — 保障关键时点时间轴（含现价回本节点）
 */
const { buildTimeline, findBreakEvenYear } = require('../miniprogram/utils/report/timeline-builder')

describe('findBreakEvenYear（现价=已缴保费年份）', () => {
  test('每万元表值 × 保额比例 scale 达累计保费 → 返回保单年度', () => {
    const p = { sum_assured: 500000, annual_premium: 10000 } // 50万保额 → scale=50
    const cv = { cash_values: [{ y: 1, v: 100 }, { y: 2, v: 400 }, { y: 10, v: 2000 }] }
    // y=1: 100×50=5000 < 10000；y=2: 400×50=20000 >= 20000 → 回本 y=2
    expect(findBreakEvenYear(p, cv)).toBe(2)
  })

  test('永不回本 / 无现价表 / 无保额 → null', () => {
    expect(findBreakEvenYear({ sum_assured: 500000, annual_premium: 10000 }, { cash_values: [{ y: 50, v: 1 }] })).toBe(null)
    expect(findBreakEvenYear({ sum_assured: 500000, annual_premium: 10000 }, null)).toBe(null)
    expect(findBreakEvenYear({ annual_premium: 10000 }, { cash_values: [{ y: 1, v: 5000 }] })).toBe(null)
    expect(findBreakEvenYear({ sum_assured: 500000, annual_premium: 0 }, { cash_values: [{ y: 1, v: 5000 }] })).toBe(null)
  })
})

describe('buildTimeline 现价回本节点', () => {
  const policy = {
    id: 'pol_001',
    product_name: '金瑞人生',
    insured_name: '李阳勇',
    sum_assured: 500000,
    annual_premium: 10000,
    effective_date: '2026-06-15'
  }

  test('回本在未来的自然年 → 注入 breakeven 节点（生效年 + 保单年度-1）', () => {
    const cv = [{ policy_id: 'pol_001', cash_values: [{ y: 1, v: 100 }, { y: 2, v: 400 }] }]
    const events = buildTimeline([policy], [], cv)
    const be = events.find(e => e.type === 'breakeven')
    expect(be).toBeDefined()
    expect(be.y).toBe(2027) // 2026 + (2-1)
    expect(be.label).toContain('现价回本')
  })

  test('已回本（自然年 ≤ 今年）→ 不显示', () => {
    // 回本 y=1 → 自然年=2026（当年），不注入
    const cv = [{ policy_id: 'pol_001', cash_values: [{ y: 1, v: 5000 }] }]
    const events = buildTimeline([policy], [], cv)
    expect(events.find(e => e.type === 'breakeven')).toBeUndefined()
  })

  test('现价表未关联该保单 → 无 breakeven 节点', () => {
    const cv = [{ policy_id: 'other_id', cash_values: [{ y: 2, v: 400 }] }]
    const events = buildTimeline([policy], [], cv)
    expect(events.find(e => e.type === 'breakeven')).toBeUndefined()
  })

  test('不传 cashValues（无现价表）→ 行为与旧版一致', () => {
    const events = buildTimeline([policy], [])
    expect(events.find(e => e.type === 'breakeven')).toBeUndefined()
  })
})
