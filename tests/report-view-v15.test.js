/**
 * V1.5 报告视图契约（2026-09-12）
 *
 * 1) 行动出口收敛：owner 版行动建议任一时刻只有一个出口
 *    - 有 AI 分析 → deep.suggestions（next_steps 章被隐藏，topAdvice 恒空）
 *    - 无 AI 分析 → next_steps 章（topAdvice 恒空，不再与收口章重复）
 *    - 客户版（shared）无 next_steps 章，topAdvice 是其唯一行动指向 → 保留
 * 2) 明细型章节默认折叠（缴费月历 / 附录保单明细），首屏只留结论与缺口
 */
const { buildReportView, buildChapters } = require('../miniprogram/utils/report-builder')

function family() {
  return {
    name: '测试家庭',
    family_income: 50,
    financial_snapshot: { income: 50, debt: { amount: 100 } },
    members: [
      { member_id: 'm1', name: '张三', role: '本人', age: 40, gender: '男', income: 30 },
      { member_id: 'm2', name: '李四', role: '配偶', age: 38, gender: '女', income: 20 }
    ],
    policies: [
      { id: 'P1', member_id: 'm1', insured_name: '张三', insurance_category: '寿险', sum_assured: 1000000,
        annual_premium: 8000, effective_date: '2020-01-01', payment_period: '20年', insurance_period: '至2050年', status: 'active' }
    ]
  }
}

const hasKey = (chapters, key) => !!chapters.find(c => c.key === key)

describe('V1.5 行动出口收敛（owner）', function () {
  test('无 AI 分析：保留 next_steps 章，hero.topAdvice 置空（不再双份重复）', function () {
    const view = buildReportView(family(), { disclaimer: '免责' })
    expect(view.deep).toBeNull()
    expect(hasKey(view.chapters, 'next_steps')).toBe(true)
    expect(view.hero.topAdvice).toBe('')
    // 规则版行动信息仍可从收口章读到（不因收敛而丢失）
    const next = view.chapters.find(c => c.key === 'next_steps')
    expect(next.content).toContain('优先为')
  })

  test('有 AI 分析：隐藏 next_steps 章（唯一出口 = deep.suggestions）', function () {
    const view = buildReportView(family(), { portrait: '家庭画像', suggestions: '1. {{URGENT}}补充寿险' })
    expect(view.deep).not.toBeNull()
    expect(hasKey(view.chapters, 'next_steps')).toBe(false)
    expect(view.hero.topAdvice).toBe('')
    expect(view.deep.suggestions).toContain('补充寿险')
  })
})

describe('V1.5 客户版行动指向保持', function () {
  test('shared 版保留 topAdvice（无 next_steps 章，它是唯一行动指向）', function () {
    const view = buildReportView(family(), { portrait: '家庭画像' }, { view: 'shared' })
    expect(hasKey(view.chapters, 'next_steps')).toBe(false)
    expect(view.hero.topAdvice).toBeTruthy()
  })
})

describe('客户版呈现修正（2026-09-12）', function () {
  test('客户版缺口章：带单位 + 章首差额口径，且不含倍数/收入基数', function () {
    const view = buildReportView(family(), {}, { view: 'shared' })
    const gap = view.chapters.find(c => c.key === 'gap_analysis')
    expect(gap).toBeDefined()
    expect(gap.unit).toBe('单位：万元')
    expect(gap.content).toContain('建议保额')
    expect(gap.content).toContain('已有保额')
    // 不给倍数公式/收入基数——家庭财务章对客户隐藏，写出来等于暴露被刻意隐藏的数据
    expect(gap.content).not.toContain('需求')
    expect(gap.content).not.toContain('年收入')
  })

  test('owner 版缺口章同样带单位（差额口径行仅客户版）', function () {
    const view = buildReportView(family(), {})
    const gap = view.chapters.find(c => c.key === 'gap_analysis')
    expect(gap.unit).toBe('单位：万元')
    expect(gap.content).toContain('需求') // owner 保留「需求 X 万 - 已有 Y 万 · 优先级」
  })

  test('客户版月历不含占收入比（基数不可见则不引用）', function () {
    const view = buildReportView(family(), {}, { view: 'shared' })
    const cal = view.chapters.find(c => c.key === 'premium_calendar')
    expect(cal.content).not.toContain('占家庭年收入')
    expect(cal.content).not.toContain('仅供参考')
  })

  test('owner 版月历保留占收入比', function () {
    const view = buildReportView(family(), {})
    const cal = view.chapters.find(c => c.key === 'premium_calendar')
    expect(cal.content).toContain('占收入')
  })
})

describe('V1.5 明细型章节默认折叠', function () {
  test('缴费月历与附录保单明细 defaultCollapsed=true，且仍可手动展开（collapsible）', function () {
    const ch = buildChapters(family(), {})
    const cal = ch.find(c => c.key === 'premium_calendar')
    const apx = ch.find(c => c.key === 'appendix_policies')
    expect(cal.collapsible).toBe(true)
    expect(cal.defaultCollapsed).toBe(true)
    expect(apx.collapsible).toBe(true)
    expect(apx.defaultCollapsed).toBe(true)
  })

  test('结论型章节不默认折叠（保障汇总 / 缺口分析）', function () {
    const ch = buildChapters(family(), {})
    const cs = ch.find(c => c.key === 'coverage_summary')
    const gap = ch.find(c => c.key === 'gap_analysis')
    expect(!!cs.defaultCollapsed).toBe(false)
    expect(!!gap.defaultCollapsed).toBe(false)
  })
})
