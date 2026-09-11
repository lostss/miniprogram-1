/**
 * readiness — 深度分析前置检查（2026-08）
 * 表驱动覆盖：空家庭 / 支柱缺年龄 BLOCK / 非支柱缺年龄 WARN / 收入弱锚 / 财务项 WARN /
 * 保单缺字段 WARN / 全绿 / 软删成员不计 / 无保单 BLOCK
 */
const { evaluateReadiness } = require('../cloudfunctions/_shared/readiness')

const PILLAR = { member_id: 'm1', name: '张三', role: '本人', age: 35, gender: '男', occupation: '工程师', health: '良好', income: 30 }
const SPOUSE = { member_id: 'm2', name: '李四', role: '配偶', age: 33, gender: '女' }
const KID = { member_id: 'm3', name: '王五', role: '子女' }
const POLICY = { _id: 'p1', product_name: '康宁', sum_assured: 50, member_id: 'm1' }

function base(over) {
  return Object.assign({ members: [PILLAR, SPOUSE], finances: [{ annual_income: 300000, total_debt: 1000000, fixed_annual_expense: 120000, annual_premium_budget: 20000 }], policies: [POLICY] }, over)
}

describe('readiness 深度分析前置检查', function () {
  test('空家庭（无成员/无财务/无保单）：成员与保单 BLOCK；收入降为 degraded 非 BLOCK', function () {
    const r = evaluateReadiness(base({ members: [], finances: [], policies: [] }))
    expect(r.ready).toBe(false)
    expect(r.hasBlockers).toBe(true)
    expect(r.tier).toBe('blocked')
    expect(r.blockers).toEqual(expect.arrayContaining(['请先添加家庭成员', '请先添加保单（无有效保障可分析）']))
    expect(r.blockers.some(b => b.indexOf('家庭年收入') !== -1)).toBe(false)
    expect(r.dimensions[0].status).toBe('block')
    expect(r.dimensions[1].status).toBe('warn')
    expect(r.dimensions[2].status).toBe('block')
    expect(r.missing.some(x => x.field === 'finance.annual_income')).toBe(true)
  })

  test('经济支柱缺年龄 → BLOCK；其余成员缺年龄 → WARN', function () {
    const pillarNoAge = Object.assign({}, PILLAR, { age: undefined })
    const r = evaluateReadiness(base({ members: [pillarNoAge, SPOUSE] }))
    expect(r.hasBlockers).toBe(true)
    expect(r.blockers.some(b => b.indexOf('经济支柱') !== -1)).toBe(true)
    const kidOnly = evaluateReadiness(base({ members: [PILLAR, KID] }))
    expect(kidOnly.hasBlockers).toBe(false)
    expect(kidOnly.warnings.some(w => w.indexOf('王五') !== -1)).toBe(true)
    expect(kidOnly.dimensions[0].status).toBe('warn')
  })

  test('出生日期可推导年龄（无 age 字段）→ 不算缺', function () {
    const viaBirth = Object.assign({}, PILLAR, { age: undefined, birth_date: '1991-01-01' })
    const r = evaluateReadiness(base({ members: [viaBirth] }))
    expect(r.hasBlockers).toBe(false)
  })

  test('家庭收入空但成员有收入 → WARN 非 BLOCK（弱锚点）', function () {
    const r = evaluateReadiness(base({ finances: [{}] }))
    expect(r.hasBlockers).toBe(false)
    expect(r.dimensions[1].status).toBe('warn')
    expect(r.warnings.some(w => w.indexOf('家庭年收入') !== -1)).toBe(true)
  })

  test('收入全空 → degraded 档（非 BLOCK，放行定性分析）', function () {
    const r = evaluateReadiness(base({ members: [Object.assign({}, PILLAR, { income: undefined })], finances: [{}] }))
    expect(r.hasBlockers).toBe(false)
    expect(r.tier).toBe('degraded')
    expect(r.tierReason).toContain('家庭年收入')
    expect(r.dimensions[1].status).toBe('warn')
    expect(r.blockers.some(b => b.indexOf('家庭年收入') !== -1)).toBe(false)
    expect(r.missing.some(x => x.field === 'finance.annual_income')).toBe(true)
  })

  test('财务缺负债/固定支出/保费预算 → 3 项 WARN', function () {
    const r = evaluateReadiness(base({ finances: [{ annual_income: 300000 }] }))
    expect(r.warnings).toEqual(expect.arrayContaining(['负债信息未填写', '固定支出未填写', '年度保费预算未填写']))
    expect(r.dimensions[1].status).toBe('warn')
  })

  test('保单缺保额/被保人 → WARN', function () {
    const r = evaluateReadiness(base({ policies: [{ _id: 'p9', product_name: '某某重疾' }] }))
    expect(r.warnings).toEqual(expect.arrayContaining(['保单「某某重疾」缺保额', '保单「某某重疾」缺被保人']))
    expect(r.dimensions[2].status).toBe('warn')
  })

  test('无有效保单 → 保障维度 BLOCK（fix 指向上传）', function () {
    const r = evaluateReadiness(base({ policies: [] }))
    expect(r.hasBlockers).toBe(true)
    expect(r.dimensions[2].status).toBe('block')
    expect(r.dimensions[2].items[0].fix.mode).toBe('upload')
  })

  test('软删成员不参与判定', function () {
    const deleted = Object.assign({}, KID, { status: 'deleted' })
    const r = evaluateReadiness(base({ members: [PILLAR, deleted] }))
    expect(r.hasBlockers).toBe(false)
    expect(r.warnings.some(w => w.indexOf('王五') !== -1)).toBe(false)
  })

  test('全绿 → ready，三维度全 ok', function () {
    const r = evaluateReadiness(base({}))
    expect(r.ready).toBe(true)
    expect(r.hasBlockers).toBe(false)
    expect(r.blockers).toEqual([])
    expect(r.dimensions.map(d => d.status)).toEqual(['ok', 'ok', 'ok'])
  })
})
