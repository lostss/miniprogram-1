/**
 * report-analysis — 报告页"深度分析"关切控制器（重构审计：从 report/index.js 一次一个关切抽出）
 * 验证：弹层状态机 / 成功·节流·失败·异常路径 / 取消后结果忽略 / busy 守卫 / destroy 后静默
 */
jest.mock('../miniprogram/utils/apiClient', () => jest.fn())
const api = require('../miniprogram/utils/apiClient')
const { createReportAnalysis } = require('../miniprogram/utils/report-analysis')

global.wx = { showToast: jest.fn(), showModal: jest.fn(), reLaunch: jest.fn() }

function flush() { return new Promise(r => setImmediate(r)) }

function setup(overrides) {
  const setData = jest.fn()
  const onDone = jest.fn()
  const ctl = createReportAnalysis(Object.assign({ getFamilyId: () => 'f1', setData, onDone }, overrides))
  return { ctl, setData, onDone }
}

beforeEach(() => { jest.clearAllMocks() })

describe('report-analysis controller', function () {
  test('start：置弹层态并以 60s 超时请求 generateReport', function () {
    api.mockImplementation(() => Promise.resolve({ ok: true }))
    const { ctl, setData } = setup()
    ctl.start()
    expect(setData).toHaveBeenCalledWith({ analysisShow: true, analysisSec: 0 })
    expect(api).toHaveBeenCalledWith('generateReport', { familyId: 'f1' }, { timeout: 60000, retries: 0 })
    return flush().then(() => { ctl.destroy() })
  })

  test('成功：关弹层 + 提示 + onDone(familyId)', function () {
    api.mockImplementation(() => Promise.resolve({ ok: true }))
    const { ctl, setData, onDone } = setup()
    ctl.start()
    return flush().then(() => {
      expect(setData).toHaveBeenCalledWith({ analysisShow: false })
      expect(global.wx.showToast).toHaveBeenCalledWith({ title: '分析完成', icon: 'success' })
      expect(onDone).toHaveBeenCalledWith('f1')
      ctl.destroy()
    })
  })

  test('成功但 readiness_warnings 非空：降质披露（缺口仅供参考），onDone 仍触发', function () {
    api.mockImplementation(() => Promise.resolve({ ok: true, data: { readiness_warnings: ['负债信息未填写'] } }))
    const { ctl, onDone } = setup()
    ctl.start()
    return flush().then(function () {
      expect(global.wx.showToast).toHaveBeenCalledWith({ title: '分析完成，部分数据未填写，缺口仅供参考', icon: 'none' })
      expect(onDone).toHaveBeenCalledWith('f1')
      ctl.destroy()
    })
  })

  test('节流：提示"已是最新分析"，同时刷新数据（onDone）', function () {
    api.mockImplementation(() => Promise.resolve({ ok: false, throttled: true }))
    const { ctl, onDone } = setup()
    ctl.start()
    return flush().then(() => {
      expect(global.wx.showToast).toHaveBeenCalledWith({ title: '已是最新分析', icon: 'none' })
      // 2026-09-09：节流命中 = 服务端已有/正在生成最新分析（常见于 auto 占锁），
      // 只 toast 不刷新会让用户看不到刚生成的报告
      expect(onDone).toHaveBeenCalledWith('f1')
      ctl.destroy()
    })
  })

  test('业务失败（ok:false）：提示失败，不触发 onDone', function () {
    api.mockImplementation(() => Promise.resolve({ ok: false, msg: 'x' }))
    const { ctl, onDone } = setup()
    ctl.start()
    return flush().then(() => {
      expect(global.wx.showToast).toHaveBeenCalledWith({ title: 'x', icon: 'none' })
      expect(onDone).not.toHaveBeenCalled()
      ctl.destroy()
    })
  })

  test('异常路径（reject）：关弹层 + 提示失败', function () {
    api.mockImplementation(() => Promise.reject(new Error('boom')))
    const { ctl, setData } = setup()
    ctl.start()
    return flush().then(() => {
      expect(setData).toHaveBeenCalledWith({ analysisShow: false })
      expect(global.wx.showToast).toHaveBeenCalledWith({ title: '分析失败，请重试', icon: 'none' })
      ctl.destroy()
    })
  })

  test('cancel：立即关弹层，迟到结果被忽略（无成功提示/无 onDone）', function () {
    let resolveApi
    api.mockImplementation(() => new Promise(r => { resolveApi = r }))
    const { ctl, setData, onDone } = setup()
    ctl.start()
    ctl.cancel()
    expect(setData).toHaveBeenCalledWith({ analysisShow: false })
    expect(global.wx.showToast).toHaveBeenCalledWith({ title: '已取消分析', icon: 'none' })
    // 结果迟到（用户已取消）
    resolveApi({ ok: true })
    return flush().then(() => {
      expect(global.wx.showToast).not.toHaveBeenCalledWith({ title: '分析完成', icon: 'success' })
      expect(onDone).not.toHaveBeenCalled()
      ctl.destroy()
    })
  })

  test('422（readiness 门禁）：关弹层 + onBlocked(readiness)，无失败 toast', function () {
    const readiness = { ready: false, blockers: ['x'], hasBlockers: true, dimensions: [] }
    api.mockImplementation(() => Promise.resolve({ ok: false, code: 422, data: readiness }))
    const onBlocked = jest.fn()
    const { ctl, setData } = setup({ onBlocked: onBlocked })
    ctl.start()
    return flush().then(function () {
      expect(setData).toHaveBeenCalledWith({ analysisShow: false })
      expect(onBlocked).toHaveBeenCalledWith(readiness)
      expect(global.wx.showToast).not.toHaveBeenCalled()
      ctl.destroy()
    })
  })

  test('busy 守卫：重复 start 只发起一次请求', function () {
    api.mockImplementation(() => Promise.resolve({ ok: true }))
    const { ctl } = setup()
    ctl.start()
    ctl.start()
    expect(api).toHaveBeenCalledTimes(1)
    return flush().then(() => { ctl.destroy() })
  })

  test('destroy 后完成：不再 setData / toast（防卸载后 setData 告警）', function () {
    let resolveApi
    api.mockImplementation(() => new Promise(r => { resolveApi = r }))
    const { ctl, setData } = setup()
    ctl.start()
    ctl.destroy()
    resolveApi({ ok: true })
    return flush().then(() => {
      const setCalls = setData.mock.calls.map(c => c[0]).filter(o => o && o.analysisShow !== undefined)
      expect(setCalls).toEqual([{ analysisShow: true, analysisSec: 0 }]) // 仅起始弹层，无关闭
      expect(global.wx.showToast).not.toHaveBeenCalled()
    })
  })
})
