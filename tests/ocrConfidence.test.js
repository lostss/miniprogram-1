/**
 * ocr-confidence 单元测试（纯函数）
 * RED phase — 先写测试，看着它失败
 */
const { calcConfidence } = require('../cloudfunctions/_shared/ocr-confidence')

describe('calcConfidence', () => {
  const highOcr = [{ text: '保单号123', ocr_conf: 99 }, { text: '张三', ocr_conf: 98 }]
  const lowOcr = [{ text: '模糊', ocr_conf: 50 }, { text: '不清', ocr_conf: 45 }]
  const emptyOcr = []

  const fullAiConf = { product_name: 0.97, insurance_category: 0.95, insurance_type: 0.93,
    insurance_period: 0.91, sum_assured: 0.99, annual_premium: 0.98, insured_name: 0.96,
    policy_number: 0.97, insurance_company: 0.95, effective_date: 0.92, policyholder_name: 0.94 }

  // ---- OCR可靠 + AI 完整 ----
  test('OCR可靠时融合OCR(70%)和AI(30%)', () => {
    const r = calcConfidence(highOcr, fullAiConf, 0.95)
    expect(r.ocrReliable).toBe(true)
    expect(r.fieldConf.product_name).toBeCloseTo(0.98, 1)
    expect(r.overallConf).toBeCloseTo(0.985, 1)
  })

  test('OCR可靠时整体置信度取OCR均值', () => {
    const r = calcConfidence(highOcr, fullAiConf, 0.60)
    expect(r.overallConf).toBeGreaterThan(0.90)
  })

  // ---- OCR不可靠时纯依赖AI ----
  test('OCR不可靠时字段置信度纯取AI值', () => {
    const r = calcConfidence(lowOcr, fullAiConf, 0.70)
    expect(r.ocrReliable).toBe(false)
    expect(r.fieldConf.product_name).toBe(0.97)
  })

  test('OCR不可靠且AI无字段置信度时用整体置信度', () => {
    const r = calcConfidence(lowOcr, {}, 0.70)
    expect(r.fieldConf.product_name).toBe(0.70)
  })

  // ---- autoConfirmed ----
  test('OCR可靠则自动确认', () => {
    const r = calcConfidence(highOcr, {}, 0.50)
    expect(r.autoConfirmed).toBe(true)
  })

  test('OCR不可靠但所有字段置信度≥0.9则自动确认', () => {
    const r = calcConfidence(lowOcr, fullAiConf, 0.70)
    // 每个字段的 aiV 都 ≥0.9，fieldConf >= 0.9
    expect(r.autoConfirmed).toBe(true)
  })

  test('OCR不可靠且有字段置信度<0.9则需手动确认', () => {
    const partialAi = { ...fullAiConf, insurance_period: 0.85 }
    const r = calcConfidence(lowOcr, partialAi, 0.70)
    expect(r.autoConfirmed).toBe(false)
  })

  // ---- 空OCR ----
  test('空OCR时ocrReliable为false', () => {
    const r = calcConfidence(emptyOcr, fullAiConf, 0.80)
    expect(r.ocrReliable).toBe(false)
    expect(r.overallConf).toBe(0.80)
  })

  // ---- 部分字段缺失AI置信度 ----
  test('OCR可靠时AI缺失字段退回到OCR均值', () => {
    const r = calcConfidence(highOcr, { product_name: 0.97 }, 0.80)
    expect(r.ocrReliable).toBe(true)
    expect(r.fieldConf.product_name).toBeCloseTo(0.98, 1)
    // sum_assured 没有 aiV，退回 ocrConfAvg
    expect(r.fieldConf.sum_assured).toBeCloseTo(0.985, 1)
  })

  // ---- ocrConfAvg 精度 ----
  test('ocrConfAvg介于94和95之间时有部分字段不会确认', () => {
    const r = calcConfidence([{ text: 'a', ocr_conf: 93 }, { text: 'b', ocr_conf: 94 }], fullAiConf, 0.50)
    expect(r.ocrReliable).toBe(false) // 93.5 < 95
  })

  test('ocrConfAvg 刚好95则ocr可靠', () => {
    const r = calcConfidence([{ text: 'a', ocr_conf: 95 }], fullAiConf, 0.50)
    expect(r.ocrReliable).toBe(true)
  })

  // ---- 匹配阈值边界 ----
  test('OCR可靠时字段>=0.9自动确认', () => {
    const edgeAiConf = {}
    CONF_FIELDS.forEach(k => { edgeAiConf[k] = 0.90 })
    const r = calcConfidence(highOcr, edgeAiConf, 0.50)
    expect(r.autoConfirmed).toBe(true)
  })

  // 需要 CONF_FIELDS 列表
  const CONF_FIELDS = ['product_name', 'insurance_category', 'insurance_type', 'insurance_period',
    'sum_assured', 'annual_premium', 'insured_name', 'policy_number', 'insurance_company',
    'effective_date', 'policyholder_name']

  test('OCR不可靠且所有字段0.9刚好通过', () => {
    const edgeAiConf = {}
    CONF_FIELDS.forEach(k => { edgeAiConf[k] = 0.90 })
    const r = calcConfidence(lowOcr, edgeAiConf, 0.50)
    expect(r.autoConfirmed).toBe(true)
    expect(r.ocrReliable).toBe(false)
  })

  test('所有字段0.89不能自动确认', () => {
    const edgeAiConf = {}
    CONF_FIELDS.forEach(k => { edgeAiConf[k] = 0.89 })
    const r = calcConfidence(lowOcr, edgeAiConf, 0.50)
    expect(r.autoConfirmed).toBe(false)
  })
})
