/**
 * linkCashValue — 孤儿现价表人工关联（2026-09-11 新增闭环）
 *
 * 背景：自动匹配（产品名去后缀取前 8 字 + 被保人）不中的现价表停留在 matched=false，
 * 报告只读 matched:true → 数据在库但从不展示、用户无补救入口；
 * matched_by='manual' 此前只有读取保护逻辑（writeCashValue 中），从无写入路径。
 *
 * 本测试锁定：参数校验、双层归属校验（_openid 防越权）、已删除保单拒绝、成功路径契约。
 */
jest.mock('../cloudfunctions/dataWrite/_shared/writeSeam', () => ({
  writeSeam: jest.fn(() => ({
    silentUpdateDoc: jest.fn().mockResolvedValue({}),
    silentUpdateWhere: jest.fn().mockResolvedValue({}),
    triggerHooks: jest.fn().mockResolvedValue(undefined)
  }))
}))

const { linkCashValue } = require('../cloudfunctions/dataWrite/policy-write')
const { writeSeam } = require('../cloudfunctions/dataWrite/_shared/writeSeam')

/** 极简链式 mock：collection(name).where().limit().get() → 按集合名返回预置数据 */
function mockDb({ cash = null, policy = null } = {}) {
  const db = {
    collection: jest.fn((name) => ({
      where: jest.fn(() => ({
        limit: jest.fn(() => ({
          get: jest.fn().mockResolvedValue({
            data: name === 'policy_cash_values' ? (cash ? [cash] : []) : (policy ? [policy] : [])
          })
        }))
      }))
    }))
  }
  return db
}

const CASH = { _id: 'cv_1', cash_values: [{ y: 1, v: 100 }, { y: 2, v: 200 }], matched: false }
const POLICY = { _id: 'p_doc', id: 'pol_1', product_name: '安心保臻选版', status: 'active' }

const ARGS = { familyId: 'f1', cashValueId: 'cv_1', policyId: 'pol_1' }

beforeEach(() => jest.clearAllMocks())

describe('linkCashValue — 参数与归属校验', () => {
  test('缺任一参数 → 400 且不查库', async () => {
    const db = mockDb()
    expect((await linkCashValue(db, 'o1', { familyId: 'f1' })).code).toBe(400)
    expect((await linkCashValue(db, 'o1', { familyId: 'f1', cashValueId: 'cv_1' })).code).toBe(400)
    expect(db.collection).not.toHaveBeenCalled()
  })

  test('现价表不存在或非本家庭 → 404（不写库）', async () => {
    const db = mockDb({ cash: null, policy: POLICY })
    const r = await linkCashValue(db, 'o1', ARGS)
    expect(r.code).toBe(404)
    expect(writeSeam).not.toHaveBeenCalled()
  })

  test('目标保单不存在 → 404', async () => {
    const db = mockDb({ cash: CASH, policy: null })
    const r = await linkCashValue(db, 'o1', ARGS)
    expect(r.code).toBe(404)
    expect(writeSeam).not.toHaveBeenCalled()
  })

  test('目标保单已删除 → 400（避免把现价表挂到软删保单）', async () => {
    const db = mockDb({ cash: CASH, policy: Object.assign({}, POLICY, { status: 'deleted' }) })
    const r = await linkCashValue(db, 'o1', ARGS)
    expect(r.code).toBe(400)
    expect(writeSeam).not.toHaveBeenCalled()
  })

  test('查询条件带 _openid 与 family_id（防越权关联他人数据）', async () => {
    const db = mockDb({ cash: CASH, policy: POLICY })
    await linkCashValue(db, 'o1', ARGS)
    const whereArgs = db.collection.mock.results.map(r => r.value.where.mock.calls[0][0])
    whereArgs.forEach(w => {
      expect(w._openid).toBe('o1')
      expect(w.family_id).toBe('f1')
    })
  })
})

describe('linkCashValue — 成功路径', () => {
  test('写 matched_by=manual 并回写保单现价标记，返回 200', async () => {
    const db = mockDb({ cash: CASH, policy: POLICY })
    const r = await linkCashValue(db, 'o1', ARGS)
    expect(r.code).toBe(200)
    expect(r.data.matched).toBe(true)
    expect(r.data.policyId).toBe('pol_1')

    const ws = writeSeam.mock.results[0].value
    expect(ws.silentUpdateDoc).toHaveBeenCalledWith('policy_cash_values', 'cv_1', expect.objectContaining({
      policy_id: 'pol_1', matched: true, matched_by: 'manual'
    }))
    // latest_cash_value 取末行（与自动匹配同口径）
    expect(ws.silentUpdateWhere).toHaveBeenCalledWith('policies', { id: 'pol_1' }, expect.objectContaining({
      cash_value_available: true, latest_cash_value: 200
    }))
    expect(ws.triggerHooks).toHaveBeenCalled()
  })

  test('cash_values 为空数组 → latest_cash_value 记 0（不崩溃）', async () => {
    const db = mockDb({ cash: Object.assign({}, CASH, { cash_values: [] }), policy: POLICY })
    const r = await linkCashValue(db, 'o1', ARGS)
    expect(r.code).toBe(200)
    const ws = writeSeam.mock.results[0].value
    expect(ws.silentUpdateWhere).toHaveBeenCalledWith('policies', { id: 'pol_1' }, expect.objectContaining({
      latest_cash_value: 0
    }))
  })
})
