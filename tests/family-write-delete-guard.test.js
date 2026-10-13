/**
 * family-write.deleteFamily — 最终删 family 文档失败必须如实上报（2026-09-22 全面审计 P1 回归）
 *
 * 事故：`_shared/db-helpers.deleteFamily` 内部 catch 后**返回** {code:500} 而从不抛出，
 * 而 family-write 原先 `await deleteFamily(...)` **忽略返回值**后无条件
 * `return { code: 200, msg: '删除成功' }`。后果链：
 *   关联数据（members/policies/facts/…）已全部级联删掉 → family 文档删除失败 →
 *   用户看到"删除成功" → 该家庭继续出现在客户列表里（0 成员，点进去是空报告），
 *   而且因为已"删成功"，用户不会知道需要重试。
 *
 * 本测试把 db-helpers 整体替换为可控桩（只关心本分支的返回值契约）。
 */
jest.mock('../cloudfunctions/dataWrite/_shared/db-helpers', () => ({
  getFamily: jest.fn(() => Promise.resolve({ _id: 'f1', family_name: '测试家庭' })),
  updateFamily: jest.fn(() => Promise.resolve({ code: 200 })),
  deleteFamily: jest.fn(),
  safeQuery: jest.fn(() => Promise.resolve({ data: [] })),
  safeQueryAll: jest.fn(() => Promise.resolve({ data: [], truncated: false })),
  loadAgentByOpenid: jest.fn(),
  loadAgentByPhone: jest.fn()
}))

const { makeMemoryDb } = require('./helpers/memory-db')
const dbHelpers = require('../cloudfunctions/dataWrite/_shared/db-helpers')
const { deleteFamilyHandler } = require('../cloudfunctions/dataWrite/family-write')

// 级联步骤要真的跑通（batchTx 全成功），否则会先命中 207「部分级联失败」分支，
// 掩盖我们要断言的"最后删 family 文档"分支
function makeDb() {
  const store = {}
  for (const c of ['families', 'members', 'messages', 'facts', 'insights', 'policies',
    'policy_cash_values', 'finances', 'reports', 'undo_logs', 'operation_logs', 'agent_logs']) store[c] = []
  return makeMemoryDb(store)
}

describe('deleteFamily：family 文档删除失败不得回 200', () => {
  const openid = 'o1'
  const familyId = 'f1'

  test('db-helpers 返回 {code:500} → handler 返回 207（不再谎报删除成功）', async () => {
    dbHelpers.deleteFamily.mockResolvedValueOnce({ code: 500, msg: '删除失败' })
    const res = await deleteFamilyHandler(makeDb(), openid, { action: 'deleteFamily', familyId })
    expect(res.code).toBe(207)
    expect(res.partial).toBe(true)
    expect(String(res.msg)).toContain('家庭档案删除失败')
    expect(String(res.msg)).not.toContain('删除成功')
  })

  test('db-helpers 返回 {code:200} → 仍返回 200 删除成功', async () => {
    dbHelpers.deleteFamily.mockResolvedValueOnce({ code: 200 })
    const res = await deleteFamilyHandler(makeDb(), openid, { action: 'deleteFamily', familyId })
    expect(res.code).toBe(200)
  })
})
