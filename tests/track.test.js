/**
 * track — 产品埋点（2026-09-12 MVP 验证最小集）
 *
 * 契约：
 *   1. 统一走 writeOpLog 通道（operation_logs），logAction 带 `product_` 前缀便于聚合
 *   2. 只带枚举/ID 类 meta，不带 PII
 *   3. fire-and-forget + 静默：同步抛错与异步拒绝都不得影响调用方
 */
jest.mock('../miniprogram/utils/apiClient', () => jest.fn(() => Promise.resolve({ ok: true })))
const api = require('../miniprogram/utils/apiClient')
const { track } = require('../miniprogram/utils/track')

describe('track 埋点', function () {
  beforeEach(() => { jest.clearAllMocks() })

  test('统一走 writeOpLog，logAction 带 product_ 前缀，retries=0', function () {
    track('report_open', { view: 'shared', familyId: 'f1' })
    expect(api).toHaveBeenCalledWith('writeOpLog', {
      logAction: 'product_report_open',
      result: { status: 'ok' },
      meta: { view: 'shared', familyId: 'f1' }
    }, { retries: 0 })
  })

  test('meta 缺省为空对象（不传 undefined）', function () {
    track('report_share')
    expect(api.mock.calls[0][1].meta).toEqual({})
    expect(api.mock.calls[0][1].logAction).toBe('product_report_share')
  })

  test('同步抛错不影响调用方（静默）', function () {
    api.mockImplementationOnce(() => { throw new Error('boom') })
    expect(() => track('report_export')).not.toThrow()
  })

  test('异步拒绝不影响调用方（静默）', function () {
    api.mockImplementationOnce(() => Promise.reject(new Error('net')))
    expect(() => track('report_feedback', { useful: true })).not.toThrow()
  })

  test('只上报给定字段，不夹带额外 PII 字段', function () {
    track('deal_marked', { familyId: 'f1', status: 'won' })
    const meta = api.mock.calls[0][1].meta
    expect(Object.keys(meta).sort()).toEqual(['familyId', 'status'])
  })
})
