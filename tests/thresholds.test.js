/**
 * thresholds 单元测试 — 保额阈值单一事实源
 *
 * 被测对象：cloudfunctions/_shared/thresholds.js
 * 设计契约：
 *   - THRESHOLDS 每项含 reference/statusFn/basis
 *   - canonCat 将裸词（重疾/医疗/意外）规范为带"险"后缀
 *   - formatThresholdPrompt / formatThresholdAppendix 输出带角标的文本
 */
const {
  THRESHOLDS,
  DEFAULT_THRESHOLD,
  CANON_CAT,
  canonCat,
  formatThresholdPrompt,
  formatThresholdAppendix
} = require('../cloudfunctions/_shared/thresholds')

describe('thresholds', () => {
  describe('canonCat', () => {
    test('裸词规范化：重疾 → 重疾险', () => {
      expect(canonCat('重疾')).toBe('重疾险')
      expect(canonCat('医疗')).toBe('医疗险')
      expect(canonCat('意外')).toBe('意外险')
    })

    test('已规范词保持不变', () => {
      expect(canonCat('寿险')).toBe('寿险')
      expect(canonCat('年金')).toBe('年金')
      expect(canonCat('重疾险')).toBe('重疾险')
    })

    test('空值返回 其他', () => {
      expect(canonCat('')).toBe('其他')
      expect(canonCat(null)).toBe('其他')
      expect(canonCat(undefined)).toBe('其他')
      expect(canonCat('   ')).toBe('其他')
    })

    test('未知类别原样返回', () => {
      expect(canonCat('分红险')).toBe('分红险')
      expect(canonCat('万能险')).toBe('万能险')
    })

    test('CANON_CAT 映射表与 canonCat 一致', () => {
      Object.keys(CANON_CAT).forEach(k => {
        expect(canonCat(k)).toBe(CANON_CAT[k])
      })
    })
  })

  describe('THRESHOLDS statusFn', () => {
    test('重疾险：>=50万为达标', () => {
      expect(THRESHOLDS['重疾险'].statusFn(50)).toBe(true)
      expect(THRESHOLDS['重疾险'].statusFn(49)).toBe(false)
      expect(THRESHOLDS['重疾险'].statusFn(100)).toBe(true)
    })

    test('医疗险：>=100万为达标（reference=200 但 statusFn 阈值=100）', () => {
      expect(THRESHOLDS['医疗险'].statusFn(100)).toBe(true)
      expect(THRESHOLDS['医疗险'].statusFn(99)).toBe(false)
      expect(THRESHOLDS['医疗险'].statusFn(200)).toBe(true)
    })

    test('寿险：负债+5年收入', () => {
      // 负债50万 + 收入10万 × 5 = 100万
      expect(THRESHOLDS['寿险'].statusFn(100, 50, 10)).toBe(true)
      expect(THRESHOLDS['寿险'].statusFn(99, 50, 10)).toBe(false)
      expect(THRESHOLDS['寿险'].statusFn(0, 50, 10)).toBe(false)
    })

    test('意外险：max(5倍收入, 负债)', () => {
      // 收入10万 → 50万；负债30万 → max=50万
      expect(THRESHOLDS['意外险'].statusFn(50, 30, 10)).toBe(true)
      expect(THRESHOLDS['意外险'].statusFn(49, 30, 10)).toBe(false)
      // 收入5万 → 25万；负债40万 → max=40万
      expect(THRESHOLDS['意外险'].statusFn(40, 40, 5)).toBe(true)
      expect(THRESHOLDS['意外险'].statusFn(39, 40, 5)).toBe(false)
    })

    test('年金/增额终身寿/终身寿险：>=10万为达标', () => {
      expect(THRESHOLDS['年金'].statusFn(10)).toBe(true)
      expect(THRESHOLDS['年金'].statusFn(9)).toBe(false)
      expect(THRESHOLDS['增额终身寿'].statusFn(10)).toBe(true)
      expect(THRESHOLDS['终身寿险'].statusFn(10)).toBe(true)
    })
  })

  describe('THRESHOLDS reference', () => {
    test('数字型 reference 直接返回', () => {
      expect(THRESHOLDS['重疾险'].reference).toBe(50)
      expect(THRESHOLDS['医疗险'].reference).toBe(200)
      expect(THRESHOLDS['年金'].reference).toBe(10)
    })

    test('函数型 reference 计算正确（寿险/意外险）', () => {
      expect(THRESHOLDS['寿险'].reference(50, 10)).toBe(100) // 50 + 10*5
      expect(THRESHOLDS['意外险'].reference(40, 5)).toBe(40) // max(25, 40) = 40
      expect(THRESHOLDS['意外险'].reference(30, 10)).toBe(50) // max(50, 30) = 50
    })
  })

  describe('DEFAULT_THRESHOLD', () => {
    test('默认阈值 100 万', () => {
      expect(DEFAULT_THRESHOLD.reference).toBe(100)
      expect(DEFAULT_THRESHOLD.statusFn(100)).toBe(true)
      expect(DEFAULT_THRESHOLD.statusFn(99)).toBe(false)
    })
  })

  describe('formatThresholdPrompt', () => {
    test('输出包含 4 个角标 ¹²³⁴', () => {
      const text = formatThresholdPrompt()
      expect(text).toContain('¹')
      expect(text).toContain('²')
      expect(text).toContain('³')
      expect(text).toContain('⁴')
    })

    test('包含重疾/寿险/意外险/医疗险四个险种', () => {
      const text = formatThresholdPrompt()
      expect(text).toContain('重疾险')
      expect(text).toContain('寿险')
      expect(text).toContain('意外险')
      expect(text).toContain('医疗险')
    })

    test('寿险/意外险带 basis 公式描述（函数型 reference）', () => {
      const text = formatThresholdPrompt()
      expect(text).toContain('负债')
      expect(text).toContain('5倍')
    })

    test('重疾险/医疗险带"参考保额N万"（数字型 reference）', () => {
      const text = formatThresholdPrompt()
      expect(text).toContain('参考保额50万')
      expect(text).toContain('参考保额200万')
    })
  })

  describe('formatThresholdAppendix', () => {
    test('输出包含 4 条编号说明', () => {
      const text = formatThresholdAppendix()
      expect(text).toContain('1. 重疾险')
      expect(text).toContain('2. 寿险保额')
      expect(text).toContain('3. 意外险保额')
      expect(text).toContain('4. 医疗险')
    })

    test('与 formatThresholdPrompt 的口径一致（同 basis）', () => {
      const prompt = formatThresholdPrompt()
      const appendix = formatThresholdAppendix()
      // 寿险 basis 在两处都应出现
      expect(prompt).toContain(THRESHOLDS['寿险'].basis)
      expect(appendix).toContain(THRESHOLDS['寿险'].basis)
    })
  })
})
