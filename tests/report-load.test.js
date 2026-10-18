// 回归：进入报告页时，已存在报告不可触发 generateReport（曾因 !rp.analysis 死判定每次重算）
jest.mock('../miniprogram/utils/apiClient', () => jest.fn())

const api = require('../miniprogram/utils/apiClient')
const { familyResponse } = require('./helpers/family-response')

let page, ctx
beforeAll(() => {
  global.Page = (cfg) => { page = cfg }
  require('../miniprogram/pages/report/index.js')
  ctx = Object.assign({}, page, {
    setData: jest.fn(),
    _startLoading: jest.fn(),
    _stopLoading: jest.fn()
  })
})

const REPORT = { portrait: '已有报告', review: 'r', plan: 'p', suggestions: 's', disclaimer: 'd' }

function mockGetCustomer(overReport = REPORT, extra = {}) {
  api.mockImplementation(async (action) => {
    if (action === 'getFamily') {
      // 响应形状统一由 tests/helpers/family-response.js 构造（内部复用生产 applyFamilyCompat），
      // **不再手写 fixture** —— 2026-09-18 流程审计 P1-3 的机制修复：手写 fixture 曾缺
      // family_income 兼容字段，于是"前端按合成后的形状重推、后端按原始形状判定"的不一致
      // 在测试全绿的情况下上线（定性模式披露恒不出现）。
      return { ok: true, code: 200, data: familyResponse(Object.assign({ report: overReport, insight_stale: false }, extra)) }
    }
    if (action === 'generateReport') {
      return { ok: true, code: 200, data: REPORT }
    }
    return { ok: true, code: 200, data: {} }
  })
}

test('已有报告：进入不调用 generateReport', async () => {
  mockGetCustomer()
  await ctx._loadReport('cid')
  expect(api).toHaveBeenCalledWith('getFamily', expect.objectContaining({ familyId: 'cid' }))
  expect(api).not.toHaveBeenCalledWith('generateReport', expect.anything())
})

test('已有报告 + insight_stale：不重算，也不再置 reportUpdated（update-toast 死路径已删）', async () => {
  mockGetCustomer(REPORT, { insight_stale: true })
  api.mockClear()
  await ctx._loadReport('cid')
  expect(api).not.toHaveBeenCalledWith('generateReport', expect.anything())
  const flagged = ctx.setData.mock.calls.some(c => c[0] && c[0].reportUpdated === true)
  expect(flagged).toBe(false)
})

// 新设计（2026-08）：基础版报告纯数据驱动，AI 深度分析改为手工触发（待设计），
// 首次进入不再自动调用 generateReport
test('无报告（首次）：不自动触发 generateReport（纯数据渲染）', async () => {
  mockGetCustomer({}) // 空报告，无 portrait
  await ctx._loadReport('cid')
  expect(api).not.toHaveBeenCalledWith('generateReport', expect.anything())
  expect(api).toHaveBeenCalledWith('getFamily', expect.objectContaining({ familyId: 'cid' }))
})

describe('_applyLocalUpdate — 编辑保存本地增量更新（不查库）', () => {
  function baseFamily() {
    return {
      _id: 'cid', members: [{ member_id: 'm1', name: '张三', role: '本人' }],
      financial_snapshot: { income: 30, debt: { amount: 100, type: '房贷' } },
      policies: [{ id: 'p1', product_name: '康宁', sum_assured: 500000 }]
    }
  }

  // 2026-09-18 性能：整份 family 文档改存实例字段 this._family（data 侧只剩 { name } 视图切片）。
  // 本组用例按新契约播种——原写法 `ctx.data = { family: baseFamily() }` 把整份文档放在 data 上，
  // 正是被移除的那条路径（其中 updatePolicy 两例因此失败：它们断言"未改动字段保留"，
  // 必须读到原 policies 数组，而 data 侧已不再承载整份文档）。
  function seed(fam) {
    ctx._family = fam
    ctx.data = { family: { name: fam.name || '' } }
    return fam
  }

  test('members 整组替换', () => {
    seed(baseFamily())
    const f = ctx._applyLocalUpdate({ members: [{ member_id: 'm1', name: '张三', role: '本人', income: 40 }] })
    expect(f.members.length).toBe(1)
    expect(f.members[0].income).toBe(40)
  })

  test('financial_snapshot merge + 兼容字段同步', () => {
    seed(baseFamily())
    const f = ctx._applyLocalUpdate({ financial_snapshot: { income: 50, debt: { amount: 80, type: '车贷' } } })
    expect(f.financial_snapshot.income).toBe(50)
    expect(f.financial_snapshot.debt).toEqual({ amount: 80, type: '车贷' })
    expect(f.family_income).toBe(50) // buildGaps 兼容字段
    expect(f.debt).toEqual({ amount: 80, type: '车贷' })
  })

  test('updatePolicy 仅 merge 目标保单', () => {
    seed(baseFamily())
    const f = ctx._applyLocalUpdate({ updatePolicy: { policyId: 'p1', data: { sum_assured: 1000000 } } })
    expect(f.policies[0].sum_assured).toBe(1000000)
    expect(f.policies[0].product_name).toBe('康宁') // 未改动字段保留
  })

  test('updatePolicy 匹配不到 → 原数组不变', () => {
    seed(baseFamily())
    const f = ctx._applyLocalUpdate({ updatePolicy: { policyId: 'nope', data: { sum_assured: 1 } } })
    expect(f.policies[0].sum_assured).toBe(500000)
  })

  test('无有效载荷 → 返回 null', () => {
    seed(baseFamily())
    expect(ctx._applyLocalUpdate({})).toBe(null)
  })
})

