/**
 * REPORT_PROMPT 契约断言（2026-09-10）
 *
 * 覆盖线上实测发现的三类偏差：
 *   1. AI 基于「保障到期」日期已过，自行把 status=active 的一年期保单判定失效、扣减保额
 *      （实测：报告把李阳勇"20万重疾"写成"实际长期有效只有10万"）
 *   2. 同一结论在 7 个模块各说一遍（篇幅 3114 字）
 *   3. suggestions 约束"最多5条"却生成了 6 条
 *
 * 这些是 prompt 层的硬约束，删掉任何一条都会让上述偏差复现——故用静态断言锁定。
 */
const { REPORT_PROMPT } = require('../cloudfunctions/reportAI/prompts')
const { buildReportContext } = require('../cloudfunctions/reportAI/report-context')

describe('REPORT_PROMPT 保单状态权威性', () => {
  test('禁止基于保障到期日判定失效或扣减保额（一年期默认有效）', () => {
    expect(REPORT_PROMPT).toContain('一年期产品默认有效')
    expect(REPORT_PROMPT).toContain('不得因「保障到期」列显示的年月已过')
    expect(REPORT_PROMPT).toContain('唯一权威值')
    expect(REPORT_PROMPT).toContain('照常计入保障')
  })

  test('保额为 0 的保单不得自行判定为无保障', () => {
    expect(REPORT_PROMPT).toContain('保额显示为 0 或空的保单不得自行判定为"无保障"')
    expect(REPORT_PROMPT).toContain('只能标注"保额待确认"')
  })
})

describe('REPORT_PROMPT 篇幅与去重约束', () => {
  test('含模块分工与去重约束', () => {
    expect(REPORT_PROMPT).toContain('模块分工与去重')
    expect(REPORT_PROMPT).toContain('同一结论只在最贴合的模块展开一次')
    expect(REPORT_PROMPT).toContain('全篇最多出现 2 次')
  })

  test('含篇幅上限与 suggestions 条数硬约束', () => {
    expect(REPORT_PROMPT).toContain('1800-2400 字')
    expect(REPORT_PROMPT).toContain('最多 5 条（超过即违规）')
  })

  test('保留生活化表达（去重不等于术语化）', () => {
    expect(REPORT_PROMPT).toContain('保留生活化表达')
    expect(REPORT_PROMPT).toContain('鼓励')
    expect(REPORT_PROMPT).toContain('不要为了显得正式而改成术语堆砌')
  })

  test('推断与事实分开（收入未填时不得断言唯一收入来源）', () => {
    expect(REPORT_PROMPT).toContain('不要把推断写成既定事实')
    expect(REPORT_PROMPT).toContain('不要断言"唯一收入来源"')
  })
})

describe('report 上下文口径说明（数据侧与规则侧双声明）', () => {
  test('上下文头部声明一年期默认有效、照常计入保障', () => {
    const r = buildReportContext({ v2ctx: { markdown: 'X' }, policies: [], familyMeta: {} })
    expect(r.indexOf('## 数据口径说明')).toBe(0)
    expect(r).toContain('默认有效、照常计入保障')
    expect(r).toContain('禁止据此扣减保额或判定失效')
  })
})
