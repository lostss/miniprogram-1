/**
 * policy-locate 单元测试
 *
 * 测试 cloudfunctions/dataWrite/policy-locate.js 的三级定位接缝。
 * 覆盖：
 *   - 优先级 1: policyId 精确定位
 *   - 优先级 2: policy_number 定位
 *   - 优先级 3: product_name + insured_name 模糊定位
 *   - excludeDeleted 选项（deletePolicy vs updatePolicy 语义差异）
 *   - _openid 注入不变量
 *   - 找不到时返回 null
 */

const { locatePolicy } = require('../cloudfunctions/dataWrite/policy-locate')

// ---------------------------------------------------------------------------
// Mock DB 构造器
// ---------------------------------------------------------------------------

function makeMockDb(policies = []) {
  const calls = { queries: [] }
  const store = { policies: policies.map(x => ({ ...x })) }

  function matchWhere(rows, w) {
    return rows.filter(x => Object.keys(w).every(k => {
      // 简化 neq('deleted') 处理：如果值是 { $ne: 'deleted' } 形式（mock db.command.neq）
      // 实际 wx-server-sdk 的 db.command.neq 返回的对象有特定结构，这里用简单判断
      if (w[k] && typeof w[k] === 'object' && w[k].$ne !== undefined) {
        return x[k] !== w[k].$ne
      }
      return x[k] === w[k]
    }))
  }

  const db = {
    command: {
      neq: (val) => ({ $ne: val })
    },
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

function makePolicy(overrides = {}) {
  return Object.assign({
    _id: 'p_' + Math.random().toString(36).slice(2, 8),
    id: 'pol_' + Math.random().toString(36).slice(2, 8),
    family_id: 'fam1',
    _openid: 'op1',
    product_name: '平安福',
    insured_name: '张三',
    policy_number: 'P123456',
    status: 'active'
  }, overrides)
}

// ---------------------------------------------------------------------------
// 1. 优先级 1: policyId 精确定位
// ---------------------------------------------------------------------------

describe('locatePolicy — policyId 精确定位', () => {
  test('通过 policyId 找到保单', async () => {
    const p = makePolicy({ _id: 'p1', id: 'pol_abc' })
    const { db } = makeMockDb([p])
    const result = await locatePolicy(db, 'op1', 'fam1', { policyId: 'pol_abc' })
    expect(result).toBeTruthy()
    expect(result.id).toBe('pol_abc')
  })

  test('policyId 不匹配返回 null（无其他标识符回退）', async () => {
    const p = makePolicy({ _id: 'p1', id: 'pol_abc' })
    const { db } = makeMockDb([p])
    const result = await locatePolicy(db, 'op1', 'fam1', { policyId: 'pol_xyz' })
    expect(result).toBeNull()
  })

  test('policyId 匹配时不查询 policy_number', async () => {
    const p = makePolicy({ _id: 'p1', id: 'pol_abc', policy_number: 'P123' })
    const { db, calls } = makeMockDb([p])
    await locatePolicy(db, 'op1', 'fam1', { policyId: 'pol_abc', policy_number: 'P999' })
    // 只有一次查询（policyId 层级命中即返回）
    expect(calls.queries).toHaveLength(1)
    expect(calls.queries[0].where.id).toBe('pol_abc')
  })
})

// ---------------------------------------------------------------------------
// 2. 优先级 2: policy_number 定位
// ---------------------------------------------------------------------------

describe('locatePolicy — policy_number 定位', () => {
  test('policyId 未提供时通过 policy_number 定位', async () => {
    const p = makePolicy({ _id: 'p1', policy_number: 'P123' })
    const { db } = makeMockDb([p])
    const result = await locatePolicy(db, 'op1', 'fam1', { policy_number: 'P123' })
    expect(result).toBeTruthy()
    expect(result.policy_number).toBe('P123')
  })

  test('policyId 未命中时回退到 policy_number', async () => {
    const p = makePolicy({ _id: 'p1', id: 'pol_abc', policy_number: 'P123' })
    const { db, calls } = makeMockDb([p])
    const result = await locatePolicy(db, 'op1', 'fam1', { policyId: 'pol_xyz', policy_number: 'P123' })
    expect(result).toBeTruthy()
    expect(result.policy_number).toBe('P123')
    expect(calls.queries).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 3. 优先级 3: product_name + insured_name 模糊定位
// ---------------------------------------------------------------------------

describe('locatePolicy — product_name 模糊定位', () => {
  test('通过 product_name 定位', async () => {
    const p = makePolicy({ _id: 'p1', product_name: '平安福' })
    const { db } = makeMockDb([p])
    const result = await locatePolicy(db, 'op1', 'fam1', { product_name: '平安福' })
    expect(result).toBeTruthy()
    expect(result.product_name).toBe('平安福')
  })

  test('product_name + insured_name 联合过滤', async () => {
    const policies = [
      makePolicy({ _id: 'p1', product_name: '平安福', insured_name: '张三' }),
      makePolicy({ _id: 'p2', product_name: '平安福', insured_name: '李四' })
    ]
    const { db } = makeMockDb(policies)
    const result = await locatePolicy(db, 'op1', 'fam1', { product_name: '平安福', insured_name: '李四' })
    expect(result._id).toBe('p2')
  })

  test('product_name 不匹配 insured_name 时返回 null', async () => {
    const policies = [
      makePolicy({ _id: 'p1', product_name: '平安福', insured_name: '张三' })
    ]
    const { db } = makeMockDb(policies)
    const result = await locatePolicy(db, 'op1', 'fam1', { product_name: '平安福', insured_name: '不存在' })
    expect(result).toBeNull()
  })

  test('product_name 多个匹配时优先选非 deleted 的（excludeDeleted=false）', async () => {
    const policies = [
      makePolicy({ _id: 'p1', product_name: '平安福', status: 'deleted' }),
      makePolicy({ _id: 'p2', product_name: '平安福', status: 'active' })
    ]
    const { db } = makeMockDb(policies)
    const result = await locatePolicy(db, 'op1', 'fam1', { product_name: '平安福', excludeDeleted: false })
    expect(result._id).toBe('p2')
  })

  test('product_name 全部 deleted 时回退选第一个（excludeDeleted=false）', async () => {
    const policies = [
      makePolicy({ _id: 'p1', product_name: '平安福', status: 'deleted' }),
      makePolicy({ _id: 'p2', product_name: '平安福', status: 'deleted' })
    ]
    const { db } = makeMockDb(policies)
    const result = await locatePolicy(db, 'op1', 'fam1', { product_name: '平安福', excludeDeleted: false })
    expect(result).toBeTruthy()
    // 找不到非 deleted 的，回退到第一个
    expect(result._id).toBe('p1')
  })
})

// ---------------------------------------------------------------------------
// 4. excludeDeleted 选项（deletePolicy vs updatePolicy 语义差异）
// ---------------------------------------------------------------------------

describe('locatePolicy — excludeDeleted 选项', () => {
  test('excludeDeleted=false（默认）：允许定位已 deleted 的保单', async () => {
    const p = makePolicy({ _id: 'p1', id: 'pol_abc', status: 'deleted' })
    const { db } = makeMockDb([p])
    const result = await locatePolicy(db, 'op1', 'fam1', { policyId: 'pol_abc' })
    expect(result).toBeTruthy()
    expect(result.status).toBe('deleted')
  })

  test('excludeDeleted=true：policyId 层级过滤 deleted', async () => {
    const p = makePolicy({ _id: 'p1', id: 'pol_abc', status: 'deleted' })
    const { db } = makeMockDb([p])
    const result = await locatePolicy(db, 'op1', 'fam1', { policyId: 'pol_abc', excludeDeleted: true })
    expect(result).toBeNull()
  })

  test('excludeDeleted=true：policy_number 层级过滤 deleted', async () => {
    const p = makePolicy({ _id: 'p1', policy_number: 'P123', status: 'deleted' })
    const { db } = makeMockDb([p])
    const result = await locatePolicy(db, 'op1', 'fam1', { policy_number: 'P123', excludeDeleted: true })
    expect(result).toBeNull()
  })

  test('excludeDeleted=true：product_name 层级过滤 deleted', async () => {
    const policies = [
      makePolicy({ _id: 'p1', product_name: '平安福', status: 'deleted' }),
      makePolicy({ _id: 'p2', product_name: '平安福', status: 'active' })
    ]
    const { db } = makeMockDb(policies)
    const result = await locatePolicy(db, 'op1', 'fam1', { product_name: '平安福', excludeDeleted: true })
    expect(result._id).toBe('p2')
  })

  test('excludeDeleted=true：所有层级都过滤 deleted', async () => {
    const policies = [
      makePolicy({ _id: 'p1', id: 'pol_abc', policy_number: 'P123', product_name: '平安福', status: 'deleted' })
    ]
    const { db } = makeMockDb(policies)
    const result = await locatePolicy(db, 'op1', 'fam1', {
      policyId: 'pol_abc',
      policy_number: 'P123',
      product_name: '平安福',
      excludeDeleted: true
    })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. _openid 注入不变量
// ---------------------------------------------------------------------------

describe('locatePolicy — _openid 注入', () => {
  test('所有层级查询都注入 _openid', async () => {
    const p = makePolicy({ _id: 'p1', id: 'pol_abc', policy_number: 'P123', product_name: '平安福' })
    const { db, calls } = makeMockDb([p])
    // 三层级都会尝试（因 policyId 不匹配）
    await locatePolicy(db, 'op_user', 'fam1', {
      policyId: 'wrong',
      policy_number: 'wrong',
      product_name: '平安福'
    })
    expect(calls.queries.length).toBeGreaterThanOrEqual(1)
    for (const q of calls.queries) {
      expect(q.where._openid).toBe('op_user')
      expect(q.where.family_id).toBe('fam1')
    }
  })

  test('不同 openid 隔离数据', async () => {
    const policies = [
      makePolicy({ _id: 'p1', id: 'pol_abc', _openid: 'op1' }),
      makePolicy({ _id: 'p2', id: 'pol_abc', _openid: 'op2' })
    ]
    const { db } = makeMockDb(policies)
    const result = await locatePolicy(db, 'op2', 'fam1', { policyId: 'pol_abc' })
    expect(result._openid).toBe('op2')
  })
})

// ---------------------------------------------------------------------------
// 6. 找不到时返回 null
// ---------------------------------------------------------------------------

describe('locatePolicy — 找不到保单', () => {
  test('所有标识符都不提供时返回 null', async () => {
    const { db } = makeMockDb([makePolicy()])
    const result = await locatePolicy(db, 'op1', 'fam1', {})
    expect(result).toBeNull()
  })

  test('所有层级都未命中时返回 null', async () => {
    const p = makePolicy({ _id: 'p1', id: 'pol_abc', policy_number: 'P123', product_name: '平安福' })
    const { db } = makeMockDb([p])
    const result = await locatePolicy(db, 'op1', 'fam1', {
      policyId: 'wrong',
      policy_number: 'wrong',
      product_name: '不存在'
    })
    expect(result).toBeNull()
  })

  test('空数据库返回 null', async () => {
    const { db } = makeMockDb([])
    const result = await locatePolicy(db, 'op1', 'fam1', { policyId: 'pol_abc' })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 7. 组合场景
// ---------------------------------------------------------------------------

describe('locatePolicy — 组合场景', () => {
  test('deletePolicy 场景：excludeDeleted=false + 全部标识符', async () => {
    const policies = [
      makePolicy({ _id: 'p1', id: 'pol_abc', policy_number: 'P123', product_name: '平安福', status: 'deleted' })
    ]
    const { db } = makeMockDb(policies)
    const result = await locatePolicy(db, 'op1', 'fam1', {
      policyId: 'pol_abc',
      policy_number: 'P123',
      product_name: '平安福',
      excludeDeleted: false
    })
    // policyId 层级直接命中（即使 status=deleted）
    expect(result).toBeTruthy()
    expect(result.id).toBe('pol_abc')
  })

  test('updatePolicy 场景：excludeDeleted=true + 全部标识符', async () => {
    const policies = [
      makePolicy({ _id: 'p1', id: 'pol_abc', policy_number: 'P123', product_name: '平安福', status: 'deleted' }),
      makePolicy({ _id: 'p2', id: 'pol_def', policy_number: 'P456', product_name: '平安福', status: 'active' })
    ]
    const { db } = makeMockDb(policies)
    const result = await locatePolicy(db, 'op1', 'fam1', {
      policyId: 'pol_def',
      excludeDeleted: true
    })
    expect(result).toBeTruthy()
    expect(result.id).toBe('pol_def')
    expect(result.status).toBe('active')
  })
})
