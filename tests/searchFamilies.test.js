/**
 * searchFamilies — 家庭名 + 成员名双路搜索（搜索审计 #7 产品决策）
 * 直接测领域模块（注入可过滤 mock db），验证：
 *  - 家庭名模糊命中
 *  - 成员名命中返回其所属家庭（补查 family_id）
 *  - 双路命中去重
 *  - 软删成员（status=deleted）不参与匹配
 *  - 空 keyword 走 listFamilies
 *  - 正则转义不崩溃 / DB 异常返回 500
 */

// 过滤 mock 收敛到 tests/helpers/memory-db（2026-09-15 架构审查候选 4）。
// adapter 覆盖原手写能力：等值 / $in / $gt / db.RegExp 正则 / orderBy desc / limit；
// 查询记录由 spy 提供（记录字段名为 where，原手写版为 cond）。
function makeDb(presets) {
  const queries = []
  const store = {}
  Object.keys(presets || {}).forEach(function (k) {
    store[k] = presets[k].map(function (r) { return Object.assign({}, r) })
  })
  return { db: makeMemoryDb(store, { spy: { queries: queries } }), queries: queries }
}

const { searchFamilies } = require('../cloudfunctions/dataQuery/family-list')
const { makeMemoryDb } = require('./helpers/memory-db')

const t0 = new Date('2026-01-01T00:00:00Z')
const f1 = { _id: 'f1', _openid: 'mock_openid', family_name: '张三家庭', updated_at: t0 }
const f2 = { _id: 'f2', _openid: 'mock_openid', family_name: '李四家庭', updated_at: new Date('2026-01-02T00:00:00Z') }

describe('searchFamilies（家庭名 + 成员名双路）', function () {
  test('家庭名模糊命中', function () {
    const { db } = makeDb({
      families: [f1, f2],
      members: [
        { _id: 'm1', family_id: 'f1', _openid: 'mock_openid', name: '张三', role: '本人' },
        { _id: 'm2', family_id: 'f2', _openid: 'mock_openid', name: '李四', role: '配偶' }
      ]
    })
    return searchFamilies(db, 'mock_openid', { keyword: '张三' }).then(function (res) {
      expect(res.code).toBe(200)
      expect(res.data.family_count).toBe(1)
      expect(res.data.families[0]._id).toBe('f1')
      expect(res.data.families[0].pillar_name).toBe('张三')
      expect(res.data.families[0].member_count).toBe(1)
    })
  })

  test('成员名命中返回其所属家庭（家庭名无匹配）', function () {
    const { db, queries } = makeDb({
      families: [f1, f2],
      members: [{ _id: 'm3', family_id: 'f2', _openid: 'mock_openid', name: '王五', role: '子女' }]
    })
    return searchFamilies(db, 'mock_openid', { keyword: '王五' }).then(function (res) {
      expect(res.code).toBe(200)
      expect(res.data.family_count).toBe(1)
      expect(res.data.families[0]._id).toBe('f2')
      // 补查：members 命中后对家庭名未命中的 family_id 发起 families 查询
      const extraQuery = queries.some(function (q) {
        return q.name === 'families' && q.where && q.where._id && q.where._id.$in && q.where._id.$in.indexOf('f2') !== -1
      })
      expect(extraQuery).toBe(true)
    })
  })

  test('家庭名与成员名双路命中同一家庭只返回一次', function () {
    const { db } = makeDb({
      families: [f1],
      members: [{ _id: 'm1', family_id: 'f1', _openid: 'mock_openid', name: '张三', role: '本人' }]
    })
    return searchFamilies(db, 'mock_openid', { keyword: '张三' }).then(function (res) {
      expect(res.code).toBe(200)
      expect(res.data.family_count).toBe(1)
      expect(res.data.families.map(function (x) { return x._id })).toEqual(['f1'])
    })
  })

  test('软删成员不参与匹配', function () {
    const { db } = makeDb({
      families: [f2],
      members: [{ _id: 'm3', family_id: 'f2', _openid: 'mock_openid', name: '王五', role: '子女', status: 'deleted' }]
    })
    return searchFamilies(db, 'mock_openid', { keyword: '王五' }).then(function (res) {
      expect(res.code).toBe(200)
      expect(res.data.family_count).toBe(0)
      expect(res.data.families).toEqual([])
    })
  })

  test('空 keyword 走 listFamilies 返回全量', function () {
    const { db } = makeDb({ families: [f1, f2], members: [] })
    return searchFamilies(db, 'mock_openid', { keyword: '' }).then(function (res) {
      expect(res.code).toBe(200)
      expect(res.data.family_count).toBe(2)
    })
  })

  test('关键词含正则特殊字符不崩溃', function () {
    const { db } = makeDb({ families: [f1, f2], members: [] })
    return searchFamilies(db, 'mock_openid', { keyword: '张(三' }).then(function (res) {
      expect(res.code).toBe(200)
      expect(res.data.family_count).toBe(0)
    })
  })

  test('DB 异常返回 500 而非伪装空结果', function () {
    const throwDb = {
      command: {},
      RegExp: function (o) { return o },
      collection: function () { throw new Error('db down') }
    }
    return searchFamilies(throwDb, 'mock_openid', { keyword: '张三' }).then(function (res) {
      expect(res.code).toBe(500)
      expect(res.msg).toContain('搜索失败')
    })
  })
})
