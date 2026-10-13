/**
 * memory-db adapter 自测（2026-09-15 架构审查候选 4）
 *
 * 它是测试基础设施——自身必须有测试。否则"31 个测试改用共享 adapter"只是换了一种不可信。
 * 重点验证与手写 mock 的关键差异：**where 真实过滤**（旧 mock 多数是全表返回）。
 */
const { makeMemoryDb, memoryCommand } = require('./helpers/memory-db')

describe('memory-db adapter', () => {
  test('where 真实过滤（不是全表返回）', async () => {
    const store = { families: [{ _id: 'f1', _openid: 'o1' }, { _id: 'f2', _openid: 'o2' }] }
    const db = makeMemoryDb(store)
    const r = await db.collection('families').where({ _openid: 'o1' }).get()
    expect(r.data).toHaveLength(1)
    expect(r.data[0]._id).toBe('f1')
  })

  test('操作符：neq / in / exists', async () => {
    const store = { policies: [{ _id: 'p1', status: 'active' }, { _id: 'p2', status: 'deleted' }, { _id: 'p3' }] }
    const db = makeMemoryDb(store)
    const _ = memoryCommand
    // p1 status='active' 与 p3 无 status 都不等于 'deleted' → 两条命中
    expect((await db.collection('policies').where({ status: _.neq('deleted') }).get()).data).toHaveLength(2)
    expect((await db.collection('policies').where({ status: _.in(['active', 'deleted']) }).get()).data).toHaveLength(2)
    expect((await db.collection('policies').where({ status: _.exists(true) }).get()).data).toHaveLength(2)
  })

  test('add({data}) 落库为平铺记录（与真实 SDK 语义一致）', async () => {
    const store = { facts: [] }
    const db = makeMemoryDb(store)
    const res = await db.collection('facts').add({ data: { predicate: '职业', object_value: '工程师' } })
    expect(res._id).toBeTruthy()
    expect(store.facts[0].predicate).toBe('职业')
    expect(store.facts[0].data).toBeUndefined()
  })

  test('update 的 $inc（配额累加场景）', async () => {
    const store = { agents: [{ _id: 'a1', openid: 'o1', token_used_monthly: 10 }] }
    const db = makeMemoryDb(store)
    const res = await db.collection('agents').where({ openid: 'o1' }).update({ data: { token_used_monthly: memoryCommand.inc(5) } })
    expect(res.stats.updated).toBe(1)
    expect(store.agents[0].token_used_monthly).toBe(15)
  })

  test('orderBy + limit', async () => {
    const store = { messages: [{ _id: 'm1', ts: 1 }, { _id: 'm2', ts: 3 }, { _id: 'm3', ts: 2 }] }
    const db = makeMemoryDb(store)
    const r = await db.collection('messages').orderBy('ts', 'desc').limit(2).get()
    expect(r.data.map(x => x._id)).toEqual(['m2', 'm3'])
  })

  test('doc().update / remove', async () => {
    const store = { families: [{ _id: 'f1', name: '旧' }] }
    const db = makeMemoryDb(store)
    await db.collection('families').doc('f1').update({ data: { name: '新' } })
    expect(store.families[0].name).toBe('新')
    await db.collection('families').doc('f1').remove()
    expect(store.families).toHaveLength(0)
  })

  test('count 尊重 where', async () => {
    const store = { facts: [{ _id: 'a', status: 'active' }, { _id: 'b', status: 'superseded' }] }
    const db = makeMemoryDb(store)
    expect((await db.collection('facts').where({ status: 'active' }).count()).total).toBe(1)
  })

  test('remove 只删命中的记录（where 生效）', async () => {
    const store = { facts: [{ _id: 'a', status: 'active' }, { _id: 'b', status: 'superseded' }] }
    const db = makeMemoryDb(store)
    const res = await db.collection('facts').where({ status: 'superseded' }).remove()
    expect(res.stats.removed).toBe(1)
    expect(store.facts.map(f => f._id)).toEqual(['a'])
  })
})
