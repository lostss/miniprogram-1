/**
 * undo-handler 测试（② 默认执行+撤销，2026-08-30）
 *
 * 覆盖：参数校验、记录不存在、窗口过期、updateFinances/upsertMember/addFact 恢复、恢复失败
 */
jest.mock('../cloudfunctions/conversationAI/undo-store', () => ({
  findPending: jest.fn(),
  updateStatus: jest.fn()
}))
jest.mock('../cloudfunctions/conversationAI/_shared/memberRepo', () => ({
  restoreFinance: jest.fn().mockResolvedValue({ code: 200, data: { action: 'restored' } }),
  restoreMember: jest.fn().mockResolvedValue({ code: 200, data: { action: 'restored' } })
}))
// B3（2026-08-30 审计）：_restoreFact 改走 writeSeam（统一 _openid + markMutated），测试 mock 接缝
const mockSilentUpdateDoc = jest.fn().mockResolvedValue({})
const mockTriggerHooks = jest.fn().mockResolvedValue()
jest.mock('../cloudfunctions/conversationAI/_shared/writeSeam', () => ({
  writeSeam: () => ({ silentUpdateDoc: mockSilentUpdateDoc, triggerHooks: mockTriggerHooks })
}))

const { handleUndo } = require('../cloudfunctions/conversationAI/undo-handler')
const { findPending, updateStatus } = require('../cloudfunctions/conversationAI/undo-store')
const { restoreFinance, restoreMember } = require('../cloudfunctions/conversationAI/_shared/memberRepo')

beforeEach(() => {
  jest.clearAllMocks()
})

function makeRec(overrides = {}) {
  return {
    _id: 'doc_1',
    op_id: 'ud_test',
    tool: 'updateFinances',
    before: { _id: 'fin_1', annual_income: 100000 },
    after: null,
    expires_at: new Date(Date.now() + 60000),
    status: 'pending',
    ...overrides
  }
}

const base = {
  familyId: 'fam_001',
  openid: 'op_test',
  opId: 'ud_test',
  sid: 'sess_1',
  db: {},
  writeMessage: jest.fn().mockResolvedValue(true),
  ctxCache: { invalidate: jest.fn() },
  // P2-L1：生产路径（index.js 传入）stateCache 才是状态块失效目标
  stateCache: { invalidate: jest.fn() }
}

describe('handleUndo - 输入校验', () => {
  test('缺参数 → 400', async () => {
    const r = await handleUndo({ familyId: '', openid: 'x', opId: 'y', db: {}, writeMessage: jest.fn() })
    expect(r.code).toBe(400)
  })

  test('记录不存在/已处理 → 400', async () => {
    findPending.mockResolvedValue(null)
    const r = await handleUndo(base)
    expect(r.code).toBe(400)
    expect(r.msg).toContain('已失效')
  })

  test('窗口过期 → 400 且标记 settled', async () => {
    findPending.mockResolvedValue(makeRec({ expires_at: new Date(Date.now() - 1000) }))
    const r = await handleUndo(base)
    expect(r.code).toBe(400)
    expect(r.msg).toContain('已生效')
    expect(updateStatus).toHaveBeenCalledWith({}, 'doc_1', 'settled')
  })
})

describe('handleUndo - 恢复执行', () => {
  test('updateFinances → restoreFinance + 双消息 + invalidate + undone（自然文案）', async () => {
    findPending.mockResolvedValue(makeRec({ payload: { annual_income: 400000 } }))
    const r = await handleUndo(base)
    expect(r.code).toBe(200)
    expect(restoreFinance).toHaveBeenCalled()
    expect(base.writeMessage).toHaveBeenCalledTimes(2)
    expect(base.writeMessage.mock.calls[0][3]).toBe('撤销')
    expect(base.writeMessage.mock.calls[1][3]).toContain('已撤销刚才的家庭财务调整')
    expect(base.writeMessage.mock.calls[1][3]).toContain('年收入 400,000 元')
    // P2-L1：失效打在 stateCache（生产路径）
    expect(base.stateCache.invalidate).toHaveBeenCalledWith('state:fam_001:op_test')
    expect(updateStatus).toHaveBeenCalledWith({}, 'doc_1', 'undone')
  })

  test('updateFinances 新建（before=null）→ "已撤销新建的家庭财务记录"', async () => {
    findPending.mockResolvedValue(makeRec({ before: null }))
    const r = await handleUndo(base)
    expect(r.code).toBe(200)
    expect(base.writeMessage.mock.calls[1][3]).toBe('已撤销新建的家庭财务记录')
  })

  test('upsertMember → 自然文案含成员名', async () => {
    findPending.mockResolvedValue(makeRec({ tool: 'upsertMember', before: { _id: 'm1', member_id: 'mem_1' }, after: { member_id: 'mem_1', action: 'updated' }, payload: { memberName: '张三', data: { age: 40 } } }))
    const r = await handleUndo(base)
    expect(r.code).toBe(200)
    expect(base.writeMessage.mock.calls[1][3]).toBe('已撤销对张三的信息更新')
    expect(restoreMember).toHaveBeenCalled()
  })

  test('upsertMember → restoreMember', async () => {
    findPending.mockResolvedValue(makeRec({ tool: 'upsertMember', before: { _id: 'm1', member_id: 'mem_1' }, after: { member_id: 'mem_1', action: 'updated' } }))
    const r = await handleUndo(base)
    expect(r.code).toBe(200)
    expect(restoreMember).toHaveBeenCalled()
  })

  test('addFact → 经 writeSeam 对 after.factId 置 superseded（B3 统一写接缝）', async () => {
    findPending.mockResolvedValue(makeRec({ tool: 'addFact', before: null, after: { factId: 'fact_1' } }))
    const r = await handleUndo(base)
    expect(r.code).toBe(200)
    expect(mockSilentUpdateDoc).toHaveBeenCalledWith('facts', 'fact_1', { status: 'superseded' })
    expect(mockTriggerHooks).toHaveBeenCalled()
  })

  test('恢复失败 → 500', async () => {
    restoreFinance.mockResolvedValue({ code: 500, msg: 'DB err' })
    findPending.mockResolvedValue(makeRec())
    const r = await handleUndo(base)
    expect(r.code).toBe(500)
    expect(base.writeMessage).not.toHaveBeenCalled()
  })

  test('不支持的撤销类型 → 400', async () => {
    findPending.mockResolvedValue(makeRec({ tool: 'deletePolicy' }))
    const r = await handleUndo(base)
    expect(r.code).toBe(400)
    expect(r.msg).toContain('不支持的撤销类型')
  })
})
