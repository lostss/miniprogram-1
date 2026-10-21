/**
 * 附加险归属（2026-10-21）
 *
 * 前提（已核实）：本项目**按产品入库** —— 同保单号的主险与附加险是两条独立文档
 * （dataWrite/policy-write.js 的去重键是 policy_number + product_name）。
 * 所以"份数按主险计""明细缩进""甘特图不单独画条"都需要一层关系推断。
 *
 * 推断规则：同 policy_number（非空）→ 同一张保单；产品名以「附加」开头的挂到组内非附加、
 * 保额最大的那条。两条不猜的红线：没有保单号不合并；组内全是附加险不挑主险。
 */
const { linkRiders, RIDER_RE } = require('../miniprogram/utils/rider-link')

const P = (o) => Object.assign({
  id: 'x', product_name: '主险A', insurance_category: '重疾险', sum_assured: 300000,
  annual_premium: 3000, policy_number: 'P001', effective_date: '2020-01-01', status: 'active'
}, o)

describe('linkRiders — 关系推断', () => {
  test('同保单号 + 产品名以「附加」开头 → 挂到主险，份数不重复计', () => {
    const r = linkRiders([
      P({ id: 'main', product_name: 'XX终身重疾', sum_assured: 500000 }),
      P({ id: 'rider', product_name: '附加住院补贴', sum_assured: 100000 })
    ])
    const rider = r.items.find((x) => x.id === 'rider')
    expect(rider.isRider).toBe(true)
    expect(rider.parentKey).toBe('main')
    expect(r.mainCount).toBe(1)
    expect(r.riderCount).toBe(1)
    expect(r.items.find((x) => x.id === 'main').riderCount).toBe(1)
  })

  test('没有保单号 → 不合并（按同被保人/同公司猜会把 A 的附加险挂到 B 上）', () => {
    const r = linkRiders([
      P({ id: 'a', policy_number: '', product_name: 'XX重疾' }),
      P({ id: 'b', policy_number: '', product_name: '附加意外' })
    ])
    expect(r.items.find((x) => x.id === 'b').parentKey).toBe('')
    expect(r.mainCount).toBe(2) // 两条都按独立一份计
    expect(r.unlinkedRiderCount).toBe(1) // 但会标出来，进待完善
  })

  test('组内全是「附加」→ 不挑主险（宁可两条独立，也不猜谁是主险）', () => {
    const r = linkRiders([
      P({ id: 'r1', product_name: '附加A' }),
      P({ id: 'r2', product_name: '附加B' })
    ])
    expect(r.items.every((x) => x.parentKey === '')).toBe(true)
    expect(r.unlinkedRiderCount).toBe(2)
  })

  test('一张保单下多条候选主险 → 取保额最大的（并列取生效日更早）', () => {
    const r = linkRiders([
      P({ id: 'big', product_name: '主险大', sum_assured: 800000 }),
      P({ id: 'small', product_name: '主险小', sum_assured: 100000 }),
      P({ id: 'rider', product_name: '附加医疗', sum_assured: 50000 })
    ])
    expect(r.items.find((x) => x.id === 'rider').parentKey).toBe('big')
  })

  test('不同保单号不互相挂靠（各自成组）', () => {
    const r = linkRiders([
      P({ id: 'a', policy_number: 'P1', product_name: '主险1' }),
      P({ id: 'b', policy_number: 'P2', product_name: '附加X' }),
      P({ id: 'c', policy_number: 'P2', product_name: '主险2' })
    ])
    expect(r.items.find((x) => x.id === 'b').parentKey).toBe('c')
    expect(r.mainCount).toBe(2)
  })

  test('不修改入参对象（这些对象会直接进 setData）', () => {
    const input = [P({ id: 'main' }), P({ id: 'rider', product_name: '附加意外' })]
    const before = JSON.stringify(input)
    linkRiders(input)
    expect(JSON.stringify(input)).toBe(before)
  })

  test('产品名「附 加」带空格也识别；「附加险」不在开头不当作前缀匹配', () => {
    expect(RIDER_RE.test('附 加住院补贴')).toBe(true)
    const r = linkRiders([
      P({ id: 'main' }),
      P({ id: 'r', product_name: '附 加住院补贴' })
    ])
    expect(r.riderCount).toBe(1)
  })

  test('空入参不崩', () => {
    expect(linkRiders(null)).toEqual({ items: [], mainCount: 0, riderCount: 0, unlinkedRiderCount: 0 })
  })
})
