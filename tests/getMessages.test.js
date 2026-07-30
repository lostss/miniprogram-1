/**
 * queryMessages 云函数单元测试
 * 测试：参数校验、分页查询、mode=latest、before 分页
 * （原 getMessages 已重命名为 queryMessages；生产链式调用 where(...).orderBy(...).limit(...).get()）
 */

var mockMessages = []

jest.mock('wx-server-sdk', function() {
  // 链式 mock：where → orderBy → limit → get；where 也直接接 get（无 orderBy 路径）
  var buildChain = function() {
    var chain = {
      get: jest.fn(function() { return Promise.resolve({ data: mockMessages.slice() }) })
    }
    chain.limit = jest.fn(function() { return chain })
    chain.orderBy = jest.fn(function() { return chain })
    chain.where = jest.fn(function() { return chain })
    chain.field = jest.fn(function() { return chain })
    return chain
  }
  var mockDb = {
    collection: jest.fn(function() { return buildChain() }),
    command: { lt: jest.fn(function(v) { return { $lt: v } }) }
  }
  return {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockDb }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid', APPID: 'mock_appid' } })
  }
})

var dataQuery = require('../cloudfunctions/dataQuery/index')

describe('queryMessages (via dataQuery) 云函数', function() {

  beforeEach(function() {
    mockMessages = []
  })

  test('缺少 familyId 返回 400', function() {
    return dataQuery.main({ action: 'queryMessages' }).then(function(res) {
      expect(res.code).toBe(400)
      expect(res.msg).toContain('familyId')
    })
  })

  test('mode=latest 获取最近消息', function() {
    mockMessages = [
      { role: 'user', content: '你好', timestamp: 1 },
      { role: 'assistant', content: '你好，有什么可以帮您', timestamp: 2 }
    ]
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001', mode: 'latest', limit: 5 }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.messages.length).toBe(2)
    })
  })

  test('before 分页获取', function() {
    mockMessages = [
      { role: 'assistant', content: '之前消息', timestamp: 100 }
    ]
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001', before: '2026-05-01T00:00:00Z', limit: 10 }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.messages.length).toBe(1)
    })
  })

  test('全量获取（无 mode 和 before）', function() {
    mockMessages = [
      { role: 'user', content: 'm1', timestamp: 1 },
      { role: 'assistant', content: 'm2', timestamp: 2 }
    ]
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.messages.length).toBe(2)
    })
  })

  test('空结果返回空数组', function() {
    mockMessages = []
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.messages).toEqual([])
    })
  })
})
