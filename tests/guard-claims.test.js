/**
 * guard.auditOutput 禁止承诺规则（2026-09-10 误伤修复）
 *
 * 事故：报告中出现"寿险需求按家庭年收入兜底估算"（prompt 要求的收入兜底口径），
 * 命中当时过宽的裸词规则 /(稳赚|保本|兜底|包赔)/ → 整份报告 JSON 被替换成拒答文案
 * → 必然解析失败，重试同样被拦（两次 output 全部丢弃，前端提示"分析失败"）。
 *
 * 修复原则：仅拦截"承诺"语境，不拦截业务中性词。
 */
const { auditOutput } = require('../cloudfunctions/_shared/guard')

describe('auditOutput — 业务中性表述不得被拦截', () => {
  const neutralCases = [
    '寿险需求按家庭年收入兜底估算。',
    '支柱个人收入缺失时系统用家庭年收入兜底并标注。',
    '若收入缺失，寿险缺口无法计算，建议先补全收入。'
  ]
  test.each(neutralCases)('放行：%s', (text) => {
    expect(auditOutput(text).pass).toBe(true)
  })
})

describe('auditOutput — 真正的承诺性表述仍须拦截', () => {
  const claimCases = [
    '保证赔付 100 万。',
    '承诺年化收益 5%。',
    '稳赚不赔，包赔到底。',
    '确保保本，绝不亏损。',
    '到期最高可领 200 万。',
    '这款产品锁定利率，保证收益。',
    // 「保本」保留裸词拦截：监管上保险产品不得宣传保本（含话术式表述）
    '该产品为保本型年金，适合养老储备。',
    '保证兜底，绝不亏损。'
  ]
  test.each(claimCases)('拦截：%s', (text) => {
    expect(auditOutput(text).pass).toBe(false)
  })
})

describe('auditOutput — 命中信息可诊断', () => {
  test('返回 matchedRule 供 warn 模式定位', () => {
    const r = auditOutput('保证收益 5%')
    expect(r.pass).toBe(false)
    expect(r.matchedRule).toBeTruthy()
    expect(r.text).toContain('抱歉')
  })

  test('未命中时返回原文（可能已脱敏）', () => {
    const r = auditOutput('正常报告内容，无任何承诺。')
    expect(r.pass).toBe(true)
    expect(r.text).toBe('正常报告内容，无任何承诺。')
    expect(r.matchedRule).toBeUndefined()
  })
})
