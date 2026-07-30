/**
 * policy-read 单元测试
 *
 * 测试 cloudfunctions/_shared/policy-read.js 的 loadActivePolicies 接缝。
 * 覆盖读取侧三件套不变量：
 *   1) safeQuery _openid 注入
 *   2) 过滤 deleted
 *   3) ensureStatusBatch 推算状态
 *
 * 策略：构造 mock db 对象传入 loadActivePolicies（不 jest.mock 源码依赖）。
 */

const { loadActivePolicies } = require('../cloudfunctions/_shared/policy-read')

// ---------------------------------------------------------------------------
// Mock DB 构造器
// ---------------------------------------------------------------------------

function makeMockDb(policies = []) {
  const calls = { queries: [] }
  // 深拷贝初始数据，避免测试间状态共享
  const store = { policies: policies.map(x => ({ ...x })) }

  function matchWhere(rows, w) {
    return rows.filter(x => Object.keys(w).every(k => x[k] === w[k]))
  }

  const db = {
    collection: (name) => {
      if (!store[name]) store[name] = []
      const data = store[name]
      return {
        where: (w) => {
          calls.queries.push({ name, where: w })
          return {
            get: () => Promise.resolve({ data: matchWhere(data, w) }),
            limit: (n) => ({
              get: () => Promise.resolve({ data: matchWhere(data, w).slice(0, n) })
            })
          }
        }
      }
    }
  }
  return { db, calls }
}

// 构造保单样本（含 status 字段表示已写入；省略字段表示存量保单需 ensureStatus 推算）
function makePolicy(overrides = {}) {
  return Object.assign({
    _id: 'p_' + Math.random().toString(36).slice(2, 8),
    id: 'pol_' + Math.random().toString(36).slice(2, 8),
    family_id: 'fam1',
    _openid: 'op1',
    product_name: '测试产品',
    insured_name: '张三',
    sum_assured: 100000,
    annual_premium: 5000,
    insurance_period: '终身',
    contract_effective_date: '2020-01-01',
    effective_date: '2020-01-01',
    insured_age: 30,
    status: 'active'
  }, overrides)
}

// ---------------------------------------------------------------------------
// 1. _openid 注入不变量（委托 safeQuery）
// ---------------------------------------------------------------------------

describe('loadActivePolicies — _openid 注入不变量', () => {
  test('查询条件包含 _openid', async () => {
    const { db, calls } = makeMockDb([makePolicy()])
    await loadActivePolicies(db, 'fam1', 'op1')
    expect(calls.queries).toHaveLength(1)
    expect(calls.queries[0].where).toEqual({ family_id: 'fam1', _openid: 'op1' })
  })

  test('不同 openid 查询不同数据', async () => {
    const policies = [
      makePolicy({ _id: 'p1', _openid: 'op1', product_name: 'A的保单' }),
      makePolicy({ _id: 'p2', _openid: 'op2', product_name: 'B的保单' })
    ]
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op2')
    expect(result).toHaveLength(1)
    expect(result[0].product_name).toBe('B的保单')
  })
})

// ---------------------------------------------------------------------------
// 2. 过滤 deleted 不变量
// ---------------------------------------------------------------------------

