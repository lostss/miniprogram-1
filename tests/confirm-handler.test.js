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
  // P2-L1：生产路径（index.js 传入）stateCache 才是状态块失效目标
  const stateCache = { invalidate: jest.fn() }
  return { dispatch, writeMessage, ctxCache, stateCache }
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

  test('pendingId 不匹配 → 400（P2-B 可读提示）', async () => {
    const r = await handleConfirm({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'other', type: 'fact_confirm' }] },
      ctxCache: { invalidate: jest.fn() }, dispatch: jest.fn(), writeMessage: jest.fn()
    })
    expect(r.code).toBe(400)
    expect(r.msg).toContain('已失效')
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
    const { dispatch, writeMessage, ctxCache, stateCache } = makeDeps({ dispatchResult: { code: 200, msg: 'ok' } })
    const r = await handleConfirm({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'fact_confirm', factId: 'fact_001' }] },
      ctxCache, stateCache, dispatch, writeMessage
    })
    expect(r.code).toBe(200)
    // P2-L1：失效打在 stateCache（生产路径）；ctxCache 仅旧调用回退
    expect(stateCache.invalidate).toHaveBeenCalledWith('state:fam_001:op_test')
    expect(dispatch).toHaveBeenCalledWith('updateFactConfidence', expect.objectContaining({
      familyId: 'fam_001', factId: 'fact_001', confidence: 1, source: 'agent_confirmed'
    }), 'op_test')
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

  test('userText 为空时使用友好化确认文案（历史显示修复：落库中文而非 {CONFIRM:xxx}）', async () => {
    const { dispatch, writeMessage, ctxCache } = makeDeps()
    await handleConfirm({
      ...baseArgs,
      userText: '',
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'fact_confirm', factId: 'fact_001' }] },
      ctxCache, dispatch, writeMessage
    })
    expect(writeMessage.mock.calls[0][3]).toBe('确认')
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
    }), 'op_test')
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
    }), 'op_test')
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

  test('write_confirm 类型 → 回复"已取消写入"，log write_keep', async () => {
    const writeMessage = jest.fn().mockResolvedValue(true)
    const r = await handleKeep({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'write_confirm', toolName: 'updateFinances' }] },
      writeMessage
    })
    expect(r.code).toBe(200)
    expect(writeMessage.mock.calls[1][3]).toBe('已取消写入')
    expect(logAI.mock.calls[0][1]).toMatchObject({ action: 'write_keep' })
  })

  test('无待确认项（lastMsg null / 卡已过期）→ 400 可读失效提示', async () => {
    const writeMessage = jest.fn().mockResolvedValue(true)
    const r = await handleKeep({ ...baseArgs, lastMsg: null, writeMessage })
    expect(r.code).toBe(400)
    expect(r.msg).toContain('已失效')
    // 不写消息、不记日志（无实际保留动作）
    expect(writeMessage).not.toHaveBeenCalled()
    expect(logAI).not.toHaveBeenCalled()
  })
})

describe('STRATEGIES 策略表', () => {
  test('四类策略齐全（单通道 v10 新增 write_confirm）', () => {
    expect(Object.keys(STRATEGIES).sort()).toEqual(['delete_confirm', 'fact_confirm', 'member_confirm', 'write_confirm'])
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

describe('handleConfirm - write_confirm（单通道 v10 写入确认卡）', () => {
  test('成功路径：dispatch 工具名 + payload + confirmed:true，reply 含确认语', async () => {
    const { dispatch, writeMessage, ctxCache, stateCache } = makeDeps()
    const r = await handleConfirm({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'write_confirm', toolName: 'updateFinances', payload: { annual_income: 250000 }, target: '家庭财务', summary: '年收入:250,000元' }] },
      ctxCache, stateCache, dispatch, writeMessage
    })
    expect(r.code).toBe(200)
    expect(dispatch).toHaveBeenCalledWith('updateFinances', expect.objectContaining({
      familyId: 'fam_001', annual_income: 250000, confirmed: true
    }), 'op_test')
    // P2-L1：失效打在 stateCache（生产路径）
    expect(stateCache.invalidate).toHaveBeenCalledWith('state:fam_001:op_test')
    expect(writeMessage).toHaveBeenCalledTimes(2)
    expect(writeMessage.mock.calls[1][3]).toContain('已确认写入')
    expect(writeMessage.mock.calls[1][3]).toContain('家庭财务')
    expect(logAI).toHaveBeenCalledTimes(1)
    expect(logAI.mock.calls[0][1]).toMatchObject({ action: 'write_confirm', status: 'success' })
  })

  test('dispatch 失败 → reply 包含失败信息', async () => {
    const { dispatch, writeMessage, ctxCache } = makeDeps({ dispatchResult: { code: 500, msg: 'DB error' } })
    const r = await handleConfirm({
      ...baseArgs,
      lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'write_confirm', toolName: 'addPolicy', payload: {}, target: '保单', summary: '' }] },
      ctxCache, dispatch, writeMessage
    })
    expect(r.code).toBe(200)
    expect(writeMessage.mock.calls[1][3]).toContain('写入失败')
    expect(writeMessage.mock.calls[1][3]).toContain('DB error')
  })
})
