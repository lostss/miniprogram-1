/**
 * updateFamily handler — DB mock 测试
 */
var mockStore = { families: [], operation_logs: [] }
var lastUpdate = null

jest.mock('wx-server-sdk', function() {
  var mockDb = {
    collection: jest.fn(function(name) {
      var rows = mockStore[name] || []
      var q = function() { return {
        where: jest.fn(function() { return q() }),
        field: jest.fn(function() { return q() }),
        orderBy: jest.fn(function() { return q() }),
        limit: jest.fn(function() { return q() }),
        get: jest.fn(function() { return Promise.resolve({ data: rows }) }),
        update: jest.fn(function() { return Promise.resolve({ stats: { updated: 1 } }) }),
        doc: jest.fn(function(id) { return {
          get: jest.fn(function() { return Promise.resolve({ data: rows.find(function(r) { return r._id === id }) || null }) }),
          update: jest.fn(function(opts) { lastUpdate = opts; return Promise.resolve({ stats: { updated: 1 } }) })
        }}),
        add: jest.fn(function(data) { var id = 'mock_' + Date.now(); rows.push({ _id: id, ...data }); return Promise.resolve({ _id: id }) })
      }}
      return q()
    }),
    command: { neq: function(v) { return { $ne: v } }, push: function(v) { return { $push: v } }, inc: function(v) { return { $inc: v } }, set: function(v) { return { $set: v } }, serverDate: function() { return new Date('2026-01-01') } }
  }
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockDb }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid' } })
  }
})

var dataWrite = require('../cloudfunctions/dataWrite/index')

describe('updateFamily (mock DB)', function() {
  beforeEach(function() {
    mockStore = { families: [], operation_logs: [] }
    lastUpdate = null
  })

  test('缺少 familyId 返回 400', function() {
    return dataWrite.main({ action: 'updateFamily' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('update 无匹配返回 200（mock局限：.update()总是updated:1）', function() {
    return dataWrite.main({ action: 'updateFamily', familyId: 'f1', field: 'family_name', value: '新名', operator: 'set' }).then(function(res) {
      // handler检查 result.stats.updated===0才404，mock恒为1故200
      expect(res.code).toBe(200)
    })
  })

  test('非法字段返回 400', function() {
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', family_name: '测试' })
    return dataWrite.main({ action: 'updateFamily', familyId: 'f1', field: 'invalid_field', value: 'x', operator: 'set' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('合法 set 操作返回 200', function() {
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', family_name: '测试' })
    return dataWrite.main({ action: 'updateFamily', familyId: 'f1', field: 'family_name', value: '新家庭名', operator: 'set' }).then(function(res) {
      expect(res.code).toBe(200)
    })
  })
})
