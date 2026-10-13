/**
 * callCloud.test.js — 云函数调用包装（超时 + 重试）
 *
 * 背景（2026-09-22 全面审计发现的回归）：本文件此前**没有任何测试**。
 * 一次"给超时错误补机器可读标志"的改动把 `timerId = setTimeout(...)` 整行删掉，
 * 改成在 promise executor 里**同步 reject** —— 定时器不复存在，于是：
 *   ① Promise.race 立即以"云函数超时"拒绝 → **每一次云函数调用都必然失败**；
 *   ② `opts.timeout` 彻底失效（残留未使用变量）；
 *   ③ 错误带 `__timeout:true` → 读操作还会**多发一次**请求（双发）。
 * 修正保留"机器可读标志"这一意图，只是把定时器放回来。
 * 本套件钉死"超时真的由计时器产生"这一事实，防止再次被删。
 */
const callCloud = require('../miniprogram/utils/callCloud')

function mockWx(impl) {
  global.wx = { cloud: { callFunction: jest.fn(impl) } }
}

describe('callCloud 超时与重试', () => {
  afterEach(() => {
    jest.useRealTimers()
    delete global.wx
  })

  test('调用成功后立即返回，且只发一次请求', async () => {
    mockWx(() => Promise.resolve({ result: { code: 200, data: { ok: 1 } } }))
    const res = await callCloud('dataQuery', { action: 'x' })
    expect(res).toEqual({ result: { code: 200, data: { ok: 1 } } })
    expect(global.wx.cloud.callFunction).toHaveBeenCalledTimes(1)
  })

  test('默认超时 30000ms：未到点不得判超时，到点才以 __timeout 标志拒绝', async () => {
    jest.useFakeTimers()
    mockWx(() => new Promise(() => {})) // 永不返回
    const onErr = jest.fn()
    callCloud('dataQuery', {}, { retries: 0 }).catch(onErr)

    await jest.advanceTimersByTimeAsync(29999)
    expect(onErr).not.toHaveBeenCalled() // ← 回归点：旧代码在此已"超时"

    await jest.advanceTimersByTimeAsync(1)
    expect(onErr).toHaveBeenCalledTimes(1)
    expect(onErr.mock.calls[0][0].__timeout).toBe(true)
    expect(String(onErr.mock.calls[0][0].message)).toContain('云函数超时')
  })

  test('opts.timeout 生效（自定义 5000ms）', async () => {
    jest.useFakeTimers()
    mockWx(() => new Promise(() => {}))
    const onErr = jest.fn()
    callCloud('dataQuery', {}, { retries: 0, timeout: 5000 }).catch(onErr)

    await jest.advanceTimersByTimeAsync(4999)
    expect(onErr).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(onErr).toHaveBeenCalledTimes(1)
  })

  test('超时（读操作默认 retries=1）重发一次后仍失败 → 共 2 次调用', async () => {
    jest.useFakeTimers()
    mockWx(() => new Promise(() => {}))
    const onErr = jest.fn()
    callCloud('dataQuery', {}, { timeout: 100 }).catch(onErr)

    await jest.advanceTimersByTimeAsync(100)
    await jest.advanceTimersByTimeAsync(100)
    expect(global.wx.cloud.callFunction).toHaveBeenCalledTimes(2)
    expect(onErr).toHaveBeenCalledTimes(1)
  })

  test('写操作 retries=0：网络 fail 不重发', async () => {
    mockWx(() => Promise.reject({ errMsg: 'cloud.callFunction:fail network' }))
    await expect(callCloud('dataWrite', {}, { retries: 0 })).rejects.toMatchObject({ errMsg: expect.stringContaining('fail') })
    expect(global.wx.cloud.callFunction).toHaveBeenCalledTimes(1)
  })

  test('读操作网络 fail 重发一次（retries=1）', async () => {
    mockWx(() => Promise.reject({ errMsg: 'cloud.callFunction:fail network' }))
    await expect(callCloud('dataQuery', {})).rejects.toBeTruthy()
    expect(global.wx.cloud.callFunction).toHaveBeenCalledTimes(2)
  })

  test('成功时清掉计时器，不留悬空定时器', async () => {
    jest.useFakeTimers()
    mockWx(() => Promise.resolve({ result: { code: 200 } }))
    await expect(callCloud('dataQuery', {}, { timeout: 1000 })).resolves.toBeTruthy()
    expect(jest.getTimerCount()).toBe(0)
  })
})
