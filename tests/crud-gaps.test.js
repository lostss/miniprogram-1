/**
 * CRUD 缺口补全单元测试
 * 覆盖 dataWrite 新增的 deleteMember / updatePolicy / deleteFact
 */
jest.mock('wx-server-sdk', function() {
  return {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    // H2 审计：补齐 database().command（fact-write 的 `_` 依赖它构造 neq 排除）
    // 缺 command 时 `_`=undefined，addFact versioned 的 _id 排除守卫短路 → 刚写入的 fact 被自身 supersede 作废
    database: jest.fn(function() { return { command: { neq: v => ({ __neq: v }), in: v => ({ __in: v }) }, collection: jest.fn() } }),
    getWXContext: jest.fn(function() { return { OPENID: 'o1' } }),
    callFunction: jest.fn(function() { return Promise.resolve({ result: { code: 200 } }) })
  }
})

const handlers = require('../cloudfunctions/dataWrite/handlers')

function makeDb(seed = {}) {
  const store = {}
  for (const k in seed) store[k] = seed[k].map((m, i) => ({ ...m, _id: m._id || 'id_' + k + '_' + i }))
  const command = { neq: v => ({ __neq: v }), in: v => ({ __in: v }) }
  function matchRow(r, f) {
    return Object.entries(f).every(([k, v]) => {
      if (v && typeof v === 'object' && '__neq' in v) return r[k] !== v.__neq
      if (v && typeof v === 'object' && '__in' in v) return v.__in.includes(r[k])
      return r[k] === v
    })
  }
  return {
    command,
    collection(name) {
      const coll = store[name] || (store[name] = [])
      return {
        where(filter) {
          const f = { ...filter }; delete f._openid
          const rows = coll.filter(r => matchRow(r, f))
          return {
            get: async () => ({ data: rows }),
            limit(n) { return { get: async () => ({ data: rows.slice(0, n) }) } },
            orderBy() { return this },
            count: async () => ({ total: rows.length }),
            update: async ({ data }) => { for (const r of rows) Object.assign(r, data); return { stats: { updated: rows.length } } },
            remove: async () => { for (const r of rows) { const i = coll.indexOf(r); if (i >= 0) coll.splice(i, 1) } return { stats: { removed: rows.length } } }
          }
        },
        doc(id) {
          return {
            update: async ({ data }) => { const r = coll.find(x => x._id === id); if (r) Object.assign(r, data); return { stats: { updated: r ? 1 : 0 } } },
            remove: async () => { const i = coll.findIndex(x => x._id === id); if (i >= 0) coll.splice(i, 1); return { stats: { removed: 1 } } }
          }
        },
        add: async ({ data }) => { const doc = { ...data, _id: 'new_' + Math.random().toString(36).slice(2) }; coll.push(doc); return { _id: doc._id } }
      }
    }
  }
}

const FAM = 'fam1'
const OID = 'o1'

describe('deleteMember', function() {
  test('按姓名删除成员并级联软删其事实', async function() {
    const db = makeDb({
      members: [{ family_id: FAM, member_id: 'mem_1', name: '张三', role: '本人' }],
      facts: [{ family_id: FAM, subject_type: 'member', subject_id: 'mem_1', predicate: '职业', object_value: '教师', status: 'active' }]
    })
    const r = await handlers.deleteMember(db, OID, { familyId: FAM, memberName: '张三' })
    expect(r.code).toBe(200)
    expect(r.data.memberId).toBe('mem_1')
    const remaining = await db.collection('members').where({ family_id: FAM }).get()
    expect(remaining.data.length).toBe(0)
    const facts = await db.collection('facts').where({ family_id: FAM, subject_id: 'mem_1' }).get()
    expect(facts.data[0].status).toBe('superseded')
  })

  test('成员不存在返回 404', async function() {
    const db = makeDb({ members: [] })
    const r = await handlers.deleteMember(db, OID, { familyId: FAM, memberName: '无名' })
    expect(r.code).toBe(404)
  })

  test('缺少标识返回 400', async function() {
    const db = makeDb({})
    const r = await handlers.deleteMember(db, OID, { familyId: FAM })
    expect(r.code).toBe(400)
  })
})

describe('updatePolicy', function() {
  test('按产品名+被保人修改保额并同步保障事实', async function() {
    const db = makeDb({
      policies: [{ family_id: FAM, id: 'pol_1', product_name: 'X寿', insured_name: '张三', sum_assured: 1000000, annual_premium: 5000, status: 'active' }],
      facts: [{ family_id: FAM, subject_type: 'policy', subject_id: 'pol_1', predicate: '保额', object_value: '100万', status: 'active' }]
    })
    const r = await handlers.updatePolicy(db, OID, { familyId: FAM, product_name: 'X寿', insured_name: '张三', data: { sum_assured: 2000000 } })
    expect(r.code).toBe(200)
    const pol = (await db.collection('policies').where({ id: 'pol_1' }).get()).data[0]
    expect(pol.sum_assured).toBe(2000000)
    // policyToFacts 生成 policy→literal 类型的保额事实
    const lit = await db.collection('facts').where({ subject_type: 'policy', subject_id: 'pol_1', predicate: '保额', status: 'active' }).get()
    expect(lit.data.length).toBe(1)
    expect(lit.data[0].object_value).toBe('200万')
    expect(lit.data[0].source).toBe('agent_edit')
  })

  test('缺少 data 返回 400', async function() {
    const db = makeDb({})
    const r = await handlers.updatePolicy(db, OID, { familyId: FAM, product_name: 'X' })
    expect(r.code).toBe(400)
  })

  test('未找到保单返回 404', async function() {
    const db = makeDb({ policies: [] })
    const r = await handlers.updatePolicy(db, OID, { familyId: FAM, product_name: '不存在', data: { sum_assured: 1 } })
    expect(r.code).toBe(404)
  })
})

describe('deleteFact', function() {
  test('软删事实 status→superseded', async function() {
    const db = makeDb({ facts: [{ family_id: FAM, _id: 'fact_1', predicate: '备注', status: 'active' }] })
    const r = await handlers.deleteFact(db, OID, { familyId: FAM, factId: 'fact_1' })
    expect(r.code).toBe(200)
    const f = (await db.collection('facts').where({ _id: 'fact_1' }).get()).data[0]
    expect(f.status).toBe('superseded')
  })

  test('事实不存在返回 404', async function() {
    const db = makeDb({ facts: [] })
    const r = await handlers.deleteFact(db, OID, { familyId: FAM, factId: 'fact_x' })
    expect(r.code).toBe(404)
  })
})
