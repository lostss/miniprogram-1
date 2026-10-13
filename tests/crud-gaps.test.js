/**
 * CRUD 缺口补全单元测试
 * 覆盖 dataWrite 新增的 deleteMember / updatePolicy / deleteFact
 */
// 2026-09-15 架构审查候选 4：DB mock 收敛到 tests/helpers/memory-db（31 份手写 mock 的唯一实现）。
// 关键差异：adapter 的 where **真实过滤**（旧 mock 把 _openid 从条件里删掉再过滤其余字段），
// 因此 seed 记录必须像生产一样带 _openid —— 由下面 makeDb 统一补上。
jest.mock('wx-server-sdk', function() {
  // command 与 adapter 共用同一实现：handler 内部用 require('wx-server-sdk').database().command
  // 构造操作符（如 _.neq），两边实现不同会导致查询条件对不上。
  const { memoryCommand } = require('./helpers/memory-db')
  return {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    // H2 审计：补齐 database().command（fact-write 的 `_` 依赖它构造 neq 排除）
    // 缺 command 时 `_`=undefined，addFact versioned 的 _id 排除守卫短路 → 刚写入的 fact 被自身 supersede 作废
    database: jest.fn(function() { return { command: memoryCommand, collection: jest.fn() } }),
    getWXContext: jest.fn(function() { return { OPENID: 'o1' } }),
    callFunction: jest.fn(function() { return Promise.resolve({ result: { code: 200 } }) })
  }
})

const handlers = require('../cloudfunctions/dataWrite/handlers')
const { makeMemoryDb } = require('./helpers/memory-db')

const FAM = 'fam1'
const OID = 'o1'

/** seed 记录统一补 _openid（handler 内部查询按 _openid 过滤）与缺省 _id */
function makeDb(seed = {}) {
  const store = {}
  for (const k of Object.keys(seed)) {
    store[k] = seed[k].map((r, i) => Object.assign({ _openid: OID, _id: r._id || ('id_' + k + '_' + i) }, r))
  }
  return makeMemoryDb(store)
}

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

  // 2026-09-22：原先此处断言"删除成员时把 policies.member_id 置空"，该实现已**回退**
  // （对报告分歧是 no-op，且违反 docs/data-model-v2.md L101）。改为钉住**文档规则本身**：
  // member_id 是 join key（本身是索引，§6.2 的 where({member_id,status}) 范式依赖它），
  // 删除成员只清事实，不动保单归属 —— 防这条规则再次被静默漂移。
  test('删除成员：policies.member_id 保留原值（data-model-v2 L101）', async function() {
    const db = makeDb({
      members: [{ family_id: FAM, member_id: 'mem_1', name: '张三', role: '本人' }],
      policies: [
        { family_id: FAM, id: 'pol_1', insured_name: '张三', member_id: 'mem_1', sum_assured: 100000 },
        { family_id: FAM, id: 'pol_2', insured_name: '李四', member_id: 'mem_2', sum_assured: 200000 }
      ]
    })
    const r = await handlers.deleteMember(db, OID, { familyId: FAM, memberId: 'mem_1' })
    expect(r.code).toBe(200)
    const ps = await db.collection('policies').where({ family_id: FAM }).get()
    expect(ps.data.find(p => p.id === 'pol_1').member_id).toBe('mem_1') // 保留：历史归属不销毁
    expect(ps.data.find(p => p.id === 'pol_1').insured_name).toBe('张三') // 保单仍在
    expect(ps.data.find(p => p.id === 'pol_2').member_id).toBe('mem_2')   // 他人保单不受影响
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

  test('金额无法解析 → 兜底 0，不落 null（2026-09-17 审计 P1-4）', async function() {
    // _toYuanAmount 对无法解析的输入返回 NaN（其自身注释写明"由上层 isNaN ? 0 兜底"），
    // 而 updatePolicy 原先漏了兜底 → NaN 经序列化变 null 落库，报告侧出现 null 金额。
    const db = makeDb({
      policies: [{ family_id: FAM, id: 'pol_1', product_name: 'X寿', insured_name: '张三', sum_assured: 1000000, annual_premium: 5000, status: 'active' }]
    })
    const r = await handlers.updatePolicy(db, OID, {
      familyId: FAM, product_name: 'X寿', insured_name: '张三',
      data: { sum_assured: '三十万', annual_premium: 'abc' }
    })
    expect(r.code).toBe(200)
    const pol = (await db.collection('policies').where({ id: 'pol_1' }).get()).data[0]
    expect(pol.sum_assured).toBe(0)
    expect(pol.annual_premium).toBe(0)
  })

  test('金额带「万」字 → 归一为元（兜底不误伤合法路径）', async function() {
    const db = makeDb({
      policies: [{ family_id: FAM, id: 'pol_1', product_name: 'X寿', insured_name: '张三', sum_assured: 1000000, status: 'active' }]
    })
    await handlers.updatePolicy(db, OID, { familyId: FAM, product_name: 'X寿', insured_name: '张三', data: { sum_assured: '80万' } })
    const pol = (await db.collection('policies').where({ id: 'pol_1' }).get()).data[0]
    expect(pol.sum_assured).toBe(800000)
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
