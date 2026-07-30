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
      return { result: { code: 200, data: Object.assign({ _id: 'cid', family_name: 't', members: [], policies: [], report: overReport, insight_stale: false }, extra) } }
    }
    if (action === 'generateReport') {
      return { result: { code: 200, data: REPORT } }
    }
    return { result: { code: 200, data: {} } }
  })
}

test('已有报告：进入不调用 generateReport', async () => {
  mockGetCustomer()
  await ctx._loadReport('cid')
  expect(api).toHaveBeenCalledWith('getFamily', expect.objectContaining({ familyId: 'cid' }))
  expect(api).not.toHaveBeenCalledWith('generateReport', expect.anything())
})

test('已有报告 + insight_stale：仍不重算，仅置 reportUpdated 提示', async () => {
  mockGetCustomer(REPORT, { insight_stale: true })
  api.mockClear()
  await ctx._loadReport('cid')
  expect(api).not.toHaveBeenCalledWith('generateReport', expect.anything())
  const flagged = ctx.setData.mock.calls.some(c => c[0] && c[0].reportUpdated === true)
  expect(flagged).toBe(true)
})

test('无报告（首次）：进入同步生成 generateReport', async () => {
  mockGetCustomer({}) // 空报告，无 portrait
  await ctx._loadReport('cid')
  expect(api).toHaveBeenCalledWith('generateReport', expect.objectContaining({ familyId: 'cid' }))
})