describe('loadActivePolicies — 过滤 deleted', () => {
  test('默认过滤 status=deleted 的保单', async () => {
    const policies = [
      makePolicy({ _id: 'p1', status: 'active' }),
      makePolicy({ _id: 'p2', status: 'deleted' }),
      makePolicy({ _id: 'p3', status: 'expired' })
    ]
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1')
    expect(result).toHaveLength(2)
    expect(result.map(p => p._id).sort()).toEqual(['p1', 'p3'])
  })

  test('includeDeleted=true 保留 deleted 保单', async () => {
    const policies = [
      makePolicy({ _id: 'p1', status: 'active' }),
      makePolicy({ _id: 'p2', status: 'deleted' })
    ]
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1', { includeDeleted: true, ensureStatus: false })
    expect(result).toHaveLength(2)
  })

  test('includeCancelled=false 过滤 cancelled 保单', async () => {
    const policies = [
      makePolicy({ _id: 'p1', status: 'active' }),
      makePolicy({ _id: 'p2', status: 'cancelled' }),
      makePolicy({ _id: 'p3', status: 'deleted' })
    ]
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1', { includeCancelled: false, ensureStatus: false })
    expect(result).toHaveLength(1)
    expect(result[0]._id).toBe('p1')
  })

  test('默认 includeCancelled=true 保留 cancelled 保单', async () => {
    const policies = [
      makePolicy({ _id: 'p1', status: 'active' }),
      makePolicy({ _id: 'p2', status: 'cancelled' })
    ]
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1', { ensureStatus: false })
    expect(result).toHaveLength(2)
  })

  test('空数据库返回空数组', async () => {
    const { db } = makeMockDb([])
    const result = await loadActivePolicies(db, 'fam1', 'op1')
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. ensureStatus 推算状态
// ---------------------------------------------------------------------------

describe('loadActivePolicies — ensureStatus 推算', () => {
  test('默认调用 ensureStatusBatch，无 status 字段时推算', async () => {
    const policies = [
      makePolicy({ _id: 'p1', status: undefined, insurance_period: '终身' })
    ]
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1')
    expect(result[0].status).toBe('active')
    expect(result[0]._expiryInfo).toBeDefined()
  })

  test('ensureStatus=false 不推算状态', async () => {
    const policies = [
      makePolicy({ _id: 'p1', status: undefined, insurance_period: '终身' })
    ]
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1', { ensureStatus: false })
    expect(result[0].status).toBeUndefined()
    expect(result[0]._expiryInfo).toBeUndefined()
  })

  test('已有终态 status 不被覆盖', async () => {
    const policies = [
      makePolicy({ _id: 'p1', status: 'expired', insurance_period: '1年', effective_date: '2010-01-01' })
    ]
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1')
    expect(result[0].status).toBe('expired')
  })

  test('status=unknown 会被重新推算', async () => {
    const policies = [
      makePolicy({ _id: 'p1', status: 'unknown', insurance_period: '终身', insured_age: 30 })
    ]
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1')
    expect(result[0].status).not.toBe('unknown')
    expect(['active', 'expired', 'suspicious']).toContain(result[0].status)
  })

  test('保额=0 但保费>0 推算为 suspicious', async () => {
    const policies = [
      makePolicy({ _id: 'p1', status: undefined, sum_assured: 0, annual_premium: 5000, insurance_period: '终身' })
    ]
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1')
    expect(result[0].status).toBe('suspicious')
  })
})

// ---------------------------------------------------------------------------
// 4. limit 选项
// ---------------------------------------------------------------------------

describe('loadActivePolicies — limit 选项', () => {
  test('默认 limit=100', async () => {
    const policies = Array.from({ length: 150 }, (_, i) => makePolicy({ _id: 'p' + i, id: 'pol' + i }))
    const { db, calls } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1', { ensureStatus: false })
    expect(result).toHaveLength(100)
  })

  test('自定义 limit', async () => {
    const policies = Array.from({ length: 60 }, (_, i) => makePolicy({ _id: 'p' + i, id: 'pol' + i }))
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1', { limit: 50, ensureStatus: false })
    expect(result).toHaveLength(50)
  })
})

// ---------------------------------------------------------------------------
// 5. 错误容错
// ---------------------------------------------------------------------------

describe('loadActivePolicies — 错误容错', () => {
  test('safeQuery 抛错时返回空数组（不传播异常）', async () => {
    const db = {
      collection: () => {
        throw new Error('DB connection failed')
      }
    }
    const result = await loadActivePolicies(db, 'fam1', 'op1')
    expect(result).toEqual([])
  })

  test('where 链抛错时返回空数组', async () => {
    const db = {
      collection: () => ({
        where: () => {
          throw new Error('where construction failed')
        }
      })
    }
    const result = await loadActivePolicies(db, 'fam1', 'op1')
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 6. 组合场景
// ---------------------------------------------------------------------------

describe('loadActivePolicies — 组合场景', () => {
  test('同时过滤 deleted + cancelled + 推算状态', async () => {
    const policies = [
      makePolicy({ _id: 'p1', status: 'active', insurance_period: '终身' }),
      makePolicy({ _id: 'p2', status: 'deleted' }),
      makePolicy({ _id: 'p3', status: 'cancelled' }),
      makePolicy({ _id: 'p4', status: undefined, insurance_period: '终身' }),
      makePolicy({ _id: 'p5', status: undefined, sum_assured: 0, annual_premium: 5000 })
    ]
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1', { includeCancelled: false })
    // p2 deleted 过滤、p3 cancelled 过滤、p1 保留 active、p4 推算为 active、p5 推算为 suspicious
    expect(result.map(p => p._id).sort()).toEqual(['p1', 'p4', 'p5'])
    expect(result.find(p => p._id === 'p4').status).toBe('active')
    expect(result.find(p => p._id === 'p5').status).toBe('suspicious')
  })

  test('reportAI 场景：ensureStatus=false + limit=50（先注入 birthDate 再推算状态）', async () => {
    const policies = Array.from({ length: 60 }, (_, i) => makePolicy({ _id: 'p' + i, status: 'active' }))
    const { db } = makeMockDb(policies)
    const result = await loadActivePolicies(db, 'fam1', 'op1', { ensureStatus: false, limit: 50 })
    expect(result).toHaveLength(50)
    // ensureStatus=false，status 字段保持原值
    expect(result[0]._expiryInfo).toBeUndefined()
  })
})
