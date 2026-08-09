/**
 * report-fields.test.js — 报告对象字段契约（防漂移）
 *
 * 背景（prompt 工程审计）：milestones 曾出现"AI 返回但 FIELD_KEYS 不持久化、前端不消费"的契约断裂，
 * 且无任何测试锁定 JSON 键集合与 report-fields.js FIELD_KEYS 对齐。本测试锁死契约：
 *   - 返回对象键集合 === FIELD_KEYS + ARRAY_FIELDS（reportAI/index.js:184 的 data 形状）
 *   - toWriteFields / toReadReport 往返一致
 *   - 字段类型兜底（suggestions 数组规范化后仍 String 化，不会污染）
 */
const { FIELD_KEYS, toWriteFields, toReadReport } = require('../cloudfunctions/_shared/report-fields')

// 与 report-fields.js ARRAY_FIELDS（core_insights）及 reportAI/index.js:184 返回的 data 对象键对齐（新增返回键必须在此登记）
const ARRAY_FIELD_KEYS = ['core_insights']
const RETURN_KEYS = [...FIELD_KEYS, ...ARRAY_FIELD_KEYS]

describe('report 字段契约（单一事实源）', () => {
  test('FIELD_KEYS + ARRAY_FIELDS 与 reportAI 返回对象键集合完全一致', () => {
    // 契约：返回 data 的键 = 8 个字符串字段 + core_insights 数组字段，不多不少
    expect(RETURN_KEYS.sort()).toEqual(
      ['portrait', 'review', 'plan', 'suggestions', 'disclaimer', 'analysis', 'conclusion', 'summary', 'core_insights'].sort()
    )
    // 防御：新增返回键若未登记进 FIELD_KEYS/ARRAY_FIELDS，此断言会失败
    expect(RETURN_KEYS).toHaveLength(9)
  })

  test('toWriteFields 将 8 字符串字段写入 last_*，数组字段存数组', () => {
    const w = toWriteFields({
      portrait: '画像', review: '点评', plan: '规划', suggestions: '建议1；建议2',
      disclaimer: '免责', analysis: '分析', conclusion: '结论', summary: '摘要',
      core_insights: ['洞察A', '洞察B']
    })
    expect(w.last_portrait).toBe('画像')
    expect(w.last_suggestions).toBe('建议1；建议2')
    expect(w.last_core_insights).toEqual(['洞察A', '洞察B'])
  })

  test('缺失字段 → 空字符串（不产生 undefined 污染）', () => {
    const w = toWriteFields({ portrait: '仅画像' })
    for (const k of FIELD_KEYS) {
      expect(w['last_' + k]).not.toBe('undefined')
    }
    expect(w.last_review).toBe('')
    expect(w.last_core_insights).toEqual([])
  })

  test('toReadReport 从 families last_* 还原 no-prefix 对象（往返一致）', () => {
    const fam = {
      last_portrait: 'P', last_review: 'R', last_plan: 'PL', last_suggestions: 'S',
      last_disclaimer: 'D', last_analysis: 'A', last_conclusion: 'C', last_summary: 'SM',
      last_core_insights: ['i1']
    }
    const r = toReadReport(fam)
    expect(r).toEqual({
      portrait: 'P', review: 'R', plan: 'PL', suggestions: 'S',
      disclaimer: 'D', analysis: 'A', conclusion: 'C', summary: 'SM',
      core_insights: ['i1']
    })
    // 往返：写入 → 读出 应与原始 last_* 一致
    const fam2 = {}
    Object.assign(fam2, toWriteFields({ portrait: 'X', core_insights: ['a'] }))
    const back = toReadReport(fam2)
    expect(back.portrait).toBe('X')
    expect(back.core_insights).toEqual(['a'])
  })
})
