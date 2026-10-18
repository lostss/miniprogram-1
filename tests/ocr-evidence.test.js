/**
 * AI 原文出处（field_evidence）逐字校验（2026-10-18）
 *
 * 上一层的置信度仍含"AI 自评"成分 —— 主观分救不了"模型抄错但很自信"。
 * 这一层校验的是**事实**：AI 声称这段文字在原文里，那就回原文逐字找。
 *   ① 找不到 → 编造引用
 *   ② 找到了但字段值不在片段里 → 值与引用不匹配
 * 两种都降级为待核对（0.5），并取消 auto_confirmed。
 */
const { applyEvidenceCheck } = require('../cloudfunctions/_shared/ocr-core')

const OCR_TEXT = '中国平安人寿保险股份有限公司\n基本保险金额：30万元\n年缴保费：5,000元\n保险期间自2024年01月15日零时起\n保单号：P20240115001'
const products = [{ sum_assured: 300000, annual_premium: 5000 }]
const basic = { contract_effective_date: '2024-01-15', policy_number: 'P20240115001' }
const conf = { sum_assured: 0.97, annual_premium: 0.97, effective_date: 0.97, policy_number: 0.97 }

function run(evidence) {
  return applyEvidenceCheck(products, basic, evidence, OCR_TEXT, Object.assign({}, conf))
}

describe('applyEvidenceCheck — 引用真实时不动分', () => {
  test('片段逐字存在、值也在片段内 → 全部保持 0.97', () => {
    const r = run({
      sum_assured: '基本保险金额：30万元',
      annual_premium: '年缴保费：5,000元',
      effective_date: '保险期间自2024年01月15日零时起',
      policy_number: '保单号：P20240115001'
    })
    expect(r.flagged).toEqual([])
    expect(r.fieldConf.sum_assured).toBe(0.97)
  })

  test('片段里的空白/逗号与原文不同也能对上（归一后比较）', () => {
    const r = run({ annual_premium: '年缴保费: 5, 000 元' })
    expect(r.flagged).toEqual([])
  })
})

describe('applyEvidenceCheck — 编造引用', () => {
  test('片段在原文里根本不存在 → 该字段降级', () => {
    const r = run({ sum_assured: '基本保险金额：50万元' }) // 原文是 30万
    expect(r.flagged).toEqual(['sum_assured'])
    expect(r.fieldConf.sum_assured).toBe(0.5)
  })

  test('只降级有问题的字段，其它字段不受牵连', () => {
    const r = run({ sum_assured: '基本保险金额：50万元', annual_premium: '年缴保费：5,000元' })
    expect(r.flagged).toEqual(['sum_assured'])
    expect(r.fieldConf.annual_premium).toBe(0.97)
  })
})

describe('applyEvidenceCheck — 引用真实但值对不上', () => {
  test('片段存在，可里面的金额与字段值不同（抄错一位）→ 降级', () => {
    const p = [{ sum_assured: 3000000, annual_premium: 5000 }] // 保额被写成 300 万
    const r = applyEvidenceCheck(p, basic, { sum_assured: '基本保险金额：30万元' }, OCR_TEXT, Object.assign({}, conf))
    expect(r.flagged).toEqual(['sum_assured'])
  })

  test('日期按数字串比对（2024-01-15 ↔ 原文 2024年01月15日）', () => {
    expect(run({ effective_date: '2024年01月15日' }).flagged).toEqual([])
    const p = [{ sum_assured: 300000, annual_premium: 5000 }]
    const bad = applyEvidenceCheck(p, { contract_effective_date: '2024-02-15' }, { effective_date: '2024年01月15日' }, OCR_TEXT, Object.assign({}, conf))
    expect(bad.flagged).toEqual(['effective_date'])
  })
})

describe('applyEvidenceCheck — 缺失与边界', () => {
  test('没给 field_evidence → 本层不判（金额另有值级校验兜底）', () => {
    const r = applyEvidenceCheck(products, basic, undefined, OCR_TEXT, Object.assign({}, conf))
    expect(r.flagged).toEqual([])
    expect(r.fieldConf.sum_assured).toBe(0.97)
  })

  test('片段为空串/过短 → 视为没给，不降级（避免空值被误判成编造）', () => {
    const r = run({ sum_assured: '', annual_premium: '年' })
    expect(r.flagged).toEqual([])
  })

  test('字段没值（0 / 空）→ 不判引用（缺失由 completeness 负责）', () => {
    const r = applyEvidenceCheck([{ sum_assured: 0, annual_premium: 0 }], { contract_effective_date: '', policy_number: '' }, {
      sum_assured: '基本保险金额：30万元', effective_date: '保险期间自2024年01月15日零时起'
    }, OCR_TEXT, Object.assign({}, conf))
    expect(r.flagged).toEqual([])
  })
})
