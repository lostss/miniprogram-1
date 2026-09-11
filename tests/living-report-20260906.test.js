/**
 * 活报告模型 2026-09-06 — 静态断言
 * 覆盖：REPORT_PROMPT 定性模式黑名单 / report-share 时效 meta（owner + 客户 analysisAt 标量）
 */
const { REPORT_PROMPT } = require('../cloudfunctions/reportAI/prompts')
const { buildReportMeta } = require('../miniprogram/utils/report-share')

describe('REPORT_PROMPT 定性模式（活报告模型）', () => {
  test('包含【定性模式】条件激活节与核心禁项', () => {
    expect(REPORT_PROMPT).toContain('【定性模式】')
    expect(REPORT_PROMPT).toContain('数据缺失处理')
    expect(REPORT_PROMPT).toContain('禁止输出')
    expect(REPORT_PROMPT).toContain('缺口金额')
    expect(REPORT_PROMPT).toContain('占收入比')
    expect(REPORT_PROMPT).toContain('预算充裕')
  })

  test('plan 预算框架仅在收入已知且非定性模式时执行', () => {
    expect(REPORT_PROMPT).toContain('仅家庭年收入已知且输入未含【定性模式】标记时执行')
  })
})

describe('report-share buildReportMeta 时效标识', () => {
  test('owner：last_analysis_at 存在 → analysisAt 文案', () => {
    const ts = '2026-09-01T10:00:00.000Z'
    const m = buildReportMeta({ updated_at: ts, last_analysis_at: ts })
    expect(m.analysisAt).toContain('保障分析生成于')
    expect(m.dataAt).toContain('数据更新于')
    expect(m.dateTime).toBeTruthy()
  })

  test('客户版：share 透传 analysisAt 标量生效（last_* 已清理）', () => {
    const ts = '2026-09-02T08:30:00.000Z'
    const m = buildReportMeta({ updated_at: ts, analysisAt: ts })
    expect(m.analysisAt).toContain('保障分析生成于')
  })

  test('无任何时间字段 → dateTime 兜底当前时间，analysisAt 空', () => {
    const m = buildReportMeta({})
    expect(m.dateTime).toBeTruthy()
    expect(m.analysisAt).toBe('')
  })
})
