/**
 * report-builder 单测 — 纯函数（buildGaps / assessDataCompleteness / buildChapters）
 * 不依赖 wx，可直接 node 运行
 */
const { buildGaps, assessDataCompleteness, buildChapters, buildHero, buildCoverageMatrix, buildReportView, buildDeepAnalysis } = require('../miniprogram/utils/report-builder')

// 2026-09-18 报告页审计：core_insights 的**存储契约仍是字符串数组**（report-fields.js 有字段契约测试），
// 这里只锁"视图层包装成 {key,text}"这一层——原 WXML 用 wx:key="*this"（字符串自身），重复文本会碰撞
describe('buildDeepAnalysis — core_insights 视图包装', () => {
  test('输出 {key,text}，且重复文本也能得到唯一 key', () => {
    const d = buildDeepAnalysis({ core_insights: ['重疾缺口50万', '重疾缺口50万'] })
    expect(d.insights).toEqual([
      { key: 'ins0', text: '重疾缺口50万' },
      { key: 'ins1', text: '重疾缺口50万' }
    ])
    expect(new Set(d.insights.map(x => x.key)).size).toBe(2)
  })

  test('无 core_insights → 空数组（不产生 undefined）', () => {
    expect(buildDeepAnalysis({ review: '有点评' }).insights).toEqual([])
  })
})

