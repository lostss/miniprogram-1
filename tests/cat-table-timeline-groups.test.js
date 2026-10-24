/**
 * 分险种保额合计表 + 节点清单分组（2026-10-21，方案第一部分第 3 项 / 第四部分第 9 项）
 *
 * 两条都是"方案里缺的表格"，本次补齐。守卫重点：
 *   ① 医疗（报销型）与储蓄型**不得**给出保额合计（会把报销上限读成可领取金额）
 *   ② 份数按主险计，附加险以"含附加 N 项"括注
 *   ③ 节点清单按"距今"分三组（+已过），不分组时退回平铺
 */
const { buildReportView } = require('../miniprogram/utils/report-builder')

const thisYear = new Date().getFullYear()

function C() {
  return {
    name: '张家',
    members: [
      { member_id: 'm1', name: '张先生', role: '本人', age: 38 },
      { member_id: 'm2', name: '妻子', role: '配偶', age: 35 }
    ],
    policies: [
      { id: 'p1', member_id: 'm1', insured_name: '张先生', insurance_category: '重疾险', sum_assured: 500000, annual_premium: 6000, status: 'active', effective_date: (thisYear - 6) + '-01-01', insurance_period: '终身' },
      { id: 'p2', member_id: 'm2', insured_name: '妻子', insurance_category: '重疾险', sum_assured: 300000, annual_premium: 3900, status: 'active', effective_date: (thisYear - 4) + '-01-01', insurance_period: '终身' },
      { id: 'p3', member_id: 'm1', insured_name: '张先生', insurance_category: '医疗险', sum_assured: 2000000, annual_premium: 800, status: 'active', effective_date: (thisYear - 1) + '-01-01', insurance_period: '1年' },
      { id: 'p4', member_id: 'm2', insured_name: '妻子', insurance_category: '年金', sum_assured: 0, annual_premium: 3500, status: 'active', effective_date: (thisYear - 2) + '-01-01', insurance_period: '终身' },
      // 附加险：挂 p1，份数不重复计
      { id: 'r1', member_id: 'm1', insured_name: '张先生', insurance_category: '重疾险', sum_assured: 150000, annual_premium: 1200, status: 'active', effective_date: (thisYear - 6) + '-01-01', insurance_period: '终身', policy_number: 'P1', product_name: '附加重疾', isRider: true, parentKey: 'p1' }
    ]
  }
}

function catBlock() {
  const view = buildReportView(C(), {})
  const ch = view.chapters.find((x) => x.key === 'coverage_summary')
  return ch.customBlocks.find((b) => b.t === 'cat_table')
}

describe('分险种保额合计表', () => {
  test('重疾列合计成员保额（含附加险保额），份数按主险计', () => {
    const b = catBlock()
    const ci = b.rows.find((r) => r.cat === '重疾')
    expect(ci.sumText).toBe('95万') // 50 + 30 + 15（附加）
    expect(ci.countText).toBe('2（含附加 1 项）')
    expect(ci.membersText).toContain('张先生')
  })

  test('医疗险不给保额合计（报销型），只给份数与覆盖成员', () => {
    const mi = catBlock().rows.find((r) => r.cat === '医疗')
    expect(mi.sumText).toBe('—')
    expect(mi.note).toContain('报销型')
    expect(mi.membersText).toBe('张先生')
  })

  test('储蓄型（年金）同样不汇总保额', () => {
    const an = catBlock().rows.find((r) => r.cat === '储蓄')
    expect(an.sumText).toBe('—')
    expect(an.note).toContain('储蓄型')
  })

  test('没有保单的险种不出现（不制造空行）', () => {
    expect(catBlock().rows.some((r) => r.cat === '意外')).toBe(false)
  })
})

describe('节点清单按距今分组', () => {
  function tlBlock() {
    const view = buildReportView(C(), {})
    return view.chapters.find((x) => x.key === 'premium_timeline').customBlocks.find((b) => b.t === 'timeline')
  }

  test('分组顺序固定：未来 12 个月 → 中期 → 长期（已过单独一组）', () => {
    const b = tlBlock()
    const titles = b.groups.map((g) => g.title)
    const want = ['未来 12 个月', '中期（1–5 年）', '长期（5 年以上）', '已过（核对状态）']
    // 只断言相对顺序（本次数据有哪些组取决于保单）
    const idx = titles.map((t) => want.indexOf(t))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect(idx.slice().sort((a, b2) => a - b2)).toEqual(idx)
  })

  test('每组内的年份都落在该组的区间里（分组不能错位）', () => {
    const b = tlBlock()
    b.groups.forEach((g) => {
      g.items.forEach((it) => {
        if (g.key === 'now') expect(it.y).toBeLessThanOrEqual(thisYear + 1)
        if (g.key === 'mid') expect(it.y).toBeGreaterThan(thisYear + 1)
        if (g.key === 'far') expect(it.y).toBeGreaterThan(thisYear + 5)
      })
    })
  })

  test('原生 items 仍保留（组件在老数据/无分组时可退回平铺）', () => {
    const b = tlBlock()
    expect(Array.isArray(b.items)).toBe(true)
    expect(b.groups.reduce((s, g) => s + g.items.length, 0)).toBe(b.items.length)
  })
})
