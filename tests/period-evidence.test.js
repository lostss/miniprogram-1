/**
 * 期间字段（保障期间 / 缴费期间）的两个防线（2026-10-18）
 *
 * 起因：这两个字段只用于展示？不 —— 它们驱动甘特图条长、缴费期斜纹段、时间线的
 * 「保障期满 / 交费期满」节点。读错不会报错，只会**静默画错**；缺失也不会进待完善
 * （原先 EXTRA_REQUIRED_FIELDS 只有 insurance_period）。
 *
 * 本轮两道防线：
 *   ① 缴费期间纳入待完善必填（一年期产品豁免 —— 它们天然是「一次性」）
 *   ② OCR 提取后校验期间文本是否真的出现在原文里，找不到 → 置信度压到 0.5 → 待核对
 */
const { _textEvidenceOk, applyPeriodEvidence } = require('../cloudfunctions/_shared/ocr-core')
const { missingRequiredFields } = require('../miniprogram/utils/checkup/organize')

describe('_textEvidenceOk — 期间文本是否在原文里', () => {
  const OCR = '保险期间自2024年01月15日零时起至2054年01月14日二十四时止\n交费方式：年交\n交费期间：20年\n基本保险金额：30万元'

  test('原文逐字存在 → true（含中文/斜杠/空白差异）', () => {
    expect(_textEvidenceOk(OCR, '20年')).toBe(true)
    expect(_textEvidenceOk(OCR, '至2054年01月14日')).toBe(true)
    expect(_textEvidenceOk(OCR, '20 年')).toBe(true)
  })

  test('原文没有的期间 → false（把 20年 读成 30年 这类）', () => {
    expect(_textEvidenceOk(OCR, '30年')).toBe(false)
    expect(_textEvidenceOk(OCR, '至2060年01月14日')).toBe(false)
  })

  test('整体匹配不到时退化为 token 匹配（原文常写成"缴费期间：20年（20次交）"）', () => {
    expect(_textEvidenceOk(OCR, '缴费期间 20年')).toBe(true)
    expect(_textEvidenceOk('保障至70岁', '至70岁')).toBe(true)
    expect(_textEvidenceOk('本合同为终身寿险', '终身')).toBe(true)
  })

  test('纯文本型取值（趸交/一次性）按整串或 token 判，找不到就 false', () => {
    expect(_textEvidenceOk('交费方式：趸交', '趸交')).toBe(true)
    expect(_textEvidenceOk(OCR, '趸交')).toBe(false)
  })

  test('空值/空文本 → 放行（缺失由 completeness 管）', () => {
    expect(_textEvidenceOk(OCR, '')).toBe(true)
    expect(_textEvidenceOk('', '20年')).toBe(true)
  })
})

describe('applyPeriodEvidence — 对不上就压分', () => {
  const OCR = '交费期间：20年\n保险期间：终身'
  const conf = { insurance_period: 0.97, payment_period: 0.97, sum_assured: 0.97 }

  test('两个期间都能对上 → 分数不变（不制造噪音）', () => {
    const r = applyPeriodEvidence([{ insurance_period: '终身', payment_period: '20年' }], OCR, Object.assign({}, conf))
    expect(r.flagged).toEqual([])
    expect(r.fieldConf.insurance_period).toBe(0.97)
  })

  test('缴费期间读错 → 只压该字段，保障期间不受牵连', () => {
    const r = applyPeriodEvidence([{ insurance_period: '终身', payment_period: '30年' }], OCR, Object.assign({}, conf))
    expect(r.flagged).toEqual(['payment_period'])
    expect(r.fieldConf.payment_period).toBe(0.5)
    expect(r.fieldConf.insurance_period).toBe(0.97)
  })

  test('缺值的期间不判（缺失 ≠ 读错）', () => {
    const r = applyPeriodEvidence([{ insurance_period: '终身' }], OCR, Object.assign({}, conf))
    expect(r.flagged).toEqual([])
  })
})

describe('缴费期间纳入待完善（一年期豁免）', () => {
  test('长期险缺缴费期间 → 进必填缺失清单（能提示补录）', () => {
    const miss = missingRequiredFields({
      product_name: 'A', insurance_category: '重疾险', insured_name: '张三',
      sum_assured: 300000, annual_premium: 5000, effective_date: '2024-01-15',
      insurance_period: '终身'
    })
    expect(miss).toContain('payment_period')
  })

  test('一年期产品（insurance_period 1年 / coverage_term 1）→ 不报缺缴费期间', () => {
    const base = {
      product_name: '百万医疗', insurance_category: '医疗险', insured_name: '张三',
      sum_assured: 4000000, annual_premium: 657, effective_date: '2024-01-15',
      insurance_period: '1年'
    }
    expect(missingRequiredFields(base)).not.toContain('payment_period')
    expect(missingRequiredFields(Object.assign({}, base, { insurance_period: '', coverage_term: 1 }))).not.toContain('payment_period')
  })

  test('已有缴费期间 → 不进缺失清单', () => {
    const miss = missingRequiredFields({
      product_name: 'A', insurance_category: '重疾险', insured_name: '张三',
      sum_assured: 300000, annual_premium: 5000, effective_date: '2024-01-15',
      insurance_period: '终身', payment_period: '20年'
    })
    expect(miss).toEqual([])
  })
})