describe('buildReportView — 报告聚合入口（候选 2 深模块）', () => {
  test('报告内容不分代理/客户（2026-10-18 决策）：view=shared 与 owner 产出完全一致', () => {
    const c = baseCustomer()
    c.policies = [
      { id: 'P1', insured_name: '李阳勇', insurance_category: '寿险', sum_assured: 1000000, annual_premium: 8000, effective_date: '1980-01-01', insurance_period: '至2060年12月31日', payment_period: '100年', status: 'active', field_confidence: { sum_assured: 0.8 } }
    ]
    const view = buildReportView(c, { conclusion: 'AI 结论' }, { view: 'shared' })
    const owner = buildReportView(c, { conclusion: 'AI 结论' }, { view: 'owner' })

    // ① 章节集合与顺序一致（含家庭结构/财务、置信度告警）
    expect(view.chapters.map(x => x.key)).toEqual(owner.chapters.map(x => x.key))
    expect(view.chapters.find(x => x.key === 'family_structure')).toBeDefined()
    expect(view.chapters.find(x => x.key === 'family_finance')).toBeDefined()
    // 置信度告警不再对客户隐藏（这一条是本次决策的直接后果：客户也会看到"字段识别存疑"）
    expect(view.chapters.find(x => x.key === 'risk_alerts')).toBeDefined()

    // ② 措辞统一为 owner 口径：区分"缺少"与"保额不足"，不再用中性话术
    const ly = view.hero.alerts.find(a => a.name === '李阳勇')
    expect(ly.ok).toBe(false)
    expect(ly.display).toContain('缺少')
    expect(ly.display).toBe(owner.hero.alerts.find(a => a.name === '李阳勇').display)
    const cs = view.chapters.find(x => x.key === 'coverage_summary')
    expect(cs.pre).toContain('缺少')
    expect(cs.pre).toBe(owner.chapters.find(x => x.key === 'coverage_summary').pre)

    // ③ 保费占收入比、时间线全部节点、缺口公式：两边一致
    const cal = view.chapters.find(x => x.key === 'premium_calendar')
    expect(cal.content).toBe(owner.chapters.find(x => x.key === 'premium_calendar').content)
    const tlBlock = view.chapters.find(x => x.key === 'premium_timeline').customBlocks.find(b => b.t === 'timeline')
    expect(tlBlock.items.length).toBe(
      owner.chapters.find(x => x.key === 'premium_timeline').customBlocks.find(b => b.t === 'timeline').items.length
    )
    expect(view.chapters.find(x => x.key === 'gap_analysis').content)
      .toBe(owner.chapters.find(x => x.key === 'gap_analysis').content)

    // ④ 概览仍是第 1 章
    expect(view.chapters[0].key).toBe('overview')
  })

  test('单接口返回全部视图数据（无告警时 10 章 + Hero + 摘要卡 + gaps + hints）', () => {
    const c = baseCustomer()
    const view = buildReportView(c, { conclusion: 'AI 结论', disclaimer: '免责' })
    // 2026-10-21：概览 + 异常与待核验（A1–A6）+ 待完善；原「下一步行动」章已删除 → = 10 章
    // （概览 + 异常 + 家庭结构 + 财务 + 保障汇总 + 缺口 + 期间 + 月历 + 待完善 + 附录）
    expect(view.chapters.length).toBe(10)
    expect(view.chapters[0].key).toBe('overview')
    // 待完善必须是附录前最后一章（数据质量补录清单，不该插在诊断结论之间）
    const keys = view.chapters.map(x => x.key)
    expect(keys[keys.length - 2]).toBe('pending_data')
    // 概览章由 customBlock 承载（组件内渲染），不是 markdown 文本；字段平铺在 block 上
    const ov = view.chapters[0].customBlocks[0]
    expect(ov.t).toBe('overview')
    expect(ov.policyCount).toBeGreaterThan(0)
    expect(ov.payoutText).toBeTruthy()
    expect(ov.quotaText).toBeTruthy()
    expect(view.hero.alerts.length).toBe(3)
    expect(view.hero.conclusion).toBe('AI 结论')
    expect(view.summaryCards.count).toBe(1) // 保障人数=有 active 保单的去重成员数（李阳勇1人）
    expect(view.summaryCards.premium).toBe('0') // baseCustomer 保单无 annual_premium
    expect(view.gaps.length).toBeGreaterThan(0)
    expect(view.hints).toEqual([])
  })

  test('无报告对象 → 视图仍完整（conclusion 空）', () => {
    const view = buildReportView(baseCustomer(), null)
    expect(view.chapters.length).toBe(10)
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
  test('有保单但保额未填 → 显示 0 而非 —（真机截图矛盾：已覆盖险种列了年金、矩阵却是 —）', () => {
    const c = baseCustomer()
    c.policies = [
      Object.assign({}, c.policies[0]), // 李阳勇 寿险 100 万
      // 同一成员的年金保单：有这张保单，但保额没填（OCR 未识别到 / 用户未补）
      { id: 'P2', insured_name: '李阳勇', insurance_category: '年金', sum_assured: 0, status: 'active' }
    ]
    const m = buildCoverageMatrix(c.members, c.policies)
    const ly = m.rows.find(r => r.name === '李阳勇')
    // 年金列：有保单但没填保额 → 2026-10-21 起显示「持有」（方案：储蓄型列示年领/保额，
    // 没有可加总的保额时只表达"有没有"）；不能是 '—'（那会读成"没有年金"）
    expect(ly.cells[4]).toEqual({ v: '持有', s: '' })
    // 意外险列：确实没有这类保单 → 仍是 '—'
    expect(ly.cells[2]).toEqual({ v: '—', s: 'missing' })
  })

  test('保障险有保单但保额为 0 → 显示 0 且标 missing（与缺口引擎 existing=0 一致）', () => {
    const c = baseCustomer()
    c.policies = [{ id: 'P1', insured_name: '李阳勇', insurance_category: '重疾险', sum_assured: 0, status: 'active' }]
    const m = buildCoverageMatrix(c.members, c.policies)
    const ly = m.rows.find(r => r.name === '李阳勇')
    expect(ly.cells[0]).toEqual({ v: '0', s: 'missing' }) // 重疾险
  })

  test('成员×险种矩阵：缺失格 missing / 覆盖格 ok / 底部险种合计（无行内合计列）', () => {
    const c = baseCustomer() // 李阳勇仅寿险100万
    const m = buildCoverageMatrix(c.members, c.policies)
    // 2026-10-14：加「年金」列与「年保费」列（年金不参与缺失标红 —— 储蓄型，标红＝推荐买年金）
    expect(m.heads).toEqual(['成员', '重疾险', '医疗险', '意外险', '寿险', '年金', '年保费'])
    expect(m.rows.length).toBe(4) // 3 成员 + 底部合计行
    const ly = m.rows.find(r => r.name === '李阳勇')
    expect(ly.cells[0].s).toBe('missing') // 重疾险缺失
    expect(ly.cells[3]).toEqual({ v: '100', s: 'ok' }) // 寿险
    expect(ly.cells[4].s).toBe('') // 年金空缺：中性，不标 missing
    expect(ly.cells.length).toBe(6) // 5 险种 + 年保费（仍无"成员合计保额"列）
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
    // 2026-10-21（方案）：医疗险是报销型、保额不可加总 → 只标"有无"（✓），不再显示 50 万
    expect(xm.cells[1].v).toBe('✓')
    expect(xm.cells[3].v).toBe('—') // 寿险无 active 保单 → 缺失格
    const total = m.rows[3]
    expect(total.cells[1].v).toBe('✓') // 医疗险列合计同样只表达"有覆盖"
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
    // 2026-10-21：现阶段不做诊断 → hero 不再产出建议文案
    expect(h).not.toHaveProperty('topAdvice')
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
    expect(h).not.toHaveProperty('topAdvice')
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

  test('章节顺序：1家庭结构 → 2家庭财务 → 3保障汇总 → 4保障期间 → 5保障缺口 → 6缴费月历 → 7下一步行动 → 附录保单明细（无告警时特别提醒章跳过）', () => {
    const ch = buildChapters(reportCustomer(), report)
    const keys = ch.map(x => x.key)
    // 设计稿 v4 + 审计·顾问视角（2026-09-04）：缺口诊断独立成章，行动收口在附录前（报告以行动收束）。
    // 2026-10-13（报告结构 v2.0 ③）：保障期间（甘特图）提到保障汇总之后、缺口之前 ——
    // 2026-10-17 用户评审后调整：缺口紧跟保障汇总（"有没有 → 够不够"），保障期间（时间维）后置。
    // 2026-10-21：新增「异常与待核验」章（A1–A6）。它在"有异常时"才出现，且固定紧跟概览，
    // 所以这里先剔除再比顺序，另单独断言它的位置（避免用例依赖"本次有没有异常"）。
    // 2026-10-21：next_steps 章已删除（规则层不给建议）
    expect(keys.filter(k => k !== 'anomalies')).toEqual(['family_structure', 'family_finance', 'coverage_summary', 'gap_analysis', 'premium_timeline', 'premium_calendar', 'appendix_policies'])
    expect(keys).not.toContain('next_steps')
    if (keys.indexOf('anomalies') !== -1) {
      // buildChapters 直调时没有概览章（那需要 checkup），异常章应在第一位
      expect(keys[0]).toBe('anomalies')
    }
  })

  test('缺口章：内容含缺口金额与优先级；无行动建议章；正式章编号连续 1..N', () => {
    const ch = buildChapters(reportCustomer(), report)
    const gap = ch.find(x => x.key === 'gap_analysis')
    expect(gap).toBeDefined()
    // 编号按"存在哪些章"顺延：2026-10-21 起多了异常章（有异常时）→ 用位置断言而不是写死序号
    expect(gap.num).toBe(String(ch.indexOf(gap) + 1))
    expect(gap.content).toContain('缺口')
    expect(gap.content).toContain('万')
    expect(gap.content).toContain('优先级')
    // 2026-10-21：原「下一步行动」章删除 —— 规则报告只陈述事实，建议归 AI 进阶报告
    expect(ch.find(x => x.key === 'next_steps')).toBeUndefined()
    // 排序依据作为事实留在缺口章尾注（不再派任务）
    expect(gap.content).toContain('按缺口额与优先级排序')
    // 统一编号：正式章 1..N 连续（附录不编号）—— 不写死总数，只断言连续且从 1 开始
    const nums = ch.filter(x => x.key !== 'appendix_policies').map(x => x.num)
    expect(nums).toEqual(nums.map((_, i) => String(i + 1)))
  })

  // 2026-09-18 报告页审计：②章收入口径——未填写时曾直传 totalIncome=0 → 渲染"年收入 0万"，
  // 与⑦缴费月历章"（家庭年收入未填写，暂不计算占比）"矛盾（同一 owner 视图两章说法不一）
  test('家庭财务章：收入与成员收入均未填写 → income 传 null（防渲染"0万"）', () => {
    const c = reportCustomer()
    c.family_income = 0
    c.financial_snapshot = {}
    c.members = c.members.map(m => Object.assign({}, m, { income: 0 }))
    const fin = buildChapters(c, report).find(x => x.key === 'family_finance').customBlocks.find(b => b.t === 'finance')
    expect(fin.income).toBe(null)
  })

  test('家庭财务章：有收入 → income 为数值（不把"有值"误判成未填写）', () => {
    const c = reportCustomer()
    c.family_income = 20
    c.members = c.members.map(m => Object.assign({}, m, { income: 0 }))
    const fin = buildChapters(c, report).find(x => x.key === 'family_finance').customBlocks.find(b => b.t === 'finance')
    expect(fin.income).toBe(20)
  })

  test('家庭结构章：成员节点（角色分组排序）；财务独立成章', () => {
    const ch = buildChapters(reportCustomer(), report)
    // 2026-10-21：异常章可能插在首位 → 按 key 取，不按索引（索引会随"本次有无异常"漂移）
    const ft = ch.find(x => x.key === 'family_structure').customBlocks.find(b => b.t === 'family_tree')
    expect(ft).toBeDefined()
    expect(ft.nodes.length).toBe(3)
    expect(ft.nodes[0].name).toBe('李阳勇') // 本人组排前
    expect(ft.nodes[0].display).toBe('本人')
    // 财务已拆为独立章（家庭结构之后）
    const fin = ch.find(x => x.key === 'family_finance')
    expect(fin.key).toBe('family_finance')
    // 编号按存在章顺延（异常章可能插入），因此比位置而不是写死 '2'
    expect(fin.num).toBe(String(ch.indexOf(fin) + 1))
    expect(fin.customBlocks[0].t).toBe('finance')
    expect(fin.customBlocks[0].income).toBe(30) // 2026-09-06 修复：家庭财务章取家庭收入源（family_income/financial_snapshot.income），非成员收入合计(30+15)
    expect(ft.finance).toBeUndefined()
  })

  test('家庭结构章：成员平铺（nodes 数组，角色分组排序），无 levels 分层', () => {
    // fixture 成员：本人/配偶/子女 → 平铺 3 节点（本人→配偶→子女 按角色组序）
    const ch = buildChapters(reportCustomer(), report)
    // 2026-10-21：异常章可能插在首位 → 按 key 取，不按索引（索引会随"本次有无异常"漂移）
    const ft = ch.find(x => x.key === 'family_structure').customBlocks.find(b => b.t === 'family_tree')
    expect(ft.levels).toBeUndefined()
    expect(ft.nodes.length).toBe(3)
    expect(ft.nodes[0].role).toBe('本人')
    expect(ft.nodes[1].role).toBe('配偶')
    expect(ft.nodes[2].role).toBe('子女')
  })

  test('保障汇总章：覆盖矩阵（成员×险种 + 合计行）+ 缺失提示', () => {
    const ch = buildChapters(reportCustomer(), report)
    const cs = ch.find(x => x.key === 'coverage_summary')
    const pano = cs.customBlocks.find(b => b.t === 'panorama')
    expect(pano).toBeDefined()
    expect(pano.heads).toEqual(['成员', '重疾险', '医疗险', '意外险', '寿险', '年金', '年保费'])
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

  // 2026-09-18 报告页审计：附录卡补保单号/投保人/受益人（保单号=保司查档第一键；
  // 受益人此前全无展示，而 AI 会建议"指定受益人做资产隔离"→ 建议与现状脱节）
  test('附录卡：meta3 拼出保单号/投保人/受益人', () => {
    const c = reportCustomer()
    c.policies = [Object.assign({}, c.policies[0], {
      policy_number: 'P2024001', policyholder_name: '李阳勇', beneficiary_name: '王小明'
    })]
    const pc = buildChapters(c, report).find(x => x.key === 'appendix_policies').customBlocks.find(b => b.t === 'policy_cards')
    expect(pc.groups[0].subgroups[0].policies[0].meta3).toBe('保单号 P2024001 · 投保人 李阳勇 · 受益人 王小明')
  })

  test('附录卡：三项皆缺 → meta3 为空串（不做「未知 · 未知 · 未知」噪音，WXML 整行不渲染）', () => {
    const c = reportCustomer()
    const p0 = Object.assign({}, c.policies[0])
    delete p0.policy_number
    delete p0.policyholder_name
    delete p0.beneficiary_name
    c.policies = [p0]
    const pc = buildChapters(c, report).find(x => x.key === 'appendix_policies').customBlocks.find(b => b.t === 'policy_cards')
    expect(pc.groups[0].subgroups[0].policies[0].meta3).toBe('')
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

// ===== 2026-10-17 真机评审修的两处口径 =====
describe('保障汇总提示：区分「缺少」与「保额不足」', () => {
  test('有保单但低于需求 → 写「保额不足（缺口 N 万）」，不得写「缺少」', () => {
    const c = baseCustomer()
    // 本人（经济支柱）有重疾 20 万，低于 50 万参考值 → gap > 0 但并非"没有"
    c.policies = [
      { id: 'P1', insured_name: '李阳勇', insurance_category: '重疾险', sum_assured: 200000, annual_premium: 3000, effective_date: '2020-01-01', insurance_period: '终身', status: 'active' }
    ]
    const cs = buildChapters(c, {}).find(x => x.key === 'coverage_summary')
    // 措辞走 _shortCat（'重疾险' → '重疾'），与缺口章、矩阵列头同一套简称
    expect(cs.pre).toContain('重疾保额不足')
    expect(cs.pre).toContain('缺口 30 万')
    expect(cs.pre).not.toContain('缺少重疾')
    // 确实没有的险种仍然写"缺少"
    expect(cs.pre).toContain('缺少寿险')
  })

  test('客户版仍走中性措辞（只报"待完善"，不报金额）', () => {
    const c = baseCustomer()
    c.policies = [
      { id: 'P1', insured_name: '李阳勇', insurance_category: '重疾险', sum_assured: 200000, annual_premium: 3000, effective_date: '2020-01-01', insurance_period: '终身', status: 'active' }
    ]
    // buildChapters(family, report, gaps, opts)；opts.view === 'shared' 才是客户版
    const cs = buildChapters(c, {}, null, { view: 'shared' }).find(x => x.key === 'coverage_summary')
    expect(cs.pre).toContain('保障待完善')
    expect(cs.pre).not.toContain('缺口')
    expect(cs.pre).not.toContain('缺少')
  })
})

describe('缴费与现金流：年度保费柱（2026-10-18 用户提议「看到现金流释放」）', () => {
  // 自包含夹具：两张长期险，缴费期分别 10 年 / 20 年、保障 30 年 → 未来必有两次"缴费期满降档"
  function trendCustomer() {
    const thisYear = new Date().getFullYear()
    const startY = thisYear - 5
    return {
      name: '张三',
      members: [{ member_id: 'm1', name: '张三', role: '本人', age: 40 }],
      policies: [
        { id: 'p1', insured_name: '张三', insurance_category: '寿险', sum_assured: 500000, annual_premium: 8000, effective_date: startY + '-01-01', insurance_period: '30年', payment_period: '10年', status: 'active' },
        { id: 'p2', insured_name: '张三', insurance_category: '重疾险', sum_assured: 300000, annual_premium: 5000, effective_date: startY + '-01-01', insurance_period: '30年', payment_period: '20年', status: 'active' }
      ]
    }
  }

  test('缴费章含 premium_trend block：柱高按最大值归一，当前年与掉档年打标', () => {
    const c = trendCustomer()
    const ch = buildChapters(c, {})
    const cal = ch.find((x) => x.key === 'premium_calendar')
    const pt = cal.customBlocks.find((b) => b.t === 'premium_trend')
    expect(pt).toBeTruthy()
    expect(pt.years.length).toBeGreaterThan(1)
    // 最高的一柱必须是 100%，其余按比例 —— 归一化错了柱子高度就失真
    const maxPct = Math.max.apply(null, pt.years.map((x) => x.pct))
    expect(maxPct).toBe(100)
    expect(pt.years.filter((x) => x.isNow).length).toBe(1)
    // 掉档年至少一个（有缴费期满的保单），且必须打标
    expect(pt.years.some((x) => x.isDrop)).toBe(true)
    // 标签不是每年都画（否则 40 年时会糊成一片）
    expect(pt.years.filter((x) => x.showLabel).length).toBeLessThan(pt.years.length)
  })

  test('月历仍在同一章（跨年趋势 + 年内分布是两个维度，都要保留）', () => {
    const c = trendCustomer()
    const cal = buildChapters(c, {}).find((x) => x.key === 'premium_calendar')
    expect(cal.customBlocks.some((b) => b.t === 'calendar')).toBe(true)
  })
})

describe('第二步 IA：成员规模并入家庭结构章', () => {
  test('家庭结构节点带「N 张 · 保额 X万」（原页面「按成员整理」的信息）', () => {
    const c = baseCustomer()
    // 必须走 buildReportView：checkup 由它在内部自算后传给 chapter-builder
    // （直接调 buildChapters 不传 checkup 时，概览章与成员规模都不会出现）
    const view = buildReportView(c, {})
    const ft = view.chapters.find((x) => x.key === 'family_structure')
    const nodes = ft.customBlocks.find((b) => b.t === 'family_tree').nodes
    const ly = nodes.find((n) => n.name === '李阳勇')
    expect(ly.scaleText).toMatch(/\d+ 张 · 保额 /)
  })

  test('统一视图下客户版同样有家庭结构章（2026-10-18 决策：内容不分视角）', () => {
    const view = buildReportView(baseCustomer(), {}, { view: 'shared' })
    const ft = view.chapters.find((x) => x.key === 'family_structure')
    expect(ft).toBeDefined()
    expect(ft.customBlocks.find((b) => b.t === 'family_tree').nodes[0].scaleText).toMatch(/\d+ 张/)
    expect(view.chapters[0].key).toBe('overview')
  })
})

describe('保障期间甘特图：刻度数量上限（真机 6 个刻度压叠成两行）', () => {
  const { buildGantt } = require('../miniprogram/utils/report/gantt-builder')
  test('跨 50 年也只出 ≤4 个刻度', () => {
    const members = [{ name: '李阳勇', role: '本人' }]
    const policies = [
      { id: 'a', insured_name: '李阳勇', insurance_category: '寿险', sum_assured: 1000000, effective_date: '2019-09-28', insurance_period: '至2070年12月31日', status: 'active' }
    ]
    // 签名是 buildGantt(policies, members) —— 参数顺序反过来会得到空 rows（第一次写这条断言时就错了）
    const g = buildGantt(policies, members)
    expect(g.ticks.length).toBeLessThanOrEqual(4)
    expect(g.ticks.length).toBeGreaterThanOrEqual(2)
    // 首尾必须贴着轴两端，否则刻度失去定位意义
    expect(g.ticks[0].pct).toBe(0)
    expect(g.ticks[g.ticks.length - 1].pct).toBe(100)
  })
})
