/**
 * report-builder 单测 — 纯函数（buildGaps / assessDataCompleteness / buildChapters）
 * 不依赖 wx，可直接 node 运行
 */
const { buildGaps, assessDataCompleteness, buildChapters, buildHero, buildCoverageMatrix, buildReportView } = require('../miniprogram/utils/report-builder')

describe('buildReportView — 报告聚合入口（候选 2 深模块）', () => {
  test('客户版视图（view=shared）：中性措辞 + 置信度章隐藏 + 仅保障期满节点 + 占收入比仅供参考', () => {
    const c = baseCustomer()
    c.policies = [
      { id: 'P1', insured_name: '李阳勇', insurance_category: '寿险', sum_assured: 1000000, annual_premium: 8000, effective_date: '1980-01-01', insurance_period: '至2060年12月31日', payment_period: '100年', status: 'active', field_confidence: { sum_assured: 0.8 } }
    ]
    const view = buildReportView(c, { conclusion: 'AI 结论' }, { view: 'shared' })
    // Hero 中性措辞：不写"缺少XX"
    const ly = view.hero.alerts.find(a => a.name === '李阳勇')
    expect(ly.ok).toBe(false)
    expect(ly.display).toBe('保障待完善')
    expect(ly.display).not.toContain('缺少')
    expect(view.hero.summary).toContain('保障待完善')
    expect(view.hero.summary).not.toContain('缺口')
    expect(view.hero.topAdvice).toContain('建议关注')
    expect(view.hero.topAdvice).not.toContain('补充')
    // 置信度告警章整章隐藏（客户版不可见内部置信度）
    expect(view.chapters.find(x => x.key === 'risk_alerts')).toBeUndefined()
    // 审计·顾问视角（2026-09-04）：客户版跳过①②（家庭结构/财务为顾问核对底稿，客户无需被告知自家信息）
    expect(view.chapters.find(x => x.key === 'family_structure')).toBeUndefined()
    expect(view.chapters.find(x => x.key === 'family_finance')).toBeUndefined()
    expect(view.chapters[0].key).toBe('coverage_summary') // 客户版从保障汇总开始
    // 保障汇总缺失提示中性化
    const cs = view.chapters.find(x => x.key === 'coverage_summary')
    expect(cs.pre).toContain('保障待完善')
    expect(cs.pre).not.toContain('缺少')
    // 缴费月历占收入比标注仅供参考
    const cal = view.chapters.find(x => x.key === 'premium_calendar')
    expect(cal.content).toContain('占家庭年收入')
    expect(cal.content).toContain('仅供参考')
    // 关键节点仅保留保障期满（交费期满/现价回本对客户隐藏）
    const tl = view.chapters.find(x => x.key === 'premium_timeline')
    const tlBlock = tl.customBlocks.find(b => b.t === 'timeline')
    expect(tlBlock.items.some(e => e.type === 'paydone' || e.type === 'breakeven')).toBe(false)
    // 缺口章（客户版仅缺口金额，不暴露"需求=…"公式）
    const gapS = view.chapters.find(x => x.key === 'gap_analysis')
    expect(gapS).toBeDefined()
    expect(gapS.content).not.toContain('需求')
    // 活报告模型（2026-09）：客户版移除⑧章（行动出口唯一化为 AI 行动清单）；owner 保留
    expect(view.chapters.find(x => x.key === 'next_steps')).toBeUndefined()
  })

  test('单接口返回全部视图数据（无告警时 8 章 + Hero + 摘要卡 + gaps + hints）', () => {
    const c = baseCustomer()
    const view = buildReportView(c, { conclusion: 'AI 结论', disclaimer: '免责' })
    // 审计·顾问视角（2026-09-04）：新增 ④保障缺口 + 行动收口两章 → 无告警 owner 版 = 8 章
    expect(view.chapters.length).toBe(8)
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
    expect(view.chapters.length).toBe(8)
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

  test('P1-A：支柱收入缺失 → 用家庭收入全额兜底（非均摊），寿险缺口不低估', () => {
    const c = baseCustomer()
    // 支柱本人收入清空，家庭收入 30 保留
    c.members.forEach(m => { if (m.role === '本人') m.income = 0 })
    c.family_income = '30'
    const gaps = buildGaps(c)
    const g = gaps.find(x => x.member === '李阳勇' && x.category === '寿险')
    expect(g.reliability).toBe('estimated') // 家庭收入兜底 = 估算
    // 需求 = 负债150 + 5×30 = 300（均摊旧逻辑会给 5×10=50，严重低估）
    expect(g.reference).toBe(300)
  })

  test('P1-A：非支柱收入缺失 → 按 0 而非均摊（不产生虚假收入/虚高缺口）', () => {
    const c = baseCustomer()
    // 谢敏收入清空（全职配偶场景），家庭收入 30 保留
    c.members.forEach(m => { if (m.role === '配偶') m.income = 0 })
    c.family_income = '30'
    const gaps = buildGaps(c)
    const sp = gaps.find(x => x.member === '谢敏' && x.category === '寿险')
    // 旧逻辑均摊 10 万 → estimated + gap；新口径收入缺失 → blocked（诚实标注无法计算）
    expect(sp.reliability).toBe('blocked')
    expect(sp.gap).toBeNull()
    // 本人收入不受影响
    const ly = gaps.find(x => x.member === '李阳勇' && x.category === '寿险')
    expect(ly.reliability).toBe('confirmed')
    expect(ly.reference).toBe(300) // 150+5×30
  })

  test('按优先级+缺口额排序：高优先生', () => {
    const gaps = buildGaps(baseCustomer())
    expect(gaps[0].priority).toBe('high')
  })
})

// 2026-09-10 三态修复回归：blocked（收入缺失致寿险/意外无法计算）的 gap 为 null，
// 原实现被 `g.gap > 0` 过滤 → 该类成员被判"保障覆盖完整"（绿点），把未知说成完整
describe('buildHero — 三态（缺口 / 待补 / 完整）', () => {
  test('无确切缺口但存在 blocked → 不得判为"保障覆盖完整"', () => {
    const c = baseCustomer()
    c.family_income = 0
    c.members.forEach(m => { m.income = 0 })
    // 李阳勇：重疾 50 万 + 医疗 200 万（均达标）；但无收入 → 寿险/意外 blocked
    c.policies = [
      { insured_name: '李阳勇', insurance_category: '重疾险', sum_assured: 500000, status: 'active' },
      { insured_name: '李阳勇', insurance_category: '医疗险', sum_assured: 2000000, status: 'active' }
    ]
    const hero = buildHero(c, buildGaps(c))
    const ly = hero.alerts.find(a => a.name === '李阳勇')
    expect(ly.missing).toEqual([])   // 无确切缺口
    expect(ly.blocked).toBe(true)    // 待补数据态
    expect(ly.ok).toBe(false)        // 关键：绝不能判为完整
    expect(ly.display).toContain('待确认')
    expect(hero.summary).toContain('数据待补')
  })

  test('数据齐全且保障达标 → ok 为真、显示保障覆盖完整', () => {
    const c = baseCustomer()
    c.policies = [
      { insured_name: '李阳勇', insurance_category: '寿险', sum_assured: 3000000, status: 'active' },
      { insured_name: '李阳勇', insurance_category: '重疾险', sum_assured: 500000, status: 'active' },
      { insured_name: '李阳勇', insurance_category: '医疗险', sum_assured: 2000000, status: 'active' },
      { insured_name: '李阳勇', insurance_category: '意外险', sum_assured: 1500000, status: 'active' }
    ]
    const hero = buildHero(c, buildGaps(c))
    const ly = hero.alerts.find(a => a.name === '李阳勇')
    expect(ly.ok).toBe(true)
    expect(ly.blocked).toBe(false)
    expect(ly.display).toBe('保障覆盖完整')
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
    // 2026-09-10 三态修正：有收入的成员（李阳勇/谢敏）确实为"完整"；
    // 李牧云为子女、无个人收入 → 意外险需求公式（max(5×收入, 负债)）无法计算 → 归为 blocked「待确认」，
    // 原断言「全员 ok」锁定的正是"把未知说成完整"的旧行为
    expect(h.alerts.find(a => a.name === '李阳勇').ok).toBe(true)
    expect(h.alerts.find(a => a.name === '谢敏').ok).toBe(true)
    const lmy = h.alerts.find(a => a.name === '李牧云')
    expect(lmy.ok).toBe(false)
    expect(lmy.blocked).toBe(true)
    expect(lmy.display).toContain('待确认')
    expect(h.summary).toContain('数据待补')
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

  test('章节顺序：1家庭结构 → 2家庭财务 → 3保障汇总 → 4保障缺口 → 5保障节点 → 6缴费月历 → 7下一步行动 → 附录保单明细（无告警时特别提醒章跳过）', () => {
    const ch = buildChapters(reportCustomer(), report)
    const keys = ch.map(x => x.key)
    // 设计稿 v4 + 审计·顾问视角（2026-09-04）：缺口诊断独立成章（汇总后），行动收口在附录前（报告以行动收束）
    expect(keys).toEqual(['family_structure', 'family_finance', 'coverage_summary', 'gap_analysis', 'premium_timeline', 'premium_calendar', 'next_steps', 'appendix_policies'])
  })

  test('缺口章④：内容含缺口金额与优先级；收口章：行动清单收束；正式章编号连续 1..N', () => {
    const ch = buildChapters(reportCustomer(), report)
    const gap = ch.find(x => x.key === 'gap_analysis')
    expect(gap).toBeDefined()
    expect(gap.num).toBe('4')
    expect(gap.content).toContain('缺口')
    expect(gap.content).toContain('万')
    expect(gap.content).toContain('优先级')
    const next = ch.find(x => x.key === 'next_steps')
    expect(next).toBeDefined()
    expect(next.num).toBe('7') // 无告警：收口在月历⑥之后、附录前
    expect(next.content).toContain('优先为')
    // 统一编号：正式章 1..7 连续（附录不编号）
    const nums = ch.filter(x => x.key !== 'appendix_policies').map(x => x.num)
    expect(nums).toEqual(['1', '2', '3', '4', '5', '6', '7'])
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
    expect(fin.customBlocks[0].income).toBe(30) // 2026-09-06 修复：家庭财务章取家庭收入源（family_income/financial_snapshot.income），非成员收入合计(30+15)
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

  test('缴费月历章：12 格 + 峰值月高亮（语义定位，不依赖章节序号）', () => {
    const ch = buildChapters(reportCustomer(), report)
    const calCh = ch.find(x => x.key === 'premium_calendar')
    expect(calCh).toBeDefined()
    const cal = calCh.customBlocks.find(b => b.t === 'calendar')
    expect(cal).toBeDefined()
    expect(cal.items.length).toBe(12)
    expect(cal.items[0].h).toBe(2) // 1月生效 → 峰值高亮
    expect(calCh.content).toContain('缴费压力最大')
  })

  test('保障节点章：排除每年缴费事件，仅保留到期/缴满关键节点（设计稿 v4，语义定位）', () => {
    const c = reportCustomer()
    // 带未来保障期限 + 缴费期限：产出 expiry（至2060）与 paydone（缴完100年）；buildTimeline 仅保留未来事件
    c.policies = [Object.assign({}, c.policies[0], { insurance_period: '至2060年12月31日', payment_period: '100年' })]
    const ch = buildChapters(c, report)
    const tlCh = ch.find(x => x.key === 'premium_timeline')
    expect(tlCh).toBeDefined()
    const tl = tlCh.customBlocks.find(b => b.t === 'timeline')
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

  test('附录保单明细：被保人→保司二级分组卡片（含展示字段）', () => {
    const ch = buildChapters(reportCustomer(), report)
    const ap = ch.find(x => x.key === 'appendix_policies')
    expect(ap).toBeDefined()
    const pc = ap.customBlocks.find(b => b.t === 'policy_cards')
    expect(pc).toBeDefined()
    expect(pc.groups.length).toBe(1)
    expect(pc.groups[0].name).toBe('李阳勇')
    // 二级分组：保司子组（无 insurer 数据归「未知保司」）
    expect(pc.groups[0].subgroups.length).toBe(1)
    expect(pc.groups[0].subgroups[0].name).toBe('未知保司')
    const p = pc.groups[0].subgroups[0].policies[0]
    expect(p.sum_display).toBe('100万')
    expect(p.premium_display).toBe('8000元')
    // 有效保单数从底部 note 提升至标题右侧 unit
    expect(ap.unit).toContain('1 份')
    expect(ap.note).toBeUndefined()
    // 附录不作为编号章节（无 num）
    expect(ap.num).toBeUndefined()
  })

  test('置信度告警：低置信度/待确认保单进特别提醒章（带核对定位数据）', () => {
    const c = reportCustomer()
    c.policies.push({ id: 'P1', insured_name: '谢敏', insurance_category: '医疗险', sum_assured: 2000000, annual_premium: 800, effective_date: '2022-03-01', status: 'active', need_review: true })
    c.policies.push({ id: 'P2', insured_name: '李阳勇', insurance_category: '重疾险', sum_assured: 500000, status: 'active', field_confidence: { sum_assured: 0.8 } })
    const ch = buildChapters(c, report)
    const raCh = ch.find(x => x.key === 'risk_alerts')
    expect(raCh).toBeDefined()
    expect(raCh.title).toBe('特别提醒')
    const ra = raCh.customBlocks.find(b => b.t === 'risk_alerts')
    expect(ra.items.length).toBe(2)
    // need_review → 定位到保额字段
    expect(ra.items[0].issue).toContain('人工确认')
    expect(ra.items[0].policy_id).toBe('P1')
    expect(ra.items[0].field).toBe('sum_assured')
    // 字段置信度低 → 携带低置信字段名
    expect(ra.items[1].policy_id).toBe('P2')
    expect(ra.items[1].field).toBe('sum_assured')
  })

  test('保单卡片：储蓄型现价表 → 当前年份现金价值展示（owner 与 shared 均显示）', () => {
    const now = new Date()
    const curYear = now.getFullYear()
    const effYear = curYear - 2 // 保单年度 = 当前年-生效年+1 = 3
    const c = reportCustomer()
    c.policies = [Object.assign({}, c.policies[0], {
      id: 'pol_cash', effective_date: effYear + '-06-15',
      cashValues: null
    })]
    c.cashValues = [
      { policy_id: 'pol_cash', cash_values: [{ y: 1, v: 100 }, { y: 3, v: 300 }, { y: 5, v: 500 }] }
    ]
    // 现价 = v(每万元表值) × scale(保额万数=100) = 300×100 = 30000元 = 3万
    const chOwner = buildChapters(c, report)
    const pcOwner = chOwner.find(x => x.key === 'appendix_policies').customBlocks.find(b => b.t === 'policy_cards')
    expect(pcOwner.groups[0].subgroups[0].policies[0].cash_display).toBe('当前现价 3万')
    // shared 视图同样展示（用户决策：代理人/客户均展示）
    const chShared = buildChapters(c, report, null, { view: 'shared' })
    const pcShared = chShared.find(x => x.key === 'appendix_policies').customBlocks.find(b => b.t === 'policy_cards')
    expect(pcShared.groups[0].subgroups[0].policies[0].cash_display).toBe('当前现价 3万')
  })

  // 2026-09-10：移除「保障期已过」标签（用户决策：一年期产品默认有效，除非手动改状态）。
  // 产品规则不变（policy-status.js 的一年期豁免保留，已过期保单仍判 active 并计入保额/覆盖），
  // 但卡片不再输出 expiry_passed——原标签与「有效」并列会误导用户以为保障已失效。
  test('一年期已过期保单仍判有效（业务规则），卡片不再输出 expiry_passed', () => {
    const c = baseCustomer()
    c.policies = [
      { id: 'P_exp', insured_name: '李阳勇', insurance_category: '医疗险', sum_assured: 4000000, annual_premium: 381,
        contract_effective_date: '2020-05-20', effective_date: '2020-05-20',
        insurance_period: '至2021年05月19日', status: 'active' }
    ]
    const ch = buildChapters(c, {})
    const pc = ch.find(x => x.key === 'appendix_policies').customBlocks.find(b => b.t === 'policy_cards')
    const p = pc.groups[0].subgroups[0].policies[0]
    expect(p.status).toBe('active') // 一年期默认有效，不因到期日已过自动失效
    expect(p.status_label).toBe('有效')
    expect(p).not.toHaveProperty('expiry_passed') // 标签已移除，防回归
  })

  test('无现价表 / 未生效 / 表超出当前年度 → 现金价值不展示', () => {
    const now = new Date()
    const curYear = now.getFullYear()
    // 无现价表
    const c1 = reportCustomer()
    c1.policies = [Object.assign({}, c1.policies[0], { id: 'pol_a' })]
    expect(chapterCashDisplay(c1)).toBe('')
    // 未生效（生效年在未来）
    const c2 = reportCustomer()
    c2.policies = [Object.assign({}, c2.policies[0], { id: 'pol_b', effective_date: (curYear + 1) + '-01-01' })]
    c2.cashValues = [{ policy_id: 'pol_b', cash_values: [{ y: 1, v: 1000 }] }]
    expect(chapterCashDisplay(c2)).toBe('')
    // 现金价值表 y 起始大于当前保单年度（表数据异常）→ 不展示
    const c3 = reportCustomer()
    c3.policies = [Object.assign({}, c3.policies[0], { id: 'pol_c', effective_date: (curYear - 5) + '-01-01' })]
    c3.cashValues = [{ policy_id: 'pol_c', cash_values: [{ y: 100, v: 1000 }] }]
    expect(chapterCashDisplay(c3)).toBe('')
  })

  test('无保单时：矩阵全缺失格、时间轴为空、附录无分组', () => {
    const c = baseCustomer()
    c.policies = []
    const ch = buildChapters(c, {})
    const pano = ch.find(x => x.key === 'coverage_summary').customBlocks.find(b => b.t === 'panorama')
    expect(pano.rows[0].cells[0].s).toBe('missing')
    const tl = ch.find(x => x.key === 'premium_timeline').customBlocks.find(b => b.t === 'timeline')
    expect(tl.items.length).toBe(0)
    const pc = ch.find(x => x.key === 'appendix_policies').customBlocks.find(b => b.t === 'policy_cards')
    expect(pc.groups.length).toBe(0)
  })
})

// 取附录首张保单卡片的现金价值展示串（辅助断言）
function chapterCashDisplay(c) {
  const ch = buildChapters(c, {})
  const pc = ch.find(x => x.key === 'appendix_policies').customBlocks.find(b => b.t === 'policy_cards')
  const first = pc.groups[0].subgroups[0].policies[0]
  return first.cash_display || ''
}
