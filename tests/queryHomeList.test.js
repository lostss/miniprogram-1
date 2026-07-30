/**
 * listFamilies handler — DB mock 集成测试
 * （原 queryHomeList 已重命名为 listFamilies，agent 字段已不在 listFamilies 返回中）
 */
var mockStore = { families: [], members: [] }

jest.mock('wx-server-sdk', function() {
  var mockDb = {
    collection: jest.fn(function(name) {
      var rows = mockStore[name] || []
      var makeQuery = function() { return {
        where: jest.fn(function() { return makeQuery() }),
        field: jest.fn(function() { return makeQuery() }),
        orderBy: jest.fn(function() { return makeQuery() }),
        limit: jest.fn(function() { return makeQuery() }),
        get: jest.fn(function() { return Promise.resolve({ data: rows }) })
      }}
      return makeQuery()
    }),
    command: { neq: function(v) { return { $ne: v } }, gte: function(v) { return { $gte: v } }, lt: function(v) { return { $lt: v } }, in: function(v) { return { $in: v } } }
  }
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockDb }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid', APPID: 'mock_appid' } })
  }
})

var dataQuery = require('../cloudfunctions/dataQuery/index')

describe('listFamilies (mock DB)', function() {
  beforeEach(function() {
    mockStore = { families: [], members: [] }
  })

  test('空列表返回 200', function() {
    return dataQuery.main({ action: 'listFamilies' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.families).toEqual([])
      expect(res.data.family_count).toBe(0)
    })
  })

  test('返回家庭列表含 member_count', function() {
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', family_name: '张三家庭', has_portrait: false, completeness_score: 60, updated_at: new Date() })
    mockStore.members = [
      { _id: 'm1', family_id: 'f1', _openid: 'mock_openid', name: '张三', role: '本人' },
      { _id: 'm2', family_id: 'f1', _openid: 'mock_openid', name: '李四', role: '配偶' }
    ]
    return dataQuery.main({ action: 'listFamilies' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.family_count).toBe(1)
      expect(res.data.families[0].family_name).toBe('张三家庭')
      expect(res.data.families[0].member_count).toBe(2)
      expect(res.data.families[0].pillar_name).toBe('张三')
    })
  })
})
