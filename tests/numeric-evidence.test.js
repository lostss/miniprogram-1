/**
 * 金额"原文可对齐"校验（2026-10-17）
 *
 * 要解决的问题：`calcConfidence` 在 OCR 字符置信度 ≥0.95 时算 `0.7*ocr + 0.3*ai`，
 * 结果必 ≥0.965 —— **永远越过 0.9 的待核对阈值**。于是 OCR 文本写着"保额 30 万"、
 * AI 却输出 3000000 时，置信度体系不会报警，错值静默入库；金额错一位，
 * 缺口/保费占比/建议全错。这里校验的是**事实一致性**（这个数字在原文里到底有没有）。
 */
const { _hasNumericEvidence, applyNumericEvidence } = require('../cloudfunctions/_shared/ocr-core')

describe('_hasNumericEvidence — 金额在 OCR 文本里能否找到', () => {
  test('元为单位：千分位与全角数字都能对上', () => {
    expect(_hasNumericEvidence('保险金额 300,000 元', 300000)).toBe(true)
    expect(_hasNumericEvidence('保险金额 ３０００００元', 300000)).toBe(true)
    expect(_hasNumericEvidence('保险金额 300000元', 300000)).toBe(true)
  })

  test('万为单位：30万 能对上 300000（原文单位的常见写法）', () => {
    expect(_hasNumericEvidence('基本保额：30万元', 300000)).toBe(true)
    expect(_hasNumericEvidence('基本保额：30 万元', 300000)).toBe(true)
    expect(_hasNumericEvidence('年缴保费 1.2 万元', 12000)).toBe(true)
  })

  test('数字边界：30 不能命中 300 / 3000（否则校验形同虚设）', () => {
    expect(_hasNumericEvidence('保额 300000 元', 30)).toBe(false)
    expect(_hasNumericEvidence('保额 3000 元', 300)).toBe(false)
  })

  test('原文对不上 → false（这就是要拦的幻觉）', () => {
    expect(_hasNumericEvidence('基本保额：30万元', 3000000)).toBe(false)
    expect(_hasNumericEvidence('年缴保费 5,000 元', 50000)).toBe(false)
  })

  test('空文本 / 非法值 → 放行（不越权判定）', () => {
    expect(_hasNumericEvidence('', 300000)).toBe(true)
    expect(_hasNumericEvidence(null, 300000)).toBe(true)
    expect(_hasNumericEvidence('保额 30 万', 0)).toBe(true)
    expect(_hasNumericEvidence('保额 30 万', NaN)).toBe(true)
  })
})

describe('applyNumericEvidence — 对不上就压分进待核对', () => {
  const conf = { sum_assured: 0.97, annual_premium: 0.97, product_name: 0.99 }

  test('保额对不上 → sum_assured 压到 0.5，其余字段不动', () => {
    const r = applyNumericEvidence(
      [{ sum_assured: 3000000, annual_premium: 5000 }],
      Object.assign({}, conf),
      '基本保额：30万元；年缴保费 5,000 元'
    )
    expect(r.fieldConf.sum_assured).toBe(0.5)
    expect(r.fieldConf.annual_premium).toBe(0.97)
    expect(r.flagged).toEqual(['sum_assured'])
  })

  test('两个金额都对不上 → 两个字段都压分，且 flagged 去重', () => {
    const r = applyNumericEvidence(
      [{ sum_assured: 999, annual_premium: 888 }, { sum_assured: 777, annual_premium: 888 }],
      Object.assign({}, conf),
      '保额 30 万，保费 5000 元'
    )
    expect(r.fieldConf.sum_assured).toBe(0.5)
    expect(r.fieldConf.annual_premium).toBe(0.5)
    expect(r.flagged.sort()).toEqual(['annual_premium', 'sum_assured'])
  })

  test('都对得上 → 分数不变（不制造噪音：每次识别都进待核对会让功能失效）', () => {
    const r = applyNumericEvidence(
      [{ sum_assured: 300000, annual_premium: 5000 }],
      Object.assign({}, conf),
      '基本保额：30万元；年缴保费 5,000 元'
    )
    expect(r.fieldConf.sum_assured).toBe(0.97)
    expect(r.flagged).toEqual([])
  })

  test('缺值（0 / null）不判：缺失是 completeness 的职责，不是"对不上"', () => {
    const r = applyNumericEvidence([{ sum_assured: 0, annual_premium: null }], Object.assign({}, conf), '保额 30 万')
    expect(r.flagged).toEqual([])
    expect(r.fieldConf.sum_assured).toBe(0.97)
  })
})
