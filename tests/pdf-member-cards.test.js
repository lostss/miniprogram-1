/**
 * PDF 成员卡片（2026-10-24）
 *
 * 与页面 chapters.member_cards 同口径：固定五行、医疗只给份数、储蓄优先年领、
 * 无保单成员照常列出。PDF 侧是独立实现（canvas 不能引前端模块），所以用行为断言钉住口径，
 * 而不是只断言"函数存在"。
 */
const { _memberCardData } = require('../cloudfunctions/reportPdf/index.js')

const MEMBERS = [
  { name: '张先生', role: '本人', age: 38 },
  { name: '母亲', role: '父母', age: 65 }
]

const ACT = [
  { insured_name: '张先生', insurance_category: '重疾险', sum_assured: 500000, annual_premium: 6000, status: 'active' },
  { insured_name: '张先生', insurance_category: '医疗险', sum_assured: 2000000, annual_premium: 800, status: 'active' },
  { insured_name: '张先生', insurance_category: '年金', sum_assured: 100000, annual_premium: 3000, annuity_payout: 12000, status: 'active' }
]

describe('_memberCardData（PDF 成员卡片）', () => {
  test('每人固定五行（意外/医疗/重疾/寿险/储蓄）', () => {
    const cards = _memberCardData(MEMBERS, ACT, ACT)
    const zs = cards.find((c) => c.title.indexOf('张先生') === 0)
    expect(zs.lines.length).toBe(5)
    expect(zs.lines[0].indexOf('意外')).toBe(0)
    expect(zs.lines[4].indexOf('储蓄')).toBe(0)
  })

  test('医疗只给份数（报销型不可加总）', () => {
    const zs = _memberCardData(MEMBERS, ACT, ACT).find((c) => c.title.indexOf('张先生') === 0)
    expect(zs.lines[1]).toContain('1 份')
    expect(zs.lines[1]).not.toContain('200万')
  })

  test('储蓄优先年领（annuity_payout）', () => {
    const zs = _memberCardData(MEMBERS, ACT, ACT).find((c) => c.title.indexOf('张先生') === 0)
    expect(zs.lines[4]).toContain('年领')
  })

  test('无保单成员照常列出（不能因为没数据就消失）', () => {
    const cards = _memberCardData(MEMBERS, ACT, ACT)
    const mom = cards.find((c) => c.title.indexOf('母亲') === 0)
    expect(mom).toBeTruthy()
    expect(mom.foot).toContain('有效 0 份')
    // 五行仍要在（固定行位置才能横着比）
    expect(mom.lines.length).toBe(5)
  })

  test('失效保单进脚注，不计入"有效 N 份"', () => {
    const all = ACT.concat([{ insured_name: '张先生', insurance_category: '重疾险', sum_assured: 150000, annual_premium: 1200, status: 'surrendered' }])
    const zs = _memberCardData(MEMBERS, ACT, all).find((c) => c.title.indexOf('张先生') === 0)
    expect(zs.foot).toContain('失效 1 份')
    expect(zs.foot).toContain('有效 3 份')
  })
})
