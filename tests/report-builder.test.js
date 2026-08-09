/**
 * report-builder 单测 — 纯函数（buildGaps / assessDataCompleteness / buildChapters）
 * 不依赖 wx，可直接 node 运行
 */
const { buildGaps, assessDataCompleteness, buildChapters, buildHero, buildCoverageMatrix, buildReportView } = require('../miniprogram/utils/report-builder')

describe('buildReportView — 报告聚合入口（候选 2 深模块）', () => {
  test('单接口返回全部视图数据（无告警时 6 章 + Hero + 摘要卡 + gaps + hints）', () => {
    const c = baseCustomer()
    const view = buildReportView(c, { conclusion: 'AI 结论', disclaimer: '免责' })
    expect(view.chapters.length).toBe(6)
    expect(view.chapters[0].key).toBe('family_structure')
    expect(view.hero.alerts.length).toBe(3)
    expect(view.hero.conclusion).toBe('AI 结论')
    expect(view.summaryCards.count).toBe(1) // 保障人数=有 active 保单的去重成员数（李阳勇1人）
    expect(view.summaryCards.premium).toBe('0') // baseCustomer 保单无 annual_premium
    expect(view.gaps.length).toBeGreaterThan(0)
    expect(view.hints).toEqual([])
  })

  test('无报告对象 → 视图仍完整（conclusion 空）', () => {
    const view = buildReportView(baseCustomer(), null)
    expect(view.chapters.length).toBe(6)
    expect(view.hero.conclusion).toBe('')
    expect(view.hints).toEqual([])
  })
})

// 基准家庭：李阳勇(本人,收入30) / 谢敏(配偶,收入15) / 李牧云(子女)
// 负债150万，仅李阳勇有寿险100万
// 注意：sum_assured 单位为元（生产契约），100万 → 1000000
function baseCustomer() {
  return {
    members: [
      { name: '李阳勇', role: '本人', income: 30, birth_date: '1980-01-01' },
      { name: '谢敏', role: '配偶', income: 15, birth_date: '1982-03-15' },
      { name: '李牧云', role: '子女', birth_date: '2010-06-01' }
    ],
    policies: [
      { insured_name: '李阳勇', insurance_category: '寿险', sum_assured: 1000000, status: 'active' }
    ],
    debt: { amount: 150 },
    family_income: '30'
  }
}

describe('buildGaps — 成员个人收入口径', () => {
  test('经济支柱寿险缺口 = 负债+5×个人收入 - 现有', () => {
    const gaps = buildGaps(baseCustomer())
    const g = gaps.find(x => x.member === '李阳勇' && x.category === '寿险')
    expect(g).toBeDefined()
    expect(g.existing).toBe(100)
    expect(g.reference).toBe(150 + 5 * 30) // 300
    expect(g.gap).toBe(200)
    expect(g.reliability).toBe('confirmed')
    expect(g.priority).toBe('high')
  })

  test('配偶寿险用其个人收入计算（非家庭总收入）', () => {
    const gaps = buildGaps(baseCustomer())
    const g = gaps.find(x => x.member === '谢敏' && x.category === '寿险')
    expect(g.reference).toBe(150 + 5 * 15) // 225
    expect(g.gap).toBe(225)
  })

  test('收入缺失 → 寿险/意外 blocked（gap=null）', () => {
    const c = baseCustomer()
    c.members.forEach(m => { m.income = 0 })
    c.family_income = '0'
    const gaps = buildGaps(c)
    const life = gaps.find(x => x.member === '李阳勇' && x.category === '寿险')
    const acc = gaps.find(x => x.member === '李阳勇' && x.category === '意外险')
    expect(life.reliability).toBe('blocked')
    expect(life.gap).toBeNull()
    expect(acc.reliability).toBe('blocked')
    // 重疾/医疗不依赖收入，仍算（但参考值固定，标 estimated 非 confirmed）
    const ci = gaps.find(x => x.member === '李阳勇' && x.category === '重疾险')
    expect(ci.reliability).toBe('estimated')
    expect(ci.gap).toBe(50)
  })

  test('子女不需要寿险（角色需求模型）', () => {
    const gaps = buildGaps(baseCustomer())
    const life = gaps.find(x => x.member === '李牧云' && x.category === '寿险')
    expect(life).toBeUndefined()
  })

  test('按优先级+缺口额排序：高优先生', () => {
    const gaps = buildGaps(baseCustomer())
    expect(gaps[0].priority).toBe('high')
  })
})

