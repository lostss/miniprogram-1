// 回归：进入报告页时，已存在报告不可触发 generateReport（曾因 !rp.analysis 死判定每次重算）
jest.mock('../miniprogram/utils/apiClient', () => jest.fn())

const api = require('../miniprogram/utils/apiClient')

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
      return { ok: true, code: 200, data: Object.assign({ _id: 'cid', family_name: 't', members: [], policies: [], report: overReport, insight_stale: false }, extra) }
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

  test('members 整组替换', () => {
    ctx.data = { family: baseFamily() }
    const f = ctx._applyLocalUpdate({ members: [{ member_id: 'm1', name: '张三', role: '本人', income: 40 }] })
    expect(f.members.length).toBe(1)
    expect(f.members[0].income).toBe(40)
  })

  test('financial_snapshot merge + 兼容字段同步', () => {
    ctx.data = { family: baseFamily() }
    const f = ctx._applyLocalUpdate({ financial_snapshot: { income: 50, fixed_expense: 15, debt: { amount: 80, type: '车贷' } } })
    expect(f.financial_snapshot.income).toBe(50)
    expect(f.financial_snapshot.fixed_expense).toBe(15)
    expect(f.financial_snapshot.debt).toEqual({ amount: 80, type: '车贷' })
    expect(f.family_income).toBe(50) // buildGaps 兼容字段
    expect(f.debt).toEqual({ amount: 80, type: '车贷' })
  })

  test('updatePolicy 仅 merge 目标保单', () => {
    ctx.data = { family: baseFamily() }
    const f = ctx._applyLocalUpdate({ updatePolicy: { policyId: 'p1', data: { sum_assured: 1000000 } } })
    expect(f.policies[0].sum_assured).toBe(1000000)
    expect(f.policies[0].product_name).toBe('康宁') // 未改动字段保留
  })

  test('updatePolicy 匹配不到 → 原数组不变', () => {
    ctx.data = { family: baseFamily() }
    const f = ctx._applyLocalUpdate({ updatePolicy: { policyId: 'nope', data: { sum_assured: 1 } } })
    expect(f.policies[0].sum_assured).toBe(500000)
  })

  test('无有效载荷 → 返回 null', () => {
    ctx.data = { family: baseFamily() }
    expect(ctx._applyLocalUpdate({})).toBe(null)
  })
})
