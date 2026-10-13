/**
 * readiness — 深度分析前置检查（2026-08）
 * 表驱动覆盖：空家庭 / 支柱缺年龄 BLOCK / 非支柱缺年龄 WARN / 收入弱锚 / 财务项 WARN /
 * 保单缺字段 WARN / 全绿 / 软删成员不计 / 无保单 BLOCK
 */
const { evaluateReadiness } = require('../cloudfunctions/_shared/readiness')

const PILLAR = { member_id: 'm1', name: '张三', role: '本人', age: 35, gender: '男', occupation: '工程师', health: '良好', income: 30 }
const SPOUSE = { member_id: 'm2', name: '李四', role: '配偶', age: 33, gender: '女', occupation: '教师', health: '良好' }
const KID = { member_id: 'm3', name: '王五', role: '子女' }
const POLICY = { _id: 'p1', product_name: '康宁', sum_assured: 50, member_id: 'm1' }

function base(over) {
  return Object.assign({ members: [PILLAR, SPOUSE], finances: [{ annual_income: 300000, total_debt: 1000000, annual_premium_budget: 20000 }], policies: [POLICY] }, over)
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

  test('财务缺负债 → 1 项 WARN；年度保费预算已停止提示（同「固定支出」：无消费方）', function () {
    const r = evaluateReadiness(base({ finances: [{ annual_income: 300000 }] }))
    expect(r.warnings).toEqual(expect.arrayContaining(['总负债未填写']))
    // 2026-09-19 字段治理（流程审计 P2-1）：年保费预算不参与任何计算/结论，
    // 却把用户引向"编辑 Sheet 里没有的字段" → 任务死路。与 2026-09-12 移除固定支出同一处置。
    expect(r.warnings.some(w => w.indexOf('保费预算') !== -1)).toBe(false)
    expect(r.missing.some(x => x.field === 'finance.annual_premium_budget')).toBe(false)
    expect(r.dimensions[1].items.some(i => String(i.field).indexOf('annual_premium_budget') !== -1)).toBe(false)
    expect(r.warnings.some(w => w.indexOf('固定支出') !== -1)).toBe(false)
    expect(r.missing.some(x => x.field === 'finance.fixed_annual_expense')).toBe(false)
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

  // ---------------------------------------------------------------------------
  // 2026-09-19 流程审计 P2-1：缺性别/职业/健康原先只进 warnings，不进 dimensions.items
  //   → 弹层写「N 个建议」但可操作行数少于 N，用户找不到该补什么
  // ---------------------------------------------------------------------------
  test('P2-1：缺性别/职业/健康 既进 warnings 也进 items（计数与清单同源）', function () {
    const bare = { member_id: 'm9', name: '赵六', role: '配偶', age: 40 }
    const r = evaluateReadiness(base({ members: [PILLAR, bare] }))
    const labels = r.dimensions[0].items.map(i => i.label)
    expect(labels).toEqual(expect.arrayContaining(['赵六缺性别', '赵六缺职业', '赵六缺健康信息']))
    // 同源判定：该成员相关 warnings 条数 === 其 items 条数（不再"只报数不出行"）
    const warnItems = r.dimensions[0].items.filter(i => i.severity === 'warn' && i.label.indexOf('赵六') !== -1).length
    expect(r.warnings.filter(w => w.indexOf('赵六') !== -1).length).toBe(warnItems)
    expect(r.dimensions[0].status).toBe('warn')
  })

  test('P2-1 护栏：成员维度的每个字段都能在成员编辑 Sheet 里填（防「去补全」死路复发）', function () {
    const { buildEditConfig } = require('../miniprogram/utils/edit-form')
    const bare = { member_id: 'm9', name: '赵六', role: '配偶', age: 40 }
    const noAge = { member_id: 'm8', name: '钱七', role: '配偶' }
    const members = [PILLAR, bare, noAge]
    const r = evaluateReadiness(base({ members: members }))
    const sheetKeys = buildEditConfig({ mode: 'member', family: { members: members }, member: bare }).editFields.map(f => f.key)
    // field 形如 'member.赵六.gender' → 末段即 Sheet 的字段键
    const unmappable = r.dimensions[0].items
      .filter(i => String(i.field).indexOf('member.') === 0)
      .map(i => String(i.field).split('.').pop())
      .filter(k => sheetKeys.indexOf(k) === -1)
    expect(unmappable).toEqual([])
  })
})
