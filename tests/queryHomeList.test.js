/**
 * listFamilies handler — DB mock 集成测试
 * （原 queryHomeList 已重命名为 listFamilies，agent 字段已不在 listFamilies 返回中）
 */
var mockStore = { families: [], members: [] }
var mockFailCollections = [] // 2026-09-11 全面审计 P1-1：按集合名注入查询失败

jest.mock('wx-server-sdk', function() {
  var mockDb = {
    collection: jest.fn(function(name) {
      var rows = mockStore[name] || []
      var makeQuery = function() { return {
        where: jest.fn(function() { return makeQuery() }),
        field: jest.fn(function() { return makeQuery() }),
        orderBy: jest.fn(function() { return makeQuery() }),
        limit: jest.fn(function() { return makeQuery() }),
        get: jest.fn(function() {
          if (mockFailCollections.indexOf(name) >= 0) {
            return Promise.reject(new Error(name + ' query failed'))
          }
          return Promise.resolve({ data: rows })
        })
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
    mockFailCollections = []
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

  // 2026-09-11 全面审计 P1-1（契约锁定）：
  // 主查询（families）失败必须传播——不能吞成空列表伪装"尚无客户"（客户列表审计 P1-1 既定设计）
  test('families 主查询失败 → 返回 500，不伪装空列表', function() {
    mockFailCollections = ['families']
    return dataQuery.main({ action: 'listFamilies' }).then(function(res) {
      expect(res.code).toBe(500)
      expect(res.data).toBeUndefined()
    })
  })

  // 2026-09-11 全面审计 P1-1（契约锁定）：
  // 成员查询失败保留容错降级（家庭列表仍可显示），但降级**必须可观测**——
  // 原实现完全静默，成员数静默变 0 而无任何日志（不掩盖失败原则）
  test('members 查询失败 → 降级返回列表（member_count 0）且输出错误日志', function() {
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', family_name: '张三家庭', has_portrait: false, completeness_score: 60, updated_at: new Date() })
    mockStore.members = [{ _id: 'm1', family_id: 'f1', _openid: 'mock_openid', name: '张三', role: '本人' }]
    mockFailCollections = ['members']
    var spy = jest.spyOn(console, 'error').mockImplementation(function() {})
    return dataQuery.main({ action: 'listFamilies' }).then(function(res) {
      expect(res.code).toBe(200) // 降级：列表仍可显示
      expect(res.data.family_count).toBe(1)
      expect(res.data.families[0].member_count).toBe(0)
      var logged = spy.mock.calls.some(function(c) { return String(c[0]).indexOf('成员批量查询失败') >= 0 })
      expect(logged).toBe(true) // 降级可观测
      spy.mockRestore()
    })
  })
})
