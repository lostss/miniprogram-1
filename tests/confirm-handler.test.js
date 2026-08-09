/**
 * confirm-handler 测试
 * 架构审计第 13 轮候选 #4：补单测
 *
 * 覆盖策略表三类（fact_confirm / member_confirm / delete_confirm）+ handleKeep 分支
 */
// 先 mock logSeam，避免 require 链触发 wx-server-sdk
jest.mock('../cloudfunctions/conversationAI/_shared/logSeam', () => ({
  logAI: jest.fn().mockResolvedValue(undefined)
}))

const { handleConfirm, handleKeep, STRATEGIES } = require('../cloudfunctions/conversationAI/confirm-handler')
const { logAI } = require('../cloudfunctions/conversationAI/_shared/logSeam')

beforeEach(() => {
  jest.clearAllMocks()
})

function makeDeps({ dispatchResult = { code: 200, msg: 'ok' } } = {}) {
  const dispatch = jest.fn().mockResolvedValue(dispatchResult)
  const writeMessage = jest.fn().mockResolvedValue(true)
  const ctxCache = { invalidate: jest.fn() }
  return { dispatch, writeMessage, ctxCache }
}

const baseArgs = {
  familyId: 'fam_001',
  openid: 'op_test',
  pendingId: 'pc_001',
  sid: 'sess_001',
  userText: '确认',
  db: {},
  promptVersion: 'v1'
}

describe('handleConfirm - 输入校验', () => {
  test('无 lastMsg → 404', async () => {
    const r = await handleConfirm({ ...baseArgs, lastMsg: null, ctxCache: { invalidate: jest.fn() }, dispatch: jest.fn(), writeMessage: jest.fn() })
    expect(r.code).toBe(404)
    expect(r.msg).toContain('未找到')
  })

  test('lastMsg 无 pending_confirms → 404', async () => {
    const r = await handleConfirm({ ...baseArgs, lastMsg: {}, ctxCache: { invalidate: jest.fn() }, dispatch: jest.fn(), writeMessage: jest.fn() })
    expect(r.code).toBe(404)
  })

  test('pending_confirms 为空数组 → 404', async () => {
    const r = await handleConfirm({ ...baseArgs, lastMsg: { pending_confirms: [] }, ctxCache: { invalidate: jest.fn() }, dispatch: jest.fn(), writeMessage: jest.fn() })
    expect(r.code).toBe(404)
  })

  test('pendingId 不匹配 → 400', async () => {
    const r = await handleConfirm({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'other', type: 'fact_confirm' }] },
      ctxCache: { invalidate: jest.fn() }, dispatch: jest.fn(), writeMessage: jest.fn()
    })
    expect(r.code).toBe(400)
    expect(r.msg).toContain('无效')
  })

  test('不支持的 type → 400', async () => {
    const r = await handleConfirm({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'unknown_type' }] },
      ctxCache: { invalidate: jest.fn() }, dispatch: jest.fn(), writeMessage: jest.fn()
    })
    expect(r.code).toBe(400)
    expect(r.msg).toContain('不支持')
  })
})

describe('handleConfirm - fact_confirm', () => {
  test('成功路径：清缓存→dispatch→写消息→log', async () => {
    const { dispatch, writeMessage, ctxCache } = makeDeps({ dispatchResult: { code: 200, msg: 'ok' } })
    const r = await handleConfirm({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'fact_confirm', factId: 'fact_001' }] },
      ctxCache, dispatch, writeMessage
    })
    expect(r.code).toBe(200)
    expect(ctxCache.invalidate).toHaveBeenCalledWith('fam_001:op_test')
    expect(dispatch).toHaveBeenCalledWith('updateFactConfidence', expect.objectContaining({
      familyId: 'fam_001', factId: 'fact_001', confidence: 1, source: 'agent_confirmed'
    }))
    // 写两条消息：user + assistant
    expect(writeMessage).toHaveBeenCalledTimes(2)
    expect(writeMessage.mock.calls[0][2]).toBe('user')
    expect(writeMessage.mock.calls[1][2]).toBe('assistant')
    expect(writeMessage.mock.calls[1][3]).toContain('已确认事实')
    expect(logAI).toHaveBeenCalledTimes(1)
    // logAI(db, payload) —— payload 是第二个参数
    expect(logAI.mock.calls[0][1]).toMatchObject({ action: 'fact_confirm', status: 'success' })
  })

  test('dispatch 失败 → reply 包含失败信息', async () => {
    const { dispatch, writeMessage, ctxCache } = makeDeps({ dispatchResult: { code: 500, msg: 'DB error' } })
    const r = await handleConfirm({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'fact_confirm', factId: 'fact_001' }] },
      ctxCache, dispatch, writeMessage
    })
    expect(r.code).toBe(200)
    expect(writeMessage.mock.calls[1][3]).toContain('确认失败')
    expect(writeMessage.mock.calls[1][3]).toContain('DB error')
  })

  test('userText 为空时使用 {CONFIRM:pendingId}', async () => {
    const { dispatch, writeMessage, ctxCache } = makeDeps()
    await handleConfirm({
      ...baseArgs,
      userText: '',
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'fact_confirm', factId: 'fact_001' }] },
      ctxCache, dispatch, writeMessage
    })
    expect(writeMessage.mock.calls[0][3]).toBe('{CONFIRM:pc_001}')
  })
})

