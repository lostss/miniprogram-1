/**
 * calcAge 纯函数测试
 * RED phase
 */
const { calcAge } = require('../cloudfunctions/_shared/calc-age')

describe('calcAge', () => {
  test('空输入返回null', () => {
    expect(calcAge('')).toBeNull()
    expect(calcAge(null)).toBeNull()
    expect(calcAge(undefined)).toBeNull()
  })

  test('无效日期返回null', () => {
    expect(calcAge('invalid')).toBeNull()
    expect(calcAge('2025-13-01')).toBeNull()
    expect(calcAge('not-a-date')).toBeNull()
  })

  test('正常计算出周岁', () => {
    // 1990-01-01 出生，现在约 36 岁（2026年）
    const age = calcAge('1990-01-01')
    expect(age).toMatch(/^\d+岁$/)
    const num = parseInt(age, 10)
    expect(num).toBeGreaterThanOrEqual(35)
    expect(num).toBeLessThanOrEqual(37)
  })

  test('年龄格式为"N岁"', () => {
    const age = calcAge('2000-06-15')
    expect(age).toMatch(/^\d+岁$/)
  })

  test('生日已过算满周岁', () => {
    // 生日在1月1日，当前6月，应已满周岁
    const age = calcAge('2000-01-01')
    const num = parseInt(age, 10)
    // 2026年6月 - 2000 = 26岁（生日已过）
    expect(num).toBeGreaterThanOrEqual(26)
    expect(num).toBeLessThanOrEqual(27)
  })

  test('生日未到减一岁', () => {
    // 生日在12月31日，当前6月，应未满周岁
    const age = calcAge('2000-12-31')
    const num = parseInt(age, 10)
    // 2026年6月11日 - 2000年12月31日 = 25岁（未满26）
    expect(num).toBeGreaterThanOrEqual(25)
    expect(num).toBeLessThanOrEqual(26)
  })

  test('不同日期格式', () => {
    expect(calcAge('1990/01/01')).not.toBeNull()
    expect(calcAge('January 1, 1990')).not.toBeNull()
  })

  test('未来日期返回负数岁', () => {
    const age = calcAge('2050-01-01')
    expect(age).toMatch(/^-?\d+岁$/)
    const num = parseInt(age, 10)
    expect(num).toBeLessThan(0)
  })
})
