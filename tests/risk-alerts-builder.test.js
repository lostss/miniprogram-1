/**
 * 风险预警 TOP-N（risk-alerts-builder）单元测试
 *
 * 覆盖四类：
 *  ① 信号正确性：事实型硬伤（保单载明期限已过 / 受益人为法定）+ 缺口（含 blocked 待确认）+ 保费占比 + 达标项
 *  ② **排序确定性与可解释**：等级 → gapPriority → 敞口降序 → 成员档案顺序；同输入多次构建顺序一致
 *  ③ 客户版差异：保费占比结论 owner only（基于不可见数据的结论不得下发给客户）
 *  ④ 守卫：每条都带依据（basis），不引入无字段支撑的判定（重叠/空白期/严重不足分级）
 */
const { buildRiskAlerts } = require('../miniprogram/utils/report/risk-alerts-builder')
const { premiumRatioVerdict, PREMIUM_RATIO } = require('../miniprogram/utils/thresholds')

const MEMBERS = [
  { name: '李阳勇', role: '本人', income: 30 },
  { name: '谢敏', role: '配偶', income: 15 },
  { name: '李牧云', role: '子女' }
]

function gap(over) {
  return Object.assign({
    id: '李阳勇_寿险', member: '李阳勇', role: '本人', category: '寿险',
    existing: 0, reference: 300, gap: 300, reliability: 'confirmed', priority: 'high',
    basis: '寿险需求=总负债150万+5×年收入30万=300万，现有0万'
  }, over || {})
}

describe('risk-alerts-builder — 信号', () => {
  test('保单载明期限已过 → 红（依据为保单字段与同源判据）', () => {
    const r = buildRiskAlerts({
      gaps: [], members: MEMBERS,
      policies: [{ id: 'P1', status: 'active', product_name: '百万医疗', insured_name: '谢敏', insurance_category: '医疗险', sum_assured: 4000000, effective_date: '2024-05-01', insurance_period: '1年' }],
      premiumRatio: 0
    })
    const it = r.items.find(x => x.kind === 'policy_expired')
    expect(it).toBeTruthy()
    expect(it.level).toBe('red')
    expect(it.detail).toContain('谢敏')
    expect(it.basis).toContain('policy-status')
    expect(r.counts.red).toBe(1)
  })

  test('受益人为「法定」→ 红；非「法定」（含空/已指定）不产生条目', () => {
    const r = buildRiskAlerts({
      gaps: [], members: MEMBERS,
      policies: [
        { id: 'A', status: 'active', product_name: '终身寿A', beneficiary_name: '法定' },
        { id: 'B', status: 'active', product_name: '重疾B', beneficiary_name: '王小明' },
        { id: 'C', status: 'active', product_name: '医疗C', beneficiary_name: '' }
      ],
      premiumRatio: 0
    })
    const list = r.items.filter(x => x.kind === 'legal_beneficiary')
    expect(list).toHaveLength(1)
    expect(list[0].detail).toContain('终身寿A')
    expect(list[0].level).toBe('red')
  })

  test('经济支柱无寿险 → 标题点明身份（v2.0 ① 列出的高危项）', () => {
    const r = buildRiskAlerts({ gaps: [gap({ existing: 0 })], members: MEMBERS, policies: [], premiumRatio: 0 })
    const it = r.items.find(x => x.kind === 'gap')
    expect(it.title).toBe('经济支柱无寿险')
    expect(it.level).toBe('red')
    expect(it.detail).toContain('缺口 300 万')
  })

  test('非支柱的寿险缺口不冒充"支柱无寿险"', () => {
    const r = buildRiskAlerts({
      gaps: [gap({ member: '谢敏', role: '配偶', id: '谢敏_重疾险', category: '重疾险', existing: 0, reference: 50, gap: 50 })],
      members: MEMBERS, policies: [], premiumRatio: 0
    })
    const it = r.items.find(x => x.kind === 'gap')
    expect(it.title).toBe('重疾险低于参考保额')
  })

  test('blocked（缺收入无法测算）→ 黄，且与高危同级靠前（不确定本身要处理）', () => {
    const r = buildRiskAlerts({
      gaps: [gap({ id: '李阳勇_意外险', category: '意外险', reliability: 'blocked', gap: null, reference: null, basis: '意外险需求=5×年收入或总负债取高，年收入缺失无法计算' })],
      members: MEMBERS, policies: [], premiumRatio: 0
    })
    const it = r.items.find(x => x.kind === 'gap_blocked')
    expect(it.level).toBe('yellow')
    expect(it.priority).toBe('high')
    expect(it.detail).toContain('暂无法测算')
  })

  test('保费占比超区间 → 黄（owner）；达标成员 → 绿（不只制造焦虑）', () => {
    const r = buildRiskAlerts({
      gaps: [gap({})], members: MEMBERS, policies: [], premiumRatio: 12
    })
    const pr = r.items.find(x => x.kind === 'premium_ratio')
    expect(pr.level).toBe('yellow')
    expect(pr.detail).toContain('12%')
    const ok = r.items.find(x => x.kind === 'ok')
    expect(ok.level).toBe('green')
    expect(ok.detail).toContain('谢敏')
  })
})

