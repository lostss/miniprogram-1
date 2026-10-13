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

  // 2026-09-20（复核批次 A）：setMonth 的日期溢出。
  // 原实现 `dm2.setMonth(getMonth()+nm)` 会把"该月不存在的日期"向后溢出：
  // 2026-01-31 + 1 个月 → 2026-03-03（凭空多 3 天）。改为"对应日；该月无此日则取月末"。
  test('1个月：生效日 31 日、目标月无 31 日 → 取该月最后一天（不溢出到下月）', () => {
    const r = parseExpiry('1个月', '2026-01-31', 30)
    expect(r.year).toBe(2026)
    expect(localDateStr(r.date)).toBe('2026-02-28')
  })

  test('1个月：闰年 2 月 → 取 29 日', () => {
    const r = parseExpiry('1个月', '2028-01-31', 30)
    expect(localDateStr(r.date)).toBe('2028-02-29')
  })

  test('1个月：3 月 31 日 → 4 月 30 日', () => {
    const r = parseExpiry('1个月', '2026-03-31', 30)
    expect(localDateStr(r.date)).toBe('2026-04-30')
  })

  test('1个月：目标月存在同日 → 保持同日（修复不影响常规情形）', () => {
    const r = parseExpiry('1个月', '2026-01-15', 30)
    expect(localDateStr(r.date)).toBe('2026-02-15')
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
