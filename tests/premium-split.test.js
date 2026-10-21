/**
 * 保费分布两张表（2026-10-21）
 *
 * 用户方案要求四段：成员×险种 / 公司 / 月份 / 年份。月份与年份已有，这里补前两段。
 *
 * 这张表最容易出的错**不是样式，是求和**：方案演示稿里就出现过
 * 「抬头 31,600 / 明细 26,400 / 按公司 31,600」三套数字并存的情况。
 * 所以守卫的核心是交叉求和：∑成员行 = 合计行 = 年总保费 = ∑公司。
 */
const { buildChapters } = require('../miniprogram/utils/report/chapter-builder')

const C = () => ({
  name: '张家',
  members: [
    { member_id: 'm1', name: '张先生', role: '本人', age: 38 },
    { member_id: 'm2', name: '妻子', role: '配偶', age: 35 }
  ],
  policies: [
    { id: 'p1', insured_name: '张先生', insurance_category: '重疾险', annual_premium: 6000, sum_assured: 500000, status: 'active', effective_date: '2020-01-01', insurance_period: '终身' },
    { id: 'p2', insured_name: '张先生', insurance_category: '医疗险', annual_premium: 800, sum_assured: 2000000, status: 'active', effective_date: '2025-01-01', insurance_period: '1年' },
    { id: 'p3', insured_name: '妻子', insurance_category: '重疾险', annual_premium: 3900, sum_assured: 300000, status: 'active', effective_date: '2021-01-01', insurance_period: '终身' },
    { id: 'p4', insured_name: '妻子', insurance_category: '年金', annual_premium: 3500, sum_assured: 0, status: 'active', effective_date: '2023-01-01', insurance_period: '终身' }
  ]
})

function splitBlock() {
  const ch = buildChapters(C(), {})
  const cal = ch.find((x) => x.key === 'premium_calendar')
  return cal.customBlocks.find((b) => b.t === 'premium_split')
}

describe('premium_split — 成员×险种与按公司', () => {
  test('∑成员行 === 合计，且 === 年总保费（元，整数无舍入）', () => {
    const b = splitBlock()
    const rowSum = b.memberRows.reduce((s, r) => s + Number(r.total), 0)
    expect(Number(b.memberTotal)).toBe(rowSum)
    // 4 张保单年缴 6000+800+3900+3500 = 14200 元
    expect(Number(b.memberTotal)).toBe(14200)
  })

  test('∑公司 === ∑成员（同一份数据，不允许两张表各算一套）', () => {
    const b = splitBlock()
    const insSum = b.insurerRows.reduce((s, r) => s + Number(r.premiumText), 0)
    expect(insSum).toBe(Number(b.memberTotal))
  })

  test('险种归列：年金进"储蓄"，不并入保障型；金额精确到元', () => {
    const b = splitBlock()
    const wife = b.memberRows.find((r) => r.name === '妻子')
    // 列序：意外 医疗 重疾 寿险 储蓄 其他
    expect(wife.cells[2].v).toBe('3900') // 重疾
    expect(wife.cells[4].v).toBe('3500') // 年金 → 储蓄
  })

  test('按公司：份数用独立份数（附加险不重复计）', () => {
    const c = C()
    c.policies.push({ id: 'r1', insured_name: '张先生', insurance_category: '医疗险', annual_premium: 200, policy_number: 'P1', product_name: '附加住院补贴', isRider: true, parentKey: 'p1', status: 'active', effective_date: '2020-01-01', insurance_period: '1年' })
    const ch = buildChapters(c, {})
    const b = ch.find((x) => x.key === 'premium_calendar').customBlocks.find((x) => x.t === 'premium_split')
    const ins = b.insurerRows.find((x) => x.name === '未知保司')
    // 5 条文档，其中 1 条是挂靠的附加险 → 份数 = 4
    expect(ins.count).toBe(4)
  })

  test('空家庭不崩（无有效保单时表为空但不报错）', () => {
    const ch = buildChapters({ name: '空', members: [], policies: [] }, {})
    const cal = ch.find((x) => x.key === 'premium_calendar')
    const b = cal.customBlocks.find((x) => x.t === 'premium_split')
    expect(b.memberRows).toEqual([])
    expect(Number(b.memberTotal)).toBe(0)
  })
})