// ===========================================================================
// 2026-09-18 报告页：性能（整份文档不过 setData 桥）+ 体验（定性模式常驻披露）
// ===========================================================================
describe('报告页数据契约（性能 / 体验）', () => {
  // 取"携带 family 字段"的那次 setData（_applyReportData 主调用）；
  // 之后 _loadFacts 等还会有若干次 setData，不能直接取最后一次整体调用。
  function lastFamilySetData() {
    const hits = ctx.setData.mock.calls.map(c => c[0]).filter(o => o && o.family)
    expect(hits.length).toBeGreaterThan(0)
    return hits[hits.length - 1]
  }

  test('data.family 只是视图切片：整份文档不再经 setData 过桥（防回归）', async () => {
    // 原实现 `setData({ family: c })` 把 c 整体（含 policies/现价表/report 全文）序列化到视图层，
    // 几十 KB，且与 chapters/deep 重复传输 → 本用例锁死"切片"契约，防止有人改回整份文档。
    mockGetCustomer()
    ctx.setData.mockClear()
    await ctx._loadReport('cid')

    const payload = lastFamilySetData()
    expect(payload.family).toEqual({ name: 't' }) // 只带页头标题所需的 name
    expect(payload.family.policies).toBeUndefined() // 大数组一律不得出现
    expect(payload.family.report).toBeUndefined()
    // 完整文档仍在实例字段上（JS 侧读取，不过桥）
    expect(ctx._family.report).toEqual(REPORT)
    expect(ctx._family.policies).toEqual([])
  })

  // 2026-09-19 修（流程审计 P1-3）：判定改为**只读后端在生成时刻落库的 readiness_tier**。
  // 原实现由前端自行重推 tier，而两侧输入形状不同（后端读 finances 原始集合；前端读 getFamily
  // 合成后的文档，缺失被 `|| 0` 抹平）→ 前端恒 ok、卡片永不出现。
  const M = [{ member_id: 'm1', name: '张三', role: '本人', birth_date: '1980-01-01', status: 'active' }]
  const P = [{ id: 'p1', product_name: '康宁', insurance_category: '重疾险', sum_assured: 500000, status: 'active' }]

  test('tier=degraded → 披露为真（真实形状下 family_income 是 0，即"缺失"的合成值）', async () => {
    mockGetCustomer(REPORT, { members: M, policies: P, readiness_tier: 'degraded' })
    ctx.setData.mockClear()
    await ctx._loadReport('cid')
    // 形状前提：合成层把"缺失收入"补成 0 而非 undefined —— 这正是原前端重推必然失败的原因
    expect(ctx._family.family_income).toBe(0)
    expect(lastFamilySetData().qualitativeMode).toBe(true)
  })

  test('tier=ok → 不披露（报告本身可量化，不做误报）', async () => {
    mockGetCustomer(REPORT, { members: M, policies: P, readiness_tier: 'ok' })
    ctx.setData.mockClear()
    await ctx._loadReport('cid')
    expect(lastFamilySetData().qualitativeMode).toBe(false)
  })

  test('**落库 tier 优先于当前数据**：收入已填但上次生成是 degraded → 仍披露（锁死"不重推"）', async () => {
    // 主护栏：若有人改回"前端按当前数据重推"，本用例会失败（重推见 income 已填 → 判 ok）。
    // 语义依据：报告内容与 tier 恒为同一次生成 —— 内容本来是定性的，就该如实披露。
    mockGetCustomer(REPORT, { members: M, policies: P, financial_snapshot: { income: 30 }, readiness_tier: 'degraded' })
    ctx.setData.mockClear()
    await ctx._loadReport('cid')
    expect(lastFamilySetData().qualitativeMode).toBe(true)
  })

  test('无 readiness_tier（本次改动前的存量报告）→ 不披露（宁可不说，也不误报）', async () => {
    mockGetCustomer(REPORT, { members: M, policies: P })
    ctx.setData.mockClear()
    await ctx._loadReport('cid')
    expect(lastFamilySetData().qualitativeMode).toBe(false)
  })

  test('无 deep（尚未生成分析）→ 不披露（deep-entry 已在引导"立即生成分析"）', async () => {
    mockGetCustomer({}, { members: M, policies: P, readiness_tier: 'degraded' })
    ctx.setData.mockClear()
    await ctx._loadReport('cid')
    expect(lastFamilySetData().qualitativeMode).toBe(false)
  })

  test('readiness_tier 字段名跨树一致（写方 reportAI / 读方报告页）——防拼写漂移致披露静默失效', () => {
    // P1-3 的失效方式就是"静默死掉"（功能在、条件恒假、无报错）。字段名是这条链上唯一的
    // 隐式契约（无共享常量），拼错任一处都不会有任何报错 → 用字面量断言钉住两侧。
    const fsx = require('fs')
    const pathx = require('path')
    const writer = fsx.readFileSync(pathx.join(__dirname, '../cloudfunctions/reportAI/index.js'), 'utf8')
    const reader = fsx.readFileSync(pathx.join(__dirname, '../miniprogram/pages/report/index.js'), 'utf8')
    expect(writer).toContain('readiness_tier: readiness.tier')
    expect(reader).toContain("c.readiness_tier === 'degraded'")
  })

  // -------------------------------------------------------------------------
  // 2026-09-20 流程审计 P2-3：客户版「客户档案」恒空 + 埋点丢 familyId
  // -------------------------------------------------------------------------
  test('客户版：客户档案从共享响应构建，且不调用 owner 专用 queryFacts', async () => {
    const facts = [
      { _id: 'f1', subject_id: 'm1', subject_type: 'member', subject_name: '李**', predicate: '职业', axis: '职业', kind: 'fact', object_value: '教师', confidence: 1 },
      { _id: 'f2', subject_id: 'm1', subject_type: 'member', subject_name: '李**', predicate: '健康异常', axis: '健康异常', kind: 'fact', object_value: '高血压', confidence: 1 },
      // 线索：客户版必须过滤（猜测给客户看会引起不安/误导）
      { _id: 'f3', subject_id: 'm1', subject_type: 'member', subject_name: '李**', predicate: '听说要换工作', kind: 'lead', confidence: 0.5 }
    ]
    api.mockImplementation(async (action) => {
      if (action === 'getSharedFamily') return { ok: true, code: 200, data: familyResponse({ _id: 'cid', facts: facts, report: REPORT }) }
      // 客户不是 owner：这条路径一旦被调用，真实环境必然取不到数据（按客户 openid 过滤）
      if (action === 'queryFacts') throw new Error('客户版不应调用 queryFacts')
      return { ok: true, code: 200, data: {} }
    })
    // 真实入口是 onLoad 先置 isShared 再 _loadSharedReport（此处直接调后者，须自行补上该前置）
    ctx.data.isShared = true
    ctx.data.familyId = ''
    ctx.setData.mockClear()
    await ctx._loadSharedReport('tok_1')
    ctx.data.isShared = false // 还原，避免污染同文件其他用例

    const factsView = ctx.setData.mock.calls.map(c => c[0]).filter(o => o && o.factsView).pop()
    expect(factsView).toBeTruthy()
    expect(factsView.factsView.members.length).toBe(1)
    // 2026-10-18 用户决策：报告内容不分代理/客户 → 客户档案也统一（线索与时间线一并展示）。
    // 仍保留的差异只有**取数路径**（客户不能调 owner 专用的 queryFacts）。
    expect(factsView.factsView.leads.length).toBe(1)
    expect(factsView.factsView.timeline.length).toBeGreaterThanOrEqual(0)
    expect(factsView.factsView.members[0].text).toContain('职业 教师')
  })

  test('客户版：埋点 familyId 从共享响应取（刻意不写 data.familyId，避免激活 owner 专用路径）', async () => {
    api.mockImplementation(async (action) => {
      if (action === 'getSharedFamily') return { ok: true, code: 200, data: familyResponse({ _id: 'cid', report: REPORT }) }
      return { ok: true, code: 200, data: {} }
    })
    await ctx._loadSharedReport('tok_2')
    expect(ctx._trackFamilyId()).toBe('cid')
    // 关键：data.familyId 仍为空 —— 下拉刷新/导出PDF/OCR 都读它，客户用自己 openid 调必然 401/404
    expect(ctx.data.familyId).toBeFalsy()
  })
})
