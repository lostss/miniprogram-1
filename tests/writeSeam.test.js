/**
 * writeSeam 单元测试
 *
 * 测试 cloudfunctions/dataWrite/_shared/writeSeam.js 的写入不变量与钩子机制。
 * 策略：构造 mock db 对象传入 writeSeam（不 jest.mock 源码依赖除 stageMachine 外）。
 * stageMachine 被 mock 以隔离 advanceStage 的阶段计算逻辑。
 */

// Mock stageMachine —— 必须在 require writeSeam 之前声明（jest.mock 会被 hoist）
jest.mock('../cloudfunctions/dataWrite/_shared/domain/stageMachine', () => ({
  evaluateStage: jest.fn(() => 'stage_2')
}))

const { writeSeam, advanceStage } = require('../cloudfunctions/dataWrite/_shared/writeSeam')
const { evaluateStage } = require('../cloudfunctions/dataWrite/_shared/domain/stageMachine')

// ---------------------------------------------------------------------------
// Mock DB 构造器
// ---------------------------------------------------------------------------

function makeMockDb(collections = {}) {
  const calls = { updates: [], adds: [], removes: [], queries: [], counts: [] }
  // 深拷贝初始数据，避免测试间状态共享
  const store = {}
  Object.keys(collections).forEach(k => {
    store[k] = collections[k].map(x => ({ ...x }))
  })

  function matchWhere(rows, w) {
    return rows.filter(x => Object.keys(w).every(k => x[k] === w[k]))
  }

  const db = {
    collection: (name) => {
      if (!store[name]) store[name] = []
      const data = store[name]
      return {
        add: ({ data: d }) => {
          calls.adds.push({ name, data: d })
          const rec = { _id: 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), ...d }
          data.push(rec)
          return Promise.resolve({ _id: rec._id })
        },
        where: (w) => {
          calls.queries.push({ name, where: w })
          return {
            update: ({ data: d }) => {
              calls.updates.push({ name, where: w, data: d })
              return Promise.resolve({ stats: { updated: matchWhere(data, w).length } })
            },
            remove: () => {
              calls.removes.push({ name, where: w })
              return Promise.resolve({ stats: { removed: matchWhere(data, w).length } })
            },
            get: () => Promise.resolve({ data: matchWhere(data, w) }),
            limit: (n) => ({
              get: () => Promise.resolve({ data: matchWhere(data, w).slice(0, n) })
            }),
            count: () => {
              calls.counts.push({ name, where: w })
              return Promise.resolve({ total: matchWhere(data, w).length })
            }
          }
        },
        doc: (id) => ({
          get: () => Promise.resolve({ data: data.find(x => x._id === id) || null }),
          update: ({ data: d }) => {
            calls.updates.push({ name, docId: id, data: d })
            const rec = data.find(x => x._id === id)
            if (rec) Object.assign(rec, d)
            return Promise.resolve({ stats: { updated: rec ? 1 : 0 } })
          },
          remove: () => {
            calls.removes.push({ name, docId: id })
            const idx = data.findIndex(x => x._id === id)
            if (idx >= 0) data.splice(idx, 1)
            return Promise.resolve({ stats: { removed: idx >= 0 ? 1 : 0 } })
          }
        })
      }
    }
  }
  return { db, calls }
}

// 等待 fire-and-forget 的 advanceStage 异步钩子完成
const flush = () => new Promise(r => setTimeout(r, 10))

// 在 calls.updates 中查找指定集合且 data 满足 predicate 的更新记录
function findUpdate(calls, name, predicate) {
  return calls.updates.find(u => u.name === name && predicate(u.data))
}

// 每个测试前重置 evaluateStage mock，默认返回 'stage_2'
beforeEach(() => {
  evaluateStage.mockReset()
  evaluateStage.mockReturnValue('stage_2')
})

// ---------------------------------------------------------------------------
// 1. _openid 注入不变量
// ---------------------------------------------------------------------------

