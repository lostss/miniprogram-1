/**
 * cross-fn-call 单元测试 — 跨云函数调用统一 seam
 *
 * 被测对象：cloudfunctions/_shared/cross-fn-call.js
 * 设计契约：
 *   - callSibling(cloud, fnName, payload, openid, opts) 归一化结果
 *   - opts.retry: 失败重试次数（maxAttempts = retry + 1）
 *   - opts.throttleMs + throttleState: 节流窗口
 *   - opts.onSuccess: 成功后回调
 *   - 失败时返回 { code: 500, msg: label + ' 调用失败' }
 */
const { callSibling } = require('../cloudfunctions/_shared/cross-fn-call')

function makeCloud(impl) {
  return {
    callFunction: jest.fn(impl || (() => Promise.resolve({ result: { code: 200, data: { ok: true } } })))
  }
}

describe('callSibling', () => {
  describe('基本调用', () => {
    test('成功返回 result 并注入 _authOpenid', async () => {
      const cloud = makeCloud()
      const res = await callSibling(cloud, 'dataWrite', { action: 'listFamilies' }, 'openid_x')

      expect(cloud.callFunction).toHaveBeenCalledTimes(1)
      const callArgs = cloud.callFunction.mock.calls[0][0]
      expect(callArgs.name).toBe('dataWrite')
      expect(callArgs.data._authOpenid).toBe('openid_x')
      expect(callArgs.data.action).toBe('listFamilies')
      expect(res.code).toBe(200)
      expect(res.data.ok).toBe(true)
    })

    test('opts.label 不影响调用但用于错误日志', async () => {
      const cloud = makeCloud(() => Promise.reject(new Error('boom')))
      const res = await callSibling(cloud, 'dataWrite', {}, 'openid', { label: '查询保单', retry: 0 })
      expect(res.code).toBe(500)
      expect(res.msg).toBe('查询保单 调用失败')
    })

    test('opts.extraPayload 注入到 data', async () => {
      const cloud = makeCloud()
      await callSibling(cloud, 'fn', { foo: 1 }, 'oid', { extraPayload: { bar: 2 } })
      const data = cloud.callFunction.mock.calls[0][0].data
      expect(data.foo).toBe(1)
      expect(data.bar).toBe(2)
      expect(data._authOpenid).toBe('oid')
    })
  })

  describe('结果归一化', () => {
    test('res.result 为空时返回 500 占位结果', async () => {
      const cloud = makeCloud(() => Promise.resolve({ result: null }))
      const res = await callSibling(cloud, 'fnX', {}, 'oid')
      expect(res.code).toBe(500)
      expect(res.msg).toBe('fnX 返回空结果')
    })

    test('res 整体为空时返回 500 占位结果', async () => {
      const cloud = makeCloud(() => Promise.resolve(null))
      const res = await callSibling(cloud, 'fnX', {}, 'oid')
      expect(res.code).toBe(500)
      expect(res.msg).toBe('fnX 返回空结果')
    })

    test('透传 result 字段', async () => {
      const cloud = makeCloud(() => Promise.resolve({ result: { code: 207, partial: true, msg: '部分成功' } }))
      const res = await callSibling(cloud, 'fnX', {}, 'oid')
      expect(res.code).toBe(207)
      expect(res.partial).toBe(true)
    })
  })

  describe('重试逻辑（委托 withRetry）', () => {
    test('retry=2 时最多调用 3 次', async () => {
      let calls = 0
      const cloud = makeCloud(() => {
        calls++
        if (calls < 3) return Promise.reject(new Error('transient'))
        return Promise.resolve({ result: { code: 200, data: { attempt: calls } } })
      })
      const res = await callSibling(cloud, 'fn', {}, 'oid', { retry: 2, retryDelayMs: 10 })
      expect(calls).toBe(3)
      expect(res.code).toBe(200)
      expect(res.data.attempt).toBe(3)
    })

    test('retry=0 时不重试，直接归一化失败', async () => {
      let calls = 0
      const cloud = makeCloud(() => {
        calls++
        return Promise.reject(new Error('boom'))
      })
      const res = await callSibling(cloud, 'fn', {}, 'oid', { retry: 0, label: '测试' })
      expect(calls).toBe(1)
      expect(res.code).toBe(500)
      expect(res.msg).toBe('测试 调用失败')
    })

    test('retry=1 失败 2 次后归一化错误', async () => {
      let calls = 0
      const cloud = makeCloud(() => {
        calls++
        return Promise.reject(new Error('persistent'))
      })
      const res = await callSibling(cloud, 'fn', {}, 'oid', { retry: 1, retryDelayMs: 10, label: 'L' })
      expect(calls).toBe(2)
      expect(res.code).toBe(500)
      expect(res.msg).toBe('L 调用失败')
    })
  })

  describe('节流逻辑', () => {
    test('throttleMs + throttleState 命中节流返回 skipped', async () => {
      const cloud = makeCloud()
      const lastAt = Date.now() - 1000 // 1 秒前刚成功
      const res = await callSibling(
        cloud, 'fn',
        { familyId: 'f1' },
        'oid',
        { throttleMs: 5000, throttleState: () => lastAt }
      )
      expect(res.code).toBe(200)
      expect(res.data.skipped).toBe(true)
      expect(res.data.reason).toBe('throttled')
      expect(cloud.callFunction).not.toHaveBeenCalled()
    })

    test('throttleState 返回 null 不节流', async () => {
      const cloud = makeCloud()
      const res = await callSibling(
        cloud, 'fn',
        { familyId: 'f1' },
        'oid',
        { throttleMs: 5000, throttleState: () => null }
      )
      expect(res.code).toBe(200)
      expect(cloud.callFunction).toHaveBeenCalledTimes(1)
    })

    test('throttleMs=0 不启用节流', async () => {
      const cloud = makeCloud()
      const res = await callSibling(
        cloud, 'fn',
        { familyId: 'f1' },
        'oid',
        { throttleMs: 0, throttleState: () => Date.now() }
      )
      expect(res.code).toBe(200)
      expect(cloud.callFunction).toHaveBeenCalledTimes(1)
    })

    test('throttleState 不是函数时不启用节流', async () => {
      const cloud = makeCloud()
      const res = await callSibling(
        cloud, 'fn',
        { familyId: 'f1' },
        'oid',
        { throttleMs: 5000, throttleState: null }
      )
      expect(res.code).toBe(200)
      expect(cloud.callFunction).toHaveBeenCalledTimes(1)
    })

    test('超过节流窗口正常调用', async () => {
      const cloud = makeCloud()
      const lastAt = Date.now() - 10000 // 10 秒前
      const res = await callSibling(
        cloud, 'fn',
        { familyId: 'f1' },
        'oid',
        { throttleMs: 5000, throttleState: () => lastAt }
      )
      expect(res.code).toBe(200)
      expect(res.data.skipped).toBeUndefined()
      expect(cloud.callFunction).toHaveBeenCalledTimes(1)
    })
  })

  describe('onSuccess 回调', () => {
    test('成功后调用 onSuccess，ctx 包含 familyId/openid/now', async () => {
      const cloud = makeCloud()
      const onSuccess = jest.fn()
      await callSibling(cloud, 'fn', { familyId: 'f1' }, 'oid', { onSuccess })
      expect(onSuccess).toHaveBeenCalledTimes(1)
      const [result, ctx] = onSuccess.mock.calls[0]
      expect(result.code).toBe(200)
      expect(ctx.familyId).toBe('f1')
      expect(ctx.openid).toBe('oid')
      expect(typeof ctx.now).toBe('number')
    })

    test('onSuccess 抛错不影响主流程', async () => {
      const cloud = makeCloud()
      const onSuccess = jest.fn(() => { throw new Error('callback boom') })
      const res = await callSibling(cloud, 'fn', { familyId: 'f1' }, 'oid', { onSuccess })
      expect(res.code).toBe(200) // 主流程仍成功
      expect(onSuccess).toHaveBeenCalledTimes(1)
    })

    test('节流命中时不触发 onSuccess', async () => {
      const cloud = makeCloud()
      const onSuccess = jest.fn()
      await callSibling(
        cloud, 'fn', { familyId: 'f1' }, 'oid',
        { throttleMs: 5000, throttleState: () => Date.now(), onSuccess }
      )
      expect(onSuccess).not.toHaveBeenCalled()
    })
  })
})