describe('risk-alerts-builder — 排序（确定性、可解释）', () => {
  test('等级优先：红 → 黄 → 绿', () => {
    const r = buildRiskAlerts({
      gaps: [
        gap({ id: 'A', member: '谢敏', role: '配偶', category: '医疗险', gap: 100, priority: 'medium' }),
        gap({ id: 'B', member: '李阳勇', role: '本人', category: '寿险', gap: 300, priority: 'high' })
      ],
      members: MEMBERS,
      policies: [{ id: 'P', status: 'active', product_name: 'X', beneficiary_name: '法定' }],
      premiumRatio: 12
    })
    const levels = r.items.map(x => x.level)
    expect(levels).toEqual([...levels].sort((a, b) => ({ red: 0, yellow: 1, green: 2 })[a] - ({ red: 0, yellow: 1, green: 2 })[b]))
    expect(r.items[0].level).toBe('red')
  })

  test('同级按优先级、再按敞口金额降序，不按险种', () => {
    const r = buildRiskAlerts({
      gaps: [
        gap({ id: 'low_big', member: '李阳勇', category: '意外险', gap: 900, priority: 'low' }),
        gap({ id: 'high_small', member: '李阳勇', category: '重疾险', gap: 10, priority: 'high' }),
        gap({ id: 'high_big', member: '谢敏', role: '配偶', category: '寿险', gap: 500, priority: 'high' })
      ],
      members: MEMBERS, policies: [], premiumRatio: 0
    })
    const gaps = r.items.filter(x => x.kind === 'gap').map(x => x.key)
    expect(gaps).toEqual(['gap:high_big', 'gap:high_small', 'gap:low_big'])
  })

  test('同输入多次构建顺序完全一致（无隐藏随机/对象键序依赖）', () => {
    const input = {
      gaps: [gap({}), gap({ id: 'B', member: '谢敏', role: '配偶', category: '医疗险', gap: 100, priority: 'medium' })],
      members: MEMBERS,
      policies: [{ id: 'P', status: 'active', product_name: 'X', beneficiary_name: '法定' }],
      premiumRatio: 12
    }
    const a = buildRiskAlerts(input).items.map(x => x.key)
    const b = buildRiskAlerts(JSON.parse(JSON.stringify(input))).items.map(x => x.key)
    expect(a).toEqual(b)
  })

  test('TOP-N 截断：红黄超上限进 more，绿色（达标）始终保留', () => {
    const many = []
    for (let i = 0; i < 5; i++) many.push(gap({ id: 'g' + i, member: '李阳勇', category: '寿险', gap: 100 + i, priority: 'high' }))
    const r = buildRiskAlerts({ gaps: many, members: MEMBERS, policies: [], premiumRatio: 0, limit: 3 })
    expect(r.items.filter(x => x.level !== 'green')).toHaveLength(3)
    expect(r.more).toBe(2)
    // 被截断的部分必须能看出"有没有高危"（只写"另有 N 项"会把高危藏起来）
    expect(r.moreRed).toBe(2)
    expect(r.total).toBeGreaterThanOrEqual(6)
    // 绿色（达标）不参与 TOP-N 截断：谢敏/李牧云 无缺口 → 达标项必须在，不能被 5 条红黄挤掉
    expect(r.items.some(x => x.kind === 'ok')).toBe(true)
  })
})

describe('risk-alerts-builder — 客户版（shared）', () => {
  test('不显示保费占比结论（基于对客户不可见的家庭收入）', () => {
    const owner = buildRiskAlerts({ gaps: [], members: MEMBERS, policies: [], premiumRatio: 12, view: 'owner' })
    const shared = buildRiskAlerts({ gaps: [], members: MEMBERS, policies: [], premiumRatio: 12, view: 'shared' })
    expect(owner.items.some(x => x.kind === 'premium_ratio')).toBe(true)
    expect(shared.items.some(x => x.kind === 'premium_ratio')).toBe(false)
  })

  test('依据不得泄露被刻意隐藏的数据（公式/金额/字段名/模块名）', () => {
    const shared = buildRiskAlerts({
      gaps: [gap({})],
      members: MEMBERS,
      policies: [{ id: 'P', status: 'active', product_name: 'X', beneficiary_name: '法定' }],
      premiumRatio: 12, view: 'shared'
    })
    shared.items.forEach(it => {
      // owner 的 gap.basis 是"寿险需求=总负债150万+5×年收入30万=300万，现有0万"
      // → 客户版必须换中性文案，否则等于把隐藏的家庭财务数据从"依据"这条侧路漏回去
      expect(it.basis).not.toMatch(/负债|年收入|需求|×|\d+\s*万|thresholds|policy-status|evaluateCoverage|beneficiary_name/)
    })
    expect(shared.items.length).toBeGreaterThan(0)
  })

  test('缺口措辞中性：不写「缺少/低于」式表述', () => {
    const shared = buildRiskAlerts({ gaps: [gap({})], members: MEMBERS, policies: [], premiumRatio: 0, view: 'shared' })
    const gapItems = shared.items.filter(x => x.kind === 'gap')
    expect(gapItems.length).toBeGreaterThan(0)
    gapItems.forEach(x => {
      expect(x.title).toBe('保障待完善')
      expect(x.detail).not.toContain('缺少')
    })
  })
})