describe('writeSeam — _openid 注入不变量', () => {
  test('safeAdd 缺 openid 抛错', async () => {
    const { db } = makeMockDb()
    const ws = writeSeam(db, null)
    await expect(ws.silentAdd('members', { name: 'x' })).rejects.toThrow('safeAdd 缺少 openid')
  })

  test('safeUpdateWhere 缺 openid 抛错', async () => {
    const { db } = makeMockDb()
    const ws = writeSeam(db, null)
    await expect(ws.silentUpdateWhere('members', { id: 'm1' }, { x: 1 })).rejects.toThrow('safeUpdateWhere 缺少 openid')
  })

  test('safeAdd 自动注入 _openid', async () => {
    const { db, calls } = makeMockDb()
    const ws = writeSeam(db, 'op1')
    await ws.silentAdd('members', { name: 'x' })
    expect(calls.adds.length).toBe(1)
    expect(calls.adds[0].data._openid).toBe('op1')
    expect(calls.adds[0].data.name).toBe('x')
  })

  test('safeUpdateWhere 自动注入 _openid 到 where + updated_at 到 data', async () => {
    const { db, calls } = makeMockDb()
    const ws = writeSeam(db, 'op1')
    await ws.silentUpdateWhere('members', { id: 'm1' }, { x: 1 })
    expect(calls.updates.length).toBe(1)
    expect(calls.updates[0].where._openid).toBe('op1')
    expect(calls.updates[0].where.id).toBe('m1')
    expect(calls.updates[0].data.updated_at).toBeInstanceOf(Date)
    expect(calls.updates[0].data.x).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. 带钩子写入
// ---------------------------------------------------------------------------

describe('writeSeam — 带钩子写入', () => {
  test('updateWhere 触发 markFamilyMutated', async () => {
    const { db, calls } = makeMockDb()
    const ws = writeSeam(db, 'op1', 'fam1')
    await ws.updateWhere('policies', { id: 'p1' }, { x: 1 })
    // markFamilyMutated 应更新 families 表 insight_stale=true
    const famUpdate = findUpdate(calls, 'families', d => d.insight_stale === true)
    expect(famUpdate).toBeDefined()
    expect(famUpdate.where._id).toBe('fam1')
    expect(famUpdate.where._openid).toBe('op1')
    expect(famUpdate.data.updated_at).toBeInstanceOf(Date)
  })

  test('updateDoc 触发 advanceStage', async () => {
    const { db, calls } = makeMockDb({
      families: [{ _id: 'fam1', _openid: 'op1', engagement_stage: 'stage_1' }]
    })
    evaluateStage.mockReturnValue('stage_2')
    const ws = writeSeam(db, 'op1', 'fam1')
    await ws.updateDoc('policies', 'p1', { x: 1 })
    await flush()
    // advanceStage 应更新 families 表 engagement_stage='stage_2'
    const stageUpdate = findUpdate(calls, 'families', d => d.engagement_stage === 'stage_2')
    expect(stageUpdate).toBeDefined()
  })

  test('removeDoc 触发钩子 (markFamilyMutated)', async () => {
    const { db, calls } = makeMockDb()
    const ws = writeSeam(db, 'op1', 'fam1')
    await ws.removeDoc('policies', 'p1')
    const famUpdate = findUpdate(calls, 'families', d => d.insight_stale === true)
    expect(famUpdate).toBeDefined()
    expect(famUpdate.where._id).toBe('fam1')
  })

  test('不带 familyId 不触发钩子', async () => {
    const { db, calls } = makeMockDb()
    const ws = writeSeam(db, 'op1', null)
    await ws.updateWhere('policies', { id: 'p1' }, { x: 1 })
    await flush()
    const famUpdates = calls.updates.filter(u => u.name === 'families')
    expect(famUpdates.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. 静默变体
// ---------------------------------------------------------------------------

describe('writeSeam — 静默变体', () => {
  test('silentUpdateWhere 不触发钩子', async () => {
    const { db, calls } = makeMockDb()
    const ws = writeSeam(db, 'op1', 'fam1')
    await ws.silentUpdateWhere('policies', { id: 'p1' }, { x: 1 })
    await flush()
    const famUpdates = calls.updates.filter(u => u.name === 'families')
    expect(famUpdates.length).toBe(0)
  })

  test('silentRemoveWhere 不触发钩子', async () => {
    const { db, calls } = makeMockDb()
    const ws = writeSeam(db, 'op1', 'fam1')
    await ws.silentRemoveWhere('policies', { id: 'p1' })
    await flush()
    const famUpdates = calls.updates.filter(u => u.name === 'families')
    expect(famUpdates.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. 批量操作
// ---------------------------------------------------------------------------

describe('writeSeam — 批量操作', () => {
  test('batchRemove 循环删除 (batchSize=2, 5 条数据)', async () => {
    const policies = []
    for (let i = 0; i < 5; i++) {
      policies.push({ _id: 'p' + i, _openid: 'op1', family_id: 'fam1' })
    }
    const { db, calls } = makeMockDb({ policies })
    const ws = writeSeam(db, 'op1', 'fam1')
    const deleted = await ws.batchRemove('policies', { family_id: 'fam1' }, 2)
    expect(deleted).toBe(5)
    // 应循环 3 次 get 查询 (2 + 2 + 1)
    const getQueries = calls.queries.filter(q => q.name === 'policies')
    expect(getQueries.length).toBe(3)
  })

  test('batchRemove 失败返回 0', async () => {
    // 构造 where 抛错的 db
    const db = {
      collection: () => ({
        where: () => { throw new Error('query failed') }
      })
    }
    const ws = writeSeam(db, 'op1', 'fam1')
    const deleted = await ws.batchRemove('policies', { family_id: 'fam1' }, 10)
    expect(deleted).toBe(0)
  })

  test('batchSupersede 返回 updated count', async () => {
    const policies = [
      { _id: 'p1', _openid: 'op1', family_id: 'fam1', status: 'active' },
      { _id: 'p2', _openid: 'op1', family_id: 'fam1', status: 'active' },
      { _id: 'p3', _openid: 'op1', family_id: 'fam1', status: 'active' }
    ]
    const { db } = makeMockDb({ policies })
    const ws = writeSeam(db, 'op1', 'fam1')
    const updated = await ws.batchSupersede('policies', { family_id: 'fam1' })
    expect(updated).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 5. batchTx
// ---------------------------------------------------------------------------

describe('writeSeam — batchTx', () => {
  test('batchTx 全成功', async () => {
    const { db } = makeMockDb()
    const ws = writeSeam(db, 'op1')
    const steps = [
      { name: 's1', exec: () => Promise.resolve('r1') },
      { name: 's2', exec: () => Promise.resolve('r2') },
      { name: 's3', exec: () => Promise.resolve('r3') }
    ]
    const result = await ws.batchTx(steps)
    expect(result.completed).toBe(3)
    expect(result.failed).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.results).toEqual(['r1', 'r2', 'r3'])
  })

  test('batchTx 部分失败', async () => {
    const { db } = makeMockDb()
    const ws = writeSeam(db, 'op1')
    const steps = [
      { name: 's1', exec: () => Promise.resolve('r1') },
      { name: 's2', exec: () => Promise.reject(new Error('boom')) },
      { name: 's3', exec: () => Promise.resolve('r3') }
    ]
    const result = await ws.batchTx(steps)
    expect(result.completed).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].step).toBe('s2')
    expect(result.errors[0].error).toBe('boom')
    expect(result.results).toEqual(['r1', null, 'r3'])
  })

  test('batchTx 空数组', async () => {
    const { db } = makeMockDb()
    const ws = writeSeam(db, 'op1')
    const result = await ws.batchTx([])
    expect(result.completed).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.results).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 6. advanceStage (独立导出函数)
// ---------------------------------------------------------------------------

describe('advanceStage (独立导出函数)', () => {
  test('advanceStage 推进 stage', async () => {
    const { db, calls } = makeMockDb({
      families: [{ _id: 'fam1', _openid: 'op1', engagement_stage: 'stage_1' }]
    })
    evaluateStage.mockReturnValue('stage_2')
    await advanceStage(db, 'fam1', 'op1')
    const stageUpdate = findUpdate(calls, 'families', d => d.engagement_stage === 'stage_2')
    expect(stageUpdate).toBeDefined()
  })

  test('advanceStage 无变化不更新', async () => {
    const { db, calls } = makeMockDb({
      families: [{ _id: 'fam1', _openid: 'op1', engagement_stage: 'stage_2' }]
    })
    evaluateStage.mockReturnValue('stage_2')
    await advanceStage(db, 'fam1', 'op1')
    const stageUpdates = calls.updates.filter(
      u => u.name === 'families' && u.data && 'engagement_stage' in u.data
    )
    expect(stageUpdates.length).toBe(0)
  })

  test('advanceStage 无 family 跳过', async () => {
    const { db, calls } = makeMockDb({})
    await advanceStage(db, 'fam1', 'op1')
    const famUpdates = calls.updates.filter(u => u.name === 'families')
    expect(famUpdates.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 7. 钩子配置
// ---------------------------------------------------------------------------

describe('writeSeam — 钩子配置', () => {
  test('opts.markMutated=false 只触发 advanceStage 不触发 markFamilyMutated', async () => {
    const { db, calls } = makeMockDb({
      families: [{ _id: 'fam1', _openid: 'op1', engagement_stage: 'stage_1' }]
    })
    evaluateStage.mockReturnValue('stage_2')
    const ws = writeSeam(db, 'op1', 'fam1', { markMutated: false })
    await ws.updateWhere('members', { id: 'm1' }, { x: 1 })
    await flush()
    // advanceStage 应运行：families 表有 engagement_stage 更新
    const stageUpdate = findUpdate(calls, 'families', d => d.engagement_stage === 'stage_2')
    expect(stageUpdate).toBeDefined()
    // markFamilyMutated 不应运行：无 insight_stale 更新
    const staleUpdates = calls.updates.filter(
      u => u.name === 'families' && u.data && u.data.insight_stale === true
    )
    expect(staleUpdates.length).toBe(0)
  })

  test('opts.advanceStageHook=false 只触发 markFamilyMutated 不触发 advanceStage', async () => {
    const { db, calls } = makeMockDb({
      families: [{ _id: 'fam1', _openid: 'op1', engagement_stage: 'stage_1' }]
    })
    evaluateStage.mockReturnValue('stage_2')
    const ws = writeSeam(db, 'op1', 'fam1', { advanceStageHook: false })
    await ws.updateWhere('members', { id: 'm1' }, { x: 1 })
    await flush()
    // markFamilyMutated 应运行：families 表有 insight_stale 更新
    const staleUpdate = findUpdate(calls, 'families', d => d.insight_stale === true)
    expect(staleUpdate).toBeDefined()
    // advanceStage 不应运行：无 engagement_stage 更新
    const stageUpdates = calls.updates.filter(
      u => u.name === 'families' && u.data && 'engagement_stage' in u.data
    )
    expect(stageUpdates.length).toBe(0)
  })
})
