/**
 * 写库兜底校验（2026-10-18）
 *
 * 背景：prompt 里对 AI 有约束（险种白名单、金额为元、日期 YYYY-MM-DD），但**写库路径更宽松**——
 * `_toYuanAmount` 的纯数字分支放行负数、险种字符串原样透传、非法日期静默置空。
 * 后果分别是：负保额进库、矩阵/缺口整格落空、报告里凭空多一处空白且无人知道。
 *
 * 设计取舍：不阻断写入（识别费用已付），只把问题回传成 codes 由前端提示。
 */
const { normalizePolicyInput } = require('../cloudfunctions/dataWrite/policy-write')

describe('normalizePolicyInput — 金额', () => {
  test('负数钳到 0 并告警（OCR 把 "-" 读进去就会发生）', () => {
    const r = normalizePolicyInput({ sum_assured: -50000, annual_premium: 3000 })
    expect(r.sumAssured).toBe(0)
    expect(r.annualPremium).toBe(3000)
    expect(r.warnings).toContain('negative_sum_assured')
  })

  test('负数保费同样钳位（独立告警码，便于前端说清是哪一项）', () => {
    const r = normalizePolicyInput({ annual_premium: -1200 })
    expect(r.annualPremium).toBe(0)
    expect(r.warnings).toContain('negative_premium')
  })

  test('万/千分位/不可解析：正常换算，不误报', () => {
    expect(normalizePolicyInput({ sum_assured: '80万' }).sumAssured).toBe(800000)
    expect(normalizePolicyInput({ annual_premium: '12,000' }).annualPremium).toBe(12000)
    const bad = normalizePolicyInput({ sum_assured: '说不清' })
    expect(bad.sumAssured).toBe(0)
    expect(bad.warnings).toEqual([]) // 解析失败≠金额为负，不制造噪音
  })
})

describe('normalizePolicyInput — 险种白名单', () => {
  test('契约规范词归一：医疗 → 医疗险、年金险 → 年金（不算异常）', () => {
    expect(normalizePolicyInput({ insurance_category: '医疗' })).toMatchObject({ category: '医疗险', warnings: [] })
    expect(normalizePolicyInput({ insurance_category: '年金险' })).toMatchObject({ category: '年金', warnings: [] })
  })

  test('白名单外的险种归「其他」并告警（否则矩阵整格落空且无人知道）', () => {
    const r = normalizePolicyInput({ insurance_category: '护理险' })
    expect(r.category).toBe('其他')
    expect(r.warnings).toContain('unknown_category')
  })

  test('未填险种保持空串且不告警（缺失由 completeness 负责，不是"识别错"）', () => {
    const r = normalizePolicyInput({})
    expect(r.category).toBe('')
    expect(r.warnings).toEqual([])
  })
})

describe('normalizePolicyInput — 生效日期', () => {
  test('中文/斜杠格式规范化成功 → 不告警', () => {
    expect(normalizePolicyInput({ effective_date: '2024年1月5日' })).toMatchObject({ effectiveDate: '2024-01-05', warnings: [] })
    expect(normalizePolicyInput({ effective_date: '2024/1/5' })).toMatchObject({ effectiveDate: '2024-01-05', warnings: [] })
  })

  test('无法解析 → 置空并告警（原实现静默置空，用户只能在报告里发现空白）', () => {
    const r = normalizePolicyInput({ effective_date: '2024年13月45日' })
    expect(r.effectiveDate).toBe('')
    expect(r.warnings).toContain('bad_effective_date')
  })

  test('本来就没填 → 不告警（缺失 ≠ 错）', () => {
    expect(normalizePolicyInput({ effective_date: '' }).warnings).toEqual([])
  })
})
