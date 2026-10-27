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

describe('规则层不出建议（2026-10-21 用户决策：现阶段不做诊断）', function () {
  test('无 AI 分析：也没有 next_steps 章，hero 不带 topAdvice', function () {
    const view = buildReportView(family(), { disclaimer: '免责' })
    expect(view.deep).toBeNull()
    expect(hasKey(view.chapters, 'next_steps')).toBe(false)
    expect(view.hero).not.toHaveProperty('topAdvice')
    // 事实仍在：每人每险种的已有保额（2026-10-27 起不再有缺口/优先级）
    const gap = view.chapters.find(c => c.key === 'gap_analysis')
    expect(gap.title).toBe('已有保额')
    expect(gap.content).toContain('万')
  })

  test('有 AI 分析：建议只出现在 deep.suggestions（来源明确、可区分）', function () {
    const view = buildReportView(family(), { portrait: '家庭画像', suggestions: '1. {{URGENT}}补充寿险' })
    expect(view.deep).not.toBeNull()
    expect(hasKey(view.chapters, 'next_steps')).toBe(false)
    expect(view.hero).not.toHaveProperty('topAdvice')
    expect(view.deep.suggestions).toContain('补充寿险')
  })
})

describe('内容统一（2026-10-18 用户决策）', function () {
  test('报告不再区分代理/客户：同一份数据产出的章节与结论完全一致', function () {
    const owner = buildReportView(family(), { portrait: '家庭画像' }, { view: 'owner' })
    const shared = buildReportView(family(), { portrait: '家庭画像' }, { view: 'shared' })
    expect(shared.chapters.map(c => c.key)).toEqual(owner.chapters.map(c => c.key))
    expect(shared.hero.alerts).toEqual(owner.hero.alerts)
  })

  test('统一后行动指向仍只有一处：规则层一律不给建议（都没有 next_steps）', function () {
    const withDeep = buildReportView(family(), { portrait: '家庭画像' }, { view: 'shared' })
    expect(hasKey(withDeep.chapters, 'next_steps')).toBe(false)
    expect(withDeep.hero).not.toHaveProperty('topAdvice')
    expect(withDeep.deep).toBeTruthy()

    const noDeep = buildReportView(family(), {}, { view: 'shared' })
    expect(hasKey(noDeep.chapters, 'next_steps')).toBe(false)
  })
})

describe('「已有保额」章（2026-10-27 起只列事实）', function () {
  test('带单位、只写已有保额；客户版与 owner 版逐字一致', function () {
    const view = buildReportView(family(), {}, { view: 'shared' })
    const gap = view.chapters.find(c => c.key === 'gap_analysis')
    expect(gap).toBeDefined()
    expect(gap.unit).toBe('单位：万元')
    expect(gap.content).toContain('万')
    // 推算段已删：不再出现需求/缺口/优先级
    expect(gap.content).not.toContain('需求')
    expect(gap.content).not.toContain('缺口')
    const ownerGap = buildReportView(family(), {}, { view: 'owner' }).chapters.find(c => c.key === 'gap_analysis')
    expect(gap.content).toBe(ownerGap.content)
  })

  test('章首说明「需求与缺口不在本报告内」', function () {
    const view = buildReportView(family(), {})
    const gap = view.chapters.find(c => c.key === 'gap_analysis')
    expect(gap.pre).toContain('不在本报告内')
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
  test('缴费章默认**展开**（2026-10-22 方案：非必要不折叠），附录仍默认折叠', function () {
    const ch = buildChapters(family(), {})
    const cal = ch.find(c => c.key === 'premium_calendar')
    const apx = ch.find(c => c.key === 'appendix_policies')
    // 缴费章承载"钱花在哪"（四段分布），折起来等于让客户多点一次
    expect(cal.collapsible).toBe(true)
    expect(cal.defaultCollapsed).toBe(false)
    // 附录是明细型（列表摘要 + 点击展开），方案明确允许折叠
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