describe('assessDataCompleteness — 完整度透视', () => {
  test('数据齐全 → complete', () => {
    const r = assessDataCompleteness(baseCustomer())
    expect(r.complete).toBe(true)
    expect(r.items.every(i => i.ok)).toBe(true)
  })

  test('缺年收入 → 标记缺失且 hint 存在', () => {
    const c = baseCustomer()
    c.members.forEach(m => { m.income = 0 })
    c.family_income = '0'
    const r = assessDataCompleteness(c)
    expect(r.complete).toBe(false)
    const inc = r.items.find(i => i.name === '年收入')
    expect(inc.ok).toBe(false)
    expect(inc.hint.length).toBeGreaterThan(0)
  })
})

describe('buildCoverageMatrix — 保障覆盖矩阵（第 2 章数据源）', () => {
  test('成员×险种矩阵：缺失格 missing / 覆盖格 ok / 底部险种合计（无行内合计列）', () => {
    const c = baseCustomer() // 李阳勇仅寿险100万
    const m = buildCoverageMatrix(c.members, c.policies)
    expect(m.heads).toEqual(['成员', '重疾险', '医疗险', '意外险', '寿险'])
    expect(m.rows.length).toBe(4) // 3 成员 + 底部合计行
    const ly = m.rows.find(r => r.name === '李阳勇')
    expect(ly.cells[0].s).toBe('missing') // 重疾险缺失
    expect(ly.cells[3]).toEqual({ v: '100', s: 'ok' }) // 寿险
    expect(ly.cells.length).toBe(4) // 无行内合计列
    const total = m.rows[3]
    expect(total.name).toBe('合计')
    expect(total.cells[3].v).toBe('100') // 寿险列合计
  })

  test('deleted/cancelled 保单不计入矩阵', () => {
    const c = baseCustomer()
    c.policies = [
      { insured_name: '李阳勇', insurance_category: '寿险', sum_assured: 1000000, status: 'deleted' },
      { insured_name: '谢敏', insurance_category: '医疗险', sum_assured: 500000, status: 'active' }
    ]
    const m = buildCoverageMatrix(c.members, c.policies)
    const xm = m.rows.find(r => r.name === '谢敏')
    expect(xm.cells[1].v).toBe('50') // 医疗险 50 万（deleted 不计入）
    expect(xm.cells[3].v).toBe('—') // 寿险无 active 保单 → 缺失格
    const total = m.rows[3]
    expect(total.cells[1].v).toBe('50') // 医疗险列合计
    expect(total.cells[3].v).toBe('—') // 寿险列无合计 → 缺失格
  })
})

describe('buildHero — 保障覆盖检查（Hero 数据源）', () => {
  test('缺口成员警示 + 完整成员勾选 + 总结', () => {
    const c = baseCustomer()
    const gaps = buildGaps(c)
    const h = buildHero(c, gaps)
    expect(h.alerts.length).toBe(3)
    const ly = h.alerts.find(a => a.name === '李阳勇')
    expect(ly.ok).toBe(false)
    expect(ly.missing).toContain('重疾')
    expect(ly.missing).toContain('寿险') // gap>0 即视为缺口
    expect(ly.display).toContain('缺少')
    expect(h.summary).toBe('3位成员中，3位存在缺口')
    expect(h.topAdvice).toContain('补充')
  })

  test('无缺口成员显示覆盖完整', () => {
    const c = baseCustomer()
    // 给所有成员补齐四险
    c.policies = [
      { insured_name: '李阳勇', insurance_category: '重疾险', sum_assured: 500000, status: 'active' },
      { insured_name: '李阳勇', insurance_category: '医疗险', sum_assured: 2000000, status: 'active' },
      { insured_name: '李阳勇', insurance_category: '意外险', sum_assured: 5000000, status: 'active' },
      { insured_name: '李阳勇', insurance_category: '寿险', sum_assured: 10000000, status: 'active' },
      { insured_name: '谢敏', insurance_category: '重疾险', sum_assured: 500000, status: 'active' },
      { insured_name: '谢敏', insurance_category: '医疗险', sum_assured: 2000000, status: 'active' },
      { insured_name: '谢敏', insurance_category: '意外险', sum_assured: 5000000, status: 'active' },
      { insured_name: '谢敏', insurance_category: '寿险', sum_assured: 10000000, status: 'active' },
      { insured_name: '李牧云', insurance_category: '重疾险', sum_assured: 500000, status: 'active' },
      { insured_name: '李牧云', insurance_category: '医疗险', sum_assured: 2000000, status: 'active' },
      { insured_name: '李牧云', insurance_category: '意外险', sum_assured: 5000000, status: 'active' }
    ]
    const gaps = buildGaps(c)
    const h = buildHero(c, gaps)
    expect(h.alerts.every(a => a.ok)).toBe(true)
    expect(h.summary).toBe('3位成员中，0位存在缺口')
    expect(h.topAdvice).toBe('')
  })
})

