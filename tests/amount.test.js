// 金额单位契约测试（架构审计 #3：fmtYuan 精度统一 2 位，与 yuanToWan 同构）
const { yuanToWan, wanToYuan, fmtYuan } = require('../miniprogram/utils/amount')

describe('amount 金额契约', () => {
  test('yuanToWan：元→万 保留 2 位', () => {
    expect(yuanToWan(10000)).toBe(1)
    expect(yuanToWan(123456)).toBe(12.35)   // 12345.6/10000 → round 2
    expect(yuanToWan(1234500)).toBe(123.45) // 123.45 万
    expect(yuanToWan(0)).toBe(0)
    expect(yuanToWan('20000')).toBe(2)
  })

  test('wanToYuan：万→元', () => {
    expect(wanToYuan(1)).toBe(10000)
    expect(wanToYuan(12.35)).toBe(123500)
    expect(wanToYuan(0)).toBe(0)
  })

  test('fmtYuan 精度与 yuanToWan 一致（2 位，无 1/2 位漂移）', () => {
    // 关键断言：x 位小数 = yuanToWan 输出，且整万不带小数
    expect(fmtYuan(10000)).toBe('1万')
    expect(fmtYuan(123456)).toBe('12.35万')
    expect(fmtYuan(1234500)).toBe('123.45万')
    expect(fmtYuan(2000000)).toBe('200万')
    // 万元精度统一：与 yuanToWan 字符串一致
    const v = 123456
    expect(fmtYuan(v).replace('万', '')).toBe(String(yuanToWan(v)))
  })

  test('fmtYuan 小于 1 万显示原元', () => {
    expect(fmtYuan(0)).toBe('0元')
    expect(fmtYuan(9999)).toBe('9999元')
    expect(fmtYuan(8000)).toBe('8000元')
  })

  test('fmtYuan NaN/缺省语义', () => {
    expect(fmtYuan(NaN)).toBe('NaN')
    // 非数字字符串：返回原值（String(v)），"未知"映射由调用方（如 chapter-builder._fmtAmount）外层处理
    expect(fmtYuan('abc')).toBe('abc')
  })
})
