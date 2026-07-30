/**
 * report-builder 单测 — 纯函数（buildGaps / assessDataCompleteness / buildChapters）
 * 不依赖 wx，可直接 node 运行
 */
const { buildGaps, assessDataCompleteness, buildChapters } = require('../miniprogram/utils/report-builder')

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

describe('buildChapters — 章节结构（结论先行：概览/紧急行动/规划/建议/关键发现/深度分析/附录）', () => {
  const report = {
    portrait: '家庭画像内容',
    review: '点评内容',
    gap_plan: '这是一个超过20字的保障规划建议文本用于测试章节渲染',
    suggestions: '这是一个超过20字的行动建议文本用于测试章节渲染',
    raw_analysis: '这是一个超过15个字的深度分析章节内容文本',
    disclaimer: '免责'
  }

  test('章节顺序：overview → plan → suggestions → analysis → appendix_timeline...（无 urgent/insights 时）', () => {
    const ch = buildChapters(baseCustomer(), report)
    const keys = ch.map(x => x.key)
    expect(keys[0]).toBe('overview')
    expect(keys).toContain('plan')
    expect(keys).toContain('suggestions')
    expect(keys).toContain('analysis')
    // 附录已拆为独立章节，末尾应为 appendix_disclaimer
    expect(keys[keys.length - 1]).toBe('appendix_disclaimer')
  })

  test('画像内容作为 analysis 章 pre 渲染（结论先行后折叠展示）', () => {
    const ch = buildChapters(baseCustomer(), report)
    const analysis = ch.find(x => x.key === 'analysis')
    expect(analysis).toBeDefined()
    expect(analysis.pre).toContain('家庭画像内容')
  })

  test('概览章含 familyPlan 与全景矩阵（数据驱动）', () => {
    const ch = buildChapters(baseCustomer(), report)
    const overview = ch.find(x => x.key === 'overview')
    const db = overview.customBlocks.find(b => b.t === 'dashboard')
    expect(db).toBeDefined()
    expect(db.matrix.heads[0]).toBe('成员')
    expect(db.matrix.rows.length).toBe(3) // 3 成员
    expect(db.familyPlan['李阳勇'].role).toBe('本人')
  })

  test('分析章含缺口全景矩阵（成员×险种），含经济支柱寿险缺口', () => {
    const ch = buildChapters(baseCustomer(), report)
    const analysis = ch.find(x => x.key === 'analysis')
    expect(analysis).toBeDefined()
    const pano = analysis.customBlocks.find(b => b.t === 'panorama')
    expect(pano).toBeDefined()
    expect(pano.heads[0]).toBe('成员')
    expect(pano.cats).toEqual(['重疾险', '医疗险', '意外险', '寿险'])
    expect(pano.rows.length).toBe(3) // 3 成员
    const ly = pano.rows.find(r => r.name === '李阳勇')
    const life = ly.cells.find(c => c.v === '100万') // 寿险已有保额 100万，缺口态 partial
    expect(life).toBeDefined()
    expect(life.s).toBe('partial')
  })

  test('规划章渲染 AI 规划文本', () => {
    const ch = buildChapters(baseCustomer(), report)
    const plan = ch.find(x => x.key === 'plan')
    expect(plan).toBeDefined()
    expect(plan.content).toContain('保障规划建议文本')
  })

  test('建议章渲染 AI 建议文本（占位符已替换）', () => {
    const ch = buildChapters(baseCustomer(), report)
    const s = ch.find(x => x.key === 'suggestions')
    expect(s).toBeDefined()
    expect(s.content).toContain('行动建议文本')
  })

  test('附录含保单列表与术语（独立章节卡片）', () => {
    const ch = buildChapters(baseCustomer(), report)
    const policies = ch.find(x => x.key === 'appendix_policies')
    const terms = ch.find(x => x.key === 'appendix_terms')
    expect(policies).toBeDefined()
    expect(policies.content).toContain('| 产品 | 险种 |')
    expect(terms).toBeDefined()
    expect(terms.content).toContain('等待期')
  })

  test('缺 AI 字段则对应章不渲染', () => {
    const ch = buildChapters(baseCustomer(), {})
    const keys = ch.map(x => x.key)
    expect(keys).not.toContain('plan')
    expect(keys).not.toContain('suggestions')
    expect(keys).not.toContain('analysis')
    expect(keys).toContain('appendix_policies') // 附录独立章节始终渲染
    expect(keys).toContain('appendix_terms')
  })
})