describe('risk-alerts-builder — 守卫', () => {
  test('每条都带非空依据（basis）—— 给不出依据的结论不出现', () => {
    const r = buildRiskAlerts({
      gaps: [gap({}), gap({ id: 'B', category: '意外险', reliability: 'blocked', gap: null, basis: '年收入缺失' })],
      members: MEMBERS,
      policies: [{ id: 'P', status: 'active', product_name: 'X', beneficiary_name: '法定' },
        { id: 'Q', status: 'active', product_name: 'Y', effective_date: '2024-05-01', insurance_period: '1年' }],
      premiumRatio: 12
    })
    expect(r.items.length).toBeGreaterThan(3)
    r.items.forEach(it => {
      expect(typeof it.basis).toBe('string')
      expect(it.basis.length).toBeGreaterThan(0)
    })
  })

  test('不产生无字段支撑的判定（重叠/空白期/严重不足分级）', () => {
    const r = buildRiskAlerts({ gaps: [gap({})], members: MEMBERS, policies: [], premiumRatio: 12 })
    const s = JSON.stringify(r)
    expect(s).not.toMatch(/重叠|空白期|断档|严重不足/)
  })

  test('阈值契约：7%/10% 区间 + 未填收入不判定', () => {
    expect(PREMIUM_RATIO).toEqual({ comfortable: 7, ceiling: 10 })
    expect(premiumRatioVerdict(0).code).toBe('unknown')
    expect(premiumRatioVerdict(5).code).toBe('ok')
    expect(premiumRatioVerdict(8).code).toBe('watch')
    expect(premiumRatioVerdict(12).code).toBe('heavy')
    // 措辞必须是"常见参考区间"，不得写成标准/应当（合规：行业经验值非监管标准）
    ;[5, 8, 12].forEach(r => {
      expect(premiumRatioVerdict(r).text).toContain('常见参考区间')
      expect(premiumRatioVerdict(r).text).not.toMatch(/应当|标准|超标/)
    })
  })

  test('空输入 → 结构完整不抛错', () => {
    const r = buildRiskAlerts({})
    expect(r.items).toEqual([])
    expect(r.more).toBe(0)
    expect(r.counts).toEqual({ red: 0, yellow: 0, green: 0 })
  })
})

describe('风险预警接线（防"建好了但没接进报告"）', () => {
  const fs = require('fs')
  const path = require('path')
  const SRC_PAGE = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'report', 'index.js'), 'utf8')
  const SRC_WXML = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'report', 'index.wxml'), 'utf8')
// 2026-10-18：风险条改由概览章 block 在 report-markdown 组件内渲染
const SRC_COMPONENT = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'components', 'report-markdown', 'index.wxml'), 'utf8')
  const SRC_WXSS = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'report', 'index.wxss'), 'utf8')

  test('风险条目接进报告：概览章 block 携带 risks（2026-10-18 起由组件渲染，不再在页面）', () => {
    // 页面仍 setData risks（其它消费方如预设问题用它），但渲染改由 chapters.overview 承担
    expect(SRC_PAGE).toContain('risks: view.risks')
    expect(SRC_COMPONENT).toContain('block.risks')
    expect(SRC_COMPONENT).toContain('block.risksMore')
    // 空列表时整块不渲染（不制造空标题）
    expect(SRC_COMPONENT).toContain('wx:if="{{block.risks.length}}"')
  })

  test('依据对红/黄项直接展开，达标项不铺开（组件内无交互态，故取消了 onRiskTap）', () => {
    expect(SRC_COMPONENT).toContain('ov-risk-basis')
    expect(SRC_COMPONENT).toContain("item.level !== 'ok'")
    // 旧交互已随页面级诊断卡一起移除（断言**方法定义与绑定**，不能断言字符串本身：
    // index.js 的注释里还写着"删除 onRiskTap"这句说明，直接 not.toContain 会被自己的注释命中）
    expect(SRC_PAGE).not.toContain('onRiskTap(e) {')
    expect(SRC_WXML).not.toContain('onRiskTap')
  })

  test('三个等级的样式类都有定义（红黄绿不得只定义其一）', () => {
    // 2026-10-22：风险条随概览章进入组件（页面级 .risk-* 已成为死样式被清理）
    const compWxss = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'components', 'report-markdown', 'index.wxss'), 'utf8')
    ;['.ov-risk--red', '.ov-risk--yellow', '.ov-risk--ok'].forEach(sel => {
      expect(compWxss).toContain(sel)
    })
  })
})
