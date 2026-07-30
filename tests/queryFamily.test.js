/**
 * getFamily handler — DB mock 集成测试
 * （原 queryFamily 已重命名为 getFamily，路由仍在 dataQuery）
 */
var mockStore = { families: [], members: [], finances: [], policies: [], reports: [] }

jest.mock('wx-server-sdk', function() {
  var mockDb = {
    collection: jest.fn(function(name) {
      var rows = mockStore[name] || []
      return {
        doc: jest.fn(function(id) { return {
          get: jest.fn(function() { return Promise.resolve({ data: rows.find(function(r) { return r._id === id }) || null }) }),
          update: jest.fn(function() { return Promise.resolve({ stats: { updated: 1 } }) })
        }}),
        where: jest.fn(function() { return {
          get: jest.fn(function() { return Promise.resolve({ data: rows.length > 0 ? [rows[0]] : [] }) }),
          field: jest.fn(function() { return {
            limit: jest.fn(function() { return {
              get: jest.fn(function() { return Promise.resolve({ data: rows.length > 0 ? [rows[0]] : [] }) })
            }})
          }}),
          limit: jest.fn(function() { return {
            get: jest.fn(function() { return Promise.resolve({ data: rows }) })
          }})
        }}),
        add: jest.fn(function(data) { var newId = 'mock_' + Date.now(); rows.push({ _id: newId, ...data }); return Promise.resolve({ _id: newId }) }),
        count: jest.fn(function() { return Promise.resolve({ total: rows.length }) })
      }
    }),
    command: { push: function(v) { return { $push: v } }, serverDate: function() { return new Date('2026-01-01') }, neq: function(v) { return { $ne: v } }, in: function(v) { return { $in: v } } }
  }
  return {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockDb }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid', APPID: 'mock_appid' } }),
    callFunction: jest.fn(function() { return Promise.resolve({ result: { code: 200 } }) })
  }
})

var dataQuery = require('../cloudfunctions/dataQuery/index')

describe('getFamily (mock DB)', function() {
  beforeEach(function() {
    mockStore = { families: [], members: [], finances: [], policies: [], reports: [] }
  })

  test('缺少 familyId 返回 400', function() {
    return dataQuery.main({ action: 'getFamily' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('家庭不存在返回 404', function() {
    return dataQuery.main({ action: 'getFamily', familyId: 'f1' }).then(function(res) {
      expect(res.code).toBe(404)
    })
  })

  test('成功获取返回 200', function() {
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', family_name: '测试家庭', members: [], completeness_score: 50 })
    return dataQuery.main({ action: 'getFamily', familyId: 'f1' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.family_name).toBe('测试家庭')
    })
  })
})
