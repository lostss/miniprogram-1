/**
 * parse-expiry 保障期间解析单元测试
 * 覆盖：N天 / N个月（新增短期限）、至N岁 / 终身 / N年 / 至日期 / 老逻辑不回归
 */
const { parseExpiry } = require('../cloudfunctions/_shared/parse-expiry')

// 固定"今天"以稳定断言：构造 2026-01-15 作为生效日（eff 取生效日，不受真实 now 影响）
const EFF = '2026-01-15'

function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

describe('短期限（新增）', () => {
  test('90天：生效日起算 90 天', () => {
    const r = parseExpiry('90天', EFF, 30)
    expect(r.year).toBe(2026)
    expect(localDateStr(r.date)).toBe('2026-04-15')
  })
  test('12个月：生效日起算 12 个月', () => {
    const r = parseExpiry('12个月', EFF, 30)
    expect(r.year).toBe(2027)
    expect(localDateStr(r.date)).toBe('2027-01-15')
  })
  test('180日 别名：也识别', () => {
    const r = parseExpiry('180日', EFF, 30)
    expect(r.year).toBe(2026)
    expect(localDateStr(r.date)).toBe('2026-07-14')
  })
})

describe('常规期间（回归）', () => {
  test('30年：生效年 + 30', () => {
    const r = parseExpiry('30年', EFF, 30)
    expect(r.year).toBe(2056)
  })
  test('终身：105 岁上限推算', () => {
    const r = parseExpiry('终身', EFF, 30)
    expect(r.year).toBe(new Date(EFF).getFullYear() + 105 - 30)
  })
  test('至70岁：按被保人年龄推算（age>0）', () => {
    const r = parseExpiry('至70岁', EFF, 40)
    // 实现用真实 now 推出生年：birthYear = 今年 - 40；birthYear + 70
    expect(r.year).toBe(new Date().getFullYear() - 40 + 70)
  })
  test('至2046-12-31：直接日期', () => {
    const r = parseExpiry('至2046-12-31', EFF, 30)
    expect(r.year).toBe(2046)
    expect(localDateStr(r.date)).toBe('2046-12-31')
  })
  test('空字符串：未知', () => {
    const r = parseExpiry('', EFF, 30)
    expect(r.year).toBe(null)
  })
})
