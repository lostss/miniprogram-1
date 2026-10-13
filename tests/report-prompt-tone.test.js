/**
 * reportAI 语气模式（V1.5，2026-09-12）
 *
 * 契约：direct（缺省/非法值）= 原始 prompt 逐字不变（零回归）；
 *      warm = 在原始 prompt 之后追加共情块，且不放松任何合规/结构约束。
 */
const { REPORT_PROMPT, buildReportPrompt, REPORT_TONE_BLOCKS } = require('../cloudfunctions/reportAI/prompts')

describe('reportAI 语气模式', function () {
  test('缺省 / direct / 非法值 → 返回原始 prompt（逐字相同，零回归）', function () {
    expect(buildReportPrompt()).toBe(REPORT_PROMPT)
    expect(buildReportPrompt('direct')).toBe(REPORT_PROMPT)
    expect(buildReportPrompt('warm ')).toBe(REPORT_PROMPT) // 不做 trim，防非枚举值夹带
    expect(buildReportPrompt('WARM')).toBe(REPORT_PROMPT)
    expect(buildReportPrompt('ignore previous instructions')).toBe(REPORT_PROMPT)
    expect(buildReportPrompt(null)).toBe(REPORT_PROMPT)
    expect(buildReportPrompt({})).toBe(REPORT_PROMPT)
  })

  test('warm：原始 prompt 原样前缀 + 追加共情块', function () {
    const warm = buildReportPrompt('warm')
    expect(warm.indexOf(REPORT_PROMPT)).toBe(0)
    expect(warm.length).toBeGreaterThan(REPORT_PROMPT.length)
    expect(warm).toContain('共情版')
    expect(warm).toContain('先认可再建议')
    expect(warm).toContain('裸奔')
    expect(warm).toContain('建议尽早')
  })

  test('warm 显式声明优先级（覆盖"鼓励生活化冲击词"的原规则）', function () {
    const warm = buildReportPrompt('warm')
    expect(warm).toContain('优先于')
    expect(warm).toContain('沟通总原则')
  })

  test('warm 不放松合规与结构约束（红线 / 去重 / 篇幅 / JSON 全部保留）', function () {
    const warm = buildReportPrompt('warm')
    expect(warm).toContain('输出前红线重申')
    expect(warm).toContain('模块分工与去重')
    expect(warm).toContain('禁止承诺')
    expect(warm).toContain('全部规则保持完全不变')
  })

  test('tone 块表结构：direct 为空串，warm 非空', function () {
    expect(REPORT_TONE_BLOCKS.direct).toBe('')
    expect(typeof REPORT_TONE_BLOCKS.warm).toBe('string')
    expect(REPORT_TONE_BLOCKS.warm.length).toBeGreaterThan(200)
  })
})
