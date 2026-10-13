/**
 * reportAI 解析失败重试的时间预算（2026-09-20 复核批次 B）
 *
 * 原实现无条件重试：首轮 40s 超时（拿到空文本 → 解析失败）后再发一次 40s，
 * 合计 80s > 函数 60s 上限 → 平台把函数杀在半路。双输：用户拿不到报告，
 * 还白烧一次 token，日志只剩"函数超时"看不出是重试撑爆的。
 *
 * 判定为纯函数，故这里直接驱动边界（无需 mock 整个云函数）。
 */
jest.mock('wx-server-sdk', () => ({
  init: jest.fn(),
  DYNAMIC_CURRENT_ENV: 'env-mock',
  database: jest.fn(() => ({ collection: jest.fn(() => ({})), command: {} })),
  getWXContext: jest.fn(() => ({ OPENID: 'o1' }))
}))

const { _canRetryParseFailure } = require('../cloudfunctions/reportAI/index')

describe('_canRetryParseFailure — 重试预算', () => {
  test('首轮很快失败（3s）→ 可重试', () => {
    expect(_canRetryParseFailure(3000)).toBe(true)
  })

  test('边界：已耗时 15s 恰好可行（15s + 40s + 5s 尾部 = 60s）', () => {
    expect(_canRetryParseFailure(15000)).toBe(true)
    expect(_canRetryParseFailure(15001)).toBe(false)
  })

  test('首轮 40s 超时 → **不重试**（再发一次必然被函数时限杀掉）', () => {
    expect(_canRetryParseFailure(40000)).toBe(false)
  })

  test('已超过函数时限 → 不重试', () => {
    expect(_canRetryParseFailure(61000)).toBe(false)
  })
})