describe('handleConfirm - member_confirm', () => {
  test('成功路径：dispatch upsertMember 带 confirmed:true', async () => {
    const { dispatch, writeMessage, ctxCache } = makeDeps()
    const proposed = { name: '张三', age: 35 }
    await handleConfirm({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'member_confirm', memberName: '张三', memberId: 'mem_001', proposed }] },
      ctxCache, dispatch, writeMessage
    })
    expect(dispatch).toHaveBeenCalledWith('upsertMember', expect.objectContaining({
      familyId: 'fam_001', memberName: '张三', memberId: 'mem_001', data: proposed, confirmed: true
    }))
    expect(writeMessage.mock.calls[1][3]).toContain('已确认并更新成员信息')
    expect(logAI.mock.calls[0][1]).toMatchObject({ action: 'member_confirm' })
  })
})

describe('handleConfirm - delete_confirm', () => {
  test('成功路径：dispatch 带 confirmed:true + payload 展开', async () => {
    const { dispatch, writeMessage, ctxCache } = makeDeps({ dispatchResult: { code: 200, msg: 'ok' } })
    await handleConfirm({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'delete_confirm', toolName: 'deletePolicy', payload: { policyId: 'pol_001' }, target: '平安福' }] },
      ctxCache, dispatch, writeMessage
    })
    expect(dispatch).toHaveBeenCalledWith('deletePolicy', expect.objectContaining({
      familyId: 'fam_001', policyId: 'pol_001', confirmed: true
    }))
    expect(writeMessage.mock.calls[1][3]).toContain('已删除平安福')
  })

  test('dispatch 失败 → status=failed', async () => {
    const { dispatch, writeMessage, ctxCache } = makeDeps({ dispatchResult: { code: 500, msg: '权限不足' } })
    await handleConfirm({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'delete_confirm', toolName: 'deletePolicy', payload: { policyId: 'pol_001' }, target: 'X' }] },
      ctxCache, dispatch, writeMessage
    })
    expect(logAI.mock.calls[0][1]).toMatchObject({ status: 'failed' })
    expect(writeMessage.mock.calls[1][3]).toContain('删除失败')
  })
})

describe('handleKeep', () => {
  test('缺 familyId → 400', async () => {
    const r = await handleKeep({ ...baseArgs, familyId: '', writeMessage: jest.fn() })
    expect(r.code).toBe(400)
  })

  test('缺 openid → 400', async () => {
    const r = await handleKeep({ ...baseArgs, openid: '', writeMessage: jest.fn() })
    expect(r.code).toBe(400)
  })

  test('delete_confirm 类型 → 回复"已取消删除"', async () => {
    const writeMessage = jest.fn().mockResolvedValue(true)
    const r = await handleKeep({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'delete_confirm' }] },
      writeMessage
    })
    expect(r.code).toBe(200)
    expect(writeMessage.mock.calls[1][3]).toBe('已取消删除')
    expect(logAI).toHaveBeenCalledTimes(1)
    expect(logAI.mock.calls[0][1]).toMatchObject({ action: 'delete_keep' })
  })

  test('非 delete 类型 → 回复"已保留原值"', async () => {
    const writeMessage = jest.fn().mockResolvedValue(true)
    const r = await handleKeep({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'member_confirm' }] },
      writeMessage
    })
    expect(writeMessage.mock.calls[1][3]).toContain('已保留原值')
    expect(logAI.mock.calls[0][1]).toMatchObject({ action: 'member_keep' })
  })

  test('无 lastMsg 也能走 member_keep 路径', async () => {
    const writeMessage = jest.fn().mockResolvedValue(true)
    const r = await handleKeep({ ...baseArgs, lastMsg: null, writeMessage })
    expect(r.code).toBe(200)
    expect(writeMessage.mock.calls[1][3]).toContain('已保留原值')
  })
})

describe('STRATEGIES 策略表', () => {
  test('三类策略齐全', () => {
    expect(Object.keys(STRATEGIES).sort()).toEqual(['delete_confirm', 'fact_confirm', 'member_confirm'])
  })

  test('每个策略都有 4 个 hook', () => {
    for (const [name, s] of Object.entries(STRATEGIES)) {
      expect(typeof s.logAction).toBe('string')
      expect(typeof s.exec).toBe('function')
      expect(typeof s.reply).toBe('function')
      expect(typeof s.logStatus).toBe('function')
    }
  })
})