describe('buildChapters — 基础版报告 6 章单页结构', () => {
  // 带完整字段的报告样本（含生效日/保费，供缴费月历/年历测试）
  function reportCustomer() {
    const c = baseCustomer()
    c.policies = [
      { insured_name: '李阳勇', insurance_category: '寿险', sum_assured: 1000000, annual_premium: 8000, effective_date: '1980-01-01', contract_end_date: '2027-12-31', status: 'active' }
    ]
    return c
  }
  const report = { disclaimer: '免责' }

  test('章节顺序：1家庭结构 → 2家庭财务 → 3保障汇总 → 4缴费月历 → 5缴费年历 → 6附录保单明细（无告警时特别提醒章跳过）', () => {
    const ch = buildChapters(reportCustomer(), report)
    const keys = ch.map(x => x.key)
    expect(keys).toEqual(['family_structure', 'family_finance', 'coverage_summary', 'premium_calendar', 'premium_timeline', 'appendix_policies'])
  })

  test('家庭结构章：成员节点（角色分组排序）；财务独立成章', () => {
    const ch = buildChapters(reportCustomer(), report)
    const ft = ch[0].customBlocks.find(b => b.t === 'family_tree')
    expect(ft).toBeDefined()
    expect(ft.nodes.length).toBe(3)
    expect(ft.nodes[0].name).toBe('李阳勇') // 本人组排前
    expect(ft.nodes[0].display).toBe('本人')
    // 财务已拆为独立章（家庭结构之后）
    const fin = ch[1]
    expect(fin.key).toBe('family_finance')
    expect(fin.num).toBe('2')
    expect(fin.customBlocks[0].t).toBe('finance')
    expect(fin.customBlocks[0].income).toBe(45) // 30+15
    expect(ft.finance).toBeUndefined()
  })

  test('家庭结构章：成员平铺（nodes 数组，角色分组排序），无 levels 分层', () => {
    // fixture 成员：本人/配偶/子女 → 平铺 3 节点（本人→配偶→子女 按角色组序）
    const ch = buildChapters(reportCustomer(), report)
    const ft = ch[0].customBlocks.find(b => b.t === 'family_tree')
    expect(ft.levels).toBeUndefined()
    expect(ft.nodes.length).toBe(3)
    expect(ft.nodes[0].role).toBe('本人')
    expect(ft.nodes[1].role).toBe('配偶')
    expect(ft.nodes[2].role).toBe('子女')
  })

  test('保障汇总章：覆盖矩阵（成员×险种 + 合计行）+ 缺失提示', () => {
    const ch = buildChapters(reportCustomer(), report)
    const cs = ch[2]
    const pano = cs.customBlocks.find(b => b.t === 'panorama')
    expect(pano).toBeDefined()
    expect(pano.heads).toEqual(['成员', '重疾险', '医疗险', '意外险', '寿险'])
    expect(pano.rows.length).toBe(4) // 3 成员 + 底部险种合计行
    const ly = pano.rows.find(r => r.name === '李阳勇')
    const life = ly.cells.find(c => c.s === 'ok')
    expect(life.v).toBe('100')
    expect(ly.cells[0].s).toBe('missing') // 重疾险缺失浅红格
    expect(cs.pre).toContain('李阳勇缺少')
  })

  test('缴费月历章：12 格 + 峰值月高亮', () => {
    const ch = buildChapters(reportCustomer(), report)
    const cal = ch[3].customBlocks.find(b => b.t === 'calendar')
    expect(cal).toBeDefined()
    expect(cal.items.length).toBe(12)
    expect(cal.items[0].h).toBe(2) // 1月生效 → 峰值高亮
    expect(ch[3].content).toContain('缴费压力最大')
  })

  test('缴费年历章：排除每年缴费事件，仅保留到期/缴满关键节点（设计稿 v4）', () => {
    const c = reportCustomer()
    // 带未来保障期限 + 缴费期限：产出 expiry（至2060）与 paydone（缴完100年）；buildTimeline 仅保留未来事件
    c.policies = [Object.assign({}, c.policies[0], { insurance_period: '至2060年12月31日', payment_period: '100年' })]
    const ch = buildChapters(c, report)
    const tl = ch[4].customBlocks.find(b => b.t === 'timeline')
    expect(tl).toBeDefined()
    // 不再展示每年缴费提醒
    expect(tl.items.find(e => e.type === 'payment')).toBeUndefined()
    // 到期/缴满关键节点保留
    expect(tl.items.some(e => e.type === 'expiry' || e.type === 'paydone')).toBe(true)
    expect(tl.items.every(e => e.type !== 'payment')).toBe(true)
  })

  test('无置信度告警时：特别提醒章整章跳过（免责声明已移至页面底部）', () => {
    const ch = buildChapters(reportCustomer(), report)
    expect(ch.find(x => x.key === 'risk_alerts')).toBeUndefined()
    expect(ch.find(x => x.key === 'appendix_policies')).toBeDefined()
  })

  test('附录保单明细：按成员分组卡片（含展示字段）', () => {
    const ch = buildChapters(reportCustomer(), report)
    const pc = ch[5].customBlocks.find(b => b.t === 'policy_cards')
    expect(pc).toBeDefined()
    expect(pc.groups.length).toBe(1)
    expect(pc.groups[0].name).toBe('李阳勇')
    const p = pc.groups[0].policies[0]
    expect(p.sum_display).toBe('100万')
    expect(p.premium_display).toBe('8000元')
    // 有效保单数从底部 note 提升至标题右侧 unit
    expect(ch[5].unit).toContain('1 份')
    expect(ch[5].note).toBeUndefined()
    // 附录不作为编号章节（无 num）
    expect(ch[5].num).toBeUndefined()
  })

  test('置信度告警：低置信度/待确认保单进特别提醒章（带核对定位数据）', () => {
    const c = reportCustomer()
    c.policies.push({ id: 'P1', insured_name: '谢敏', insurance_category: '医疗险', sum_assured: 2000000, annual_premium: 800, effective_date: '2022-03-01', status: 'active', need_review: true })
    c.policies.push({ id: 'P2', insured_name: '李阳勇', insurance_category: '重疾险', sum_assured: 500000, status: 'active', field_confidence: { sum_assured: 0.8 } })
    const ch = buildChapters(c, report)
    expect(ch[5].title).toBe('特别提醒')
    const ra = ch[5].customBlocks.find(b => b.t === 'risk_alerts')
    expect(ra.items.length).toBe(2)
    // need_review → 定位到保额字段
    expect(ra.items[0].issue).toContain('人工确认')
    expect(ra.items[0].policy_id).toBe('P1')
    expect(ra.items[0].field).toBe('sum_assured')
    // 字段置信度低 → 携带低置信字段名
    expect(ra.items[1].policy_id).toBe('P2')
    expect(ra.items[1].field).toBe('sum_assured')
  })

  test('无保单时：矩阵全缺失格、时间轴为空、附录无分组', () => {
    const c = baseCustomer()
    c.policies = []
    const ch = buildChapters(c, {})
    const pano = ch[2].customBlocks.find(b => b.t === 'panorama')
    expect(pano.rows[0].cells[0].s).toBe('missing')
    const tl = ch[4].customBlocks.find(b => b.t === 'timeline')
    expect(tl.items.length).toBe(0)
    const pc = ch[5].customBlocks.find(b => b.t === 'policy_cards')
    expect(pc.groups.length).toBe(0)
  })
})
