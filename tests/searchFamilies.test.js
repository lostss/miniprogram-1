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

// 简化过滤 mock：支持等值 + $in + RegExp({regexp, options})，orderBy desc + limit
function matches(row, cond) {
  if (!cond) return true
  return Object.keys(cond).every(function (k) {
    const c = cond[k]
    if (c && typeof c === 'object' && !(c instanceof Date)) {
      if (c.$in) return (c.$in || []).includes(row[k])
      if (c.regexp) return new RegExp(c.regexp, c.options || 'i').test(String(row[k] || ''))
      return true // 未知操作符：不拦截（保持 mock 宽松）
    }
    return row[k] === c
  })
}

function makeDb(presets) {
  const queries = []
  const db = {
    command: { in: function (v) { return { $in: v } }, gt: function (v) { return { $gt: v } } },
    RegExp: function (o) { return o },
    collection: function (name) {
      const base = presets[name] || []
      const state = { _where: null, _sort: null, _limit: null }
      return {
        where: function (cond) { state._where = cond; queries.push({ name: name, cond: cond }); return this },
        orderBy: function (field, dir) { state._sort = { field: field, dir: dir }; return this },
        limit: function (n) { state._limit = n; return this },
        get: function () {
          let rows = base.filter(function (r) { return matches(r, state._where) })
          if (state._sort && state._sort.dir === 'desc') {
            rows = rows.slice().sort(function (a, b) { return (new Date(b[state._sort.field]) - new Date(a[state._sort.field])) })
          }
          return Promise.resolve({ data: state._limit ? rows.slice(0, state._limit) : rows })
        }
      }
    }
  }
  return { db: db, queries: queries }
}

const { searchFamilies } = require('../cloudfunctions/dataQuery/family-list')

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
        return q.name === 'families' && q.cond._id && q.cond._id.$in && q.cond._id.$in.indexOf('f2') !== -1
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
