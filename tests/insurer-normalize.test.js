/**
 * insurer-normalize 单测 — 保险公司简称归一（寿险主体）
 */
const { normalizeInsurer } = require('../cloudfunctions/_shared/insurer-normalize')

describe('normalizeInsurer — 全称 → 统一简称', () => {
  test('头部公司全称 → 简称', () => {
    expect(normalizeInsurer('中国人寿保险股份有限公司')).toBe('中国人寿')
    expect(normalizeInsurer('中国平安人寿保险股份有限公司')).toBe('平安人寿')
    expect(normalizeInsurer('中国太平洋人寿保险股份有限公司')).toBe('太保寿险')
    expect(normalizeInsurer('中国人民人寿保险股份有限公司')).toBe('人保寿险')
  })

  test('合资公司全称 → 简称', () => {
    expect(normalizeInsurer('中美联泰大都会人寿保险有限公司')).toBe('大都会人寿')
    expect(normalizeInsurer('中信保诚人寿保险有限公司')).toBe('中信保诚')
    expect(normalizeInsurer('工银安盛人寿保险有限公司')).toBe('工银安盛')
    expect(normalizeInsurer('招商信诺人寿保险有限公司')).toBe('招商信诺')
  })
})

describe('normalizeInsurer — 简称幂等/变体收敛', () => {
  test('简称输入原样返回（幂等）', () => {
    expect(normalizeInsurer('平安人寿')).toBe('平安人寿')
    expect(normalizeInsurer('中国人寿')).toBe('中国人寿')
    expect(normalizeInsurer('泰康人寿')).toBe('泰康人寿')
  })

  test('同公司不同写法 → 同一简称', () => {
    expect(normalizeInsurer('国寿')).toBe('中国人寿')
    expect(normalizeInsurer('平安保险')).toBe('平安人寿')
    expect(normalizeInsurer('太平洋保险')).toBe('太保寿险')
    expect(normalizeInsurer('新华保险')).toBe('新华人寿')
    expect(normalizeInsurer('信诚人寿')).toBe('中信保诚')
    expect(normalizeInsurer('富德生命人寿')).toBe('生命人寿')
  })

  // 存量数据实测（policies 集合 8 条真实写法）
  test('存量真实写法 → 统一新华人寿', () => {
    expect(normalizeInsurer('新华人寿保险股份有限公司')).toBe('新华人寿')
    expect(normalizeInsurer('新华保险')).toBe('新华人寿')
    expect(normalizeInsurer('NCI新华保险')).toBe('新华人寿')
    expect(normalizeInsurer('新华人寿')).toBe('新华人寿')
  })

  test('品牌名（无机构后缀）→ 幂等返回', () => {
    expect(normalizeInsurer('阳光人寿')).toBe('阳光人寿')
    expect(normalizeInsurer('百年人寿')).toBe('百年人寿')
    expect(normalizeInsurer('横琴人寿')).toBe('横琴人寿')
  })
})

describe('normalizeInsurer — fallback 兜底', () => {
  test('未收录公司：剥离机构后缀保留品牌', () => {
    expect(normalizeInsurer('中科人寿保险股份有限公司')).toBe('中科人寿')
    expect(normalizeInsurer('某某人寿保险有限公司')).toBe('某某人寿')
  })

  test('剥离后只剩泛词 → 原样返回（不猜）', () => {
    expect(normalizeInsurer('人寿')).toBe('人寿')
    expect(normalizeInsurer('保险')).toBe('保险')
  })

  test('空值/空白 → 空串', () => {
    expect(normalizeInsurer('')).toBe('')
    expect(normalizeInsurer(null)).toBe('')
    expect(normalizeInsurer(undefined)).toBe('')
    expect(normalizeInsurer('   ')).toBe('')
  })
})
