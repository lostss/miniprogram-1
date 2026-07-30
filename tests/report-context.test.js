/**
 * report-context 纯函数测试
 * 架构审计第 13 轮候选 #5：补单测
 *
 * 覆盖 buildSummaryMd / buildPrevReportMd / buildReportContext 三段上下文构建
 */
const {
  buildSummaryMd,
  buildPrevReportMd,
  buildReportContext
} = require('../cloudfunctions/reportAI/report-context')

describe('buildSummaryMd', () => {
  test('空输入 → 仅标题行', () => {
    const md = buildSummaryMd([], null)
    expect(md).toContain('保单汇总数据')
    expect(md).toContain('年保费合计：0元')
    expect(md).toContain('有效保单：0份')
    expect(md).toContain('已失效/过期：0份')
  })

  test('policies 为 null → 不抛错', () => {
    expect(() => buildSummaryMd(null, {})).not.toThrow()
  })

  test('active 保单累加年保费 + 总保额', () => {
    const policies = [
      { status: 'active', annual_premium: 5000, sum_assured: 500000 },
      { status: 'active', annual_premium: 3000, sum_assured: 300000 },
      { status: 'expired', annual_premium: 2000, sum_assured: 100000 }
    ]
    const md = buildSummaryMd(policies, { income: '20' })
    expect(md).toContain('年保费合计：8000元') // 5000+3000，不含 expired
    expect(md).toContain('占家庭年收入 4.0%') // 8000 / (20*10000) * 100 = 4.0
    expect(md).toContain('有效保单总保额：80万') // (500000+300000)/10000
    expect(md).toContain('有效保单：2份 | 已失效/过期：1份')
  })

  test('无 status 字段视为 active', () => {
    const policies = [{ annual_premium: 1000, sum_assured: 100000 }] // 无 status
    const md = buildSummaryMd(policies, {})
    expect(md).toContain('有效保单：1份')
    expect(md).toContain('年保费合计：1000元')
  })

  test('income 为 0 → premiumRatio 显示 -', () => {
    const md = buildSummaryMd([{ status: 'active', annual_premium: 1000 }], { income: 0 })
    expect(md).toContain('占家庭年收入 -%')
  })

  test('income 缺失 → premiumRatio 显示 -', () => {
    const md = buildSummaryMd([{ status: 'active', annual_premium: 1000 }], {})
    expect(md).toContain('占家庭年收入 -%')
  })

  test('snap 含 debt / fixed_expense → 显示', () => {
    const md = buildSummaryMd([], { debt: '房贷100万', fixed_expense: '8000元/月' })
    expect(md).toContain('家庭负债：房贷100万')
    expect(md).toContain('固定月支出：8000元/月')
  })

  test('snap 不含 debt / fixed_expense → 不显示该行', () => {
    const md = buildSummaryMd([], {})
    expect(md).not.toContain('家庭负债')
    expect(md).not.toContain('固定月支出')
  })

  test('income 字符串数字也能解析', () => {
    const md = buildSummaryMd([{ status: 'active', annual_premium: 5000 }], { income: '10' })
    expect(md).toContain('占家庭年收入 5.0%') // 5000 / (10*10000) * 100
  })
})

describe('buildPrevReportMd', () => {
  test('空输入 → 空字符串', () => {
    expect(buildPrevReportMd(null)).toBe('')
    expect(buildPrevReportMd({})).toBe('')
  })

  test('只有 last_conclusion', () => {
    const md = buildPrevReportMd({ last_conclusion: '当前保障充足' })
    expect(md).toContain('上一版结论')
    expect(md).toContain('当前保障充足')
    expect(md).not.toContain('上一版摘要')
  })

  test('只有 last_summary', () => {
    const md = buildPrevReportMd({ last_summary: '建议加保重疾' })
    expect(md).toContain('上一版摘要')
    expect(md).toContain('建议加保重疾')
    expect(md).not.toContain('上一版结论')
  })

  test('两者都有 → 两段都显示', () => {
    const md = buildPrevReportMd({ last_conclusion: '结论A', last_summary: '摘要B' })
    expect(md).toContain('上一版结论**：结论A')
    expect(md).toContain('上一版摘要**：摘要B')
  })

  test('包含禁止照抄提示', () => {
    const md = buildPrevReportMd({ last_conclusion: 'X' })
    expect(md).toContain('禁止照抄')
    expect(md).toContain('以当前数据为准')
  })
})

describe('buildReportContext', () => {
  test('空输入 → 仅返回 summaryMd（buildSummaryMd 总是非空）', () => {
    const r = buildReportContext({})
    expect(r).toContain('保单汇总数据')
    expect(r).toContain('年保费合计：0元')
    // 不含 v2ctx/structured/hints/prev
    expect(r).not.toContain('上一版')
  })

  test('仅 v2ctx.markdown → v2ctx + summaryMd 拼接', () => {
    const r = buildReportContext({
      v2ctx: { markdown: '## 客户画像\n张三' },
      policies: [],
      familyMeta: {}
    })
    expect(r).toContain('## 客户画像\n张三')
    expect(r).toContain('保单汇总数据') // summaryMd 总会被拼接
    // 顺序：v2ctx 在 summary 之前
    expect(r.indexOf('## 客户画像')).toBeLessThan(r.indexOf('保单汇总数据'))
  })

  test('多段拼接顺序：v2ctx → summary → structured → hints → prev', () => {
    const r = buildReportContext({
      v2ctx: { markdown: 'V2_MARKDOWN', datasets: { facts: [], cashValues: [] } },
      policies: [{ status: 'active', annual_premium: 1000 }],
      familyMeta: { financial_snapshot: {}, last_conclusion: 'PREV_CONCLUSION' }
    })
    expect(r).toContain('V2_MARKDOWN')
    expect(r).toContain('保单汇总数据')
    expect(r).toContain('上一版结论')
    // 验证顺序：v2ctx 在 summary 之前
    expect(r.indexOf('V2_MARKDOWN')).toBeLessThan(r.indexOf('保单汇总数据'))
    expect(r.indexOf('保单汇总数据')).toBeLessThan(r.indexOf('上一版结论'))
  })

  test('v2ctx.datasets 缺失 → facts/cashValues 退化为空数组', () => {
    expect(() => buildReportContext({
      v2ctx: { markdown: 'X' }, // 无 datasets
      policies: [],
      familyMeta: {}
    })).not.toThrow()
  })

  test('familyMeta.financial_snapshot 缺失 → snap 退化为 {}', () => {
    const r = buildReportContext({
      v2ctx: { markdown: 'X', datasets: {} },
      policies: [],
      familyMeta: {} // 无 financial_snapshot
    })
    expect(r).toContain('年保费合计：0元')
  })

  test('facts 含删除标记 → 触发 buildCoverageHints 生成一致性提示', () => {
    // buildStructuredCoverage 内部调用 buildCoverageHints：facts.predicate='备注' + 含"删除"关键词
    // + policies 中有匹配产品名且 status !== 'deleted' → 生成提示
    const r = buildReportContext({
      v2ctx: { markdown: 'V2', datasets: { facts: [
        { subject_name: '张三', predicate: '备注', object_value: '已删除平安福', object_id: '' }
      ], cashValues: [] } },
      policies: [{ id: 'p1', product_name: '平安福', status: 'active', insured_name: '张三' }],
      familyMeta: {}
    })
    expect(r).toContain('数据一致性提示')
  })
})
