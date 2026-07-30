/**
 * deleteFamily handler — DB mock 测试
 */
var mockStore = { families: [], messages: [], facts: [], insights: [], policies: [], reports: [], operation_logs: [] }

jest.mock('wx-server-sdk', function() {
  var mockDb = {
    collection: jest.fn(function(name) {
      var rows = mockStore[name] || []
      var q = function() { return {
        where: jest.fn(function() { return q() }),
        field: jest.fn(function() { return q() }),
        limit: jest.fn(function() { return q() }),
        get: jest.fn(function() { return Promise.resolve({ data: rows }) }),
        update: jest.fn(function() { return Promise.resolve({ stats: { updated: 1 } }) }),
        remove: jest.fn(function() { rows.splice(0, rows.length); return Promise.resolve({ stats: { removed: rows.length } }) }),
        doc: jest.fn(function(id) { return {
          update: jest.fn(function() { return Promise.resolve({ stats: { updated: 1 } }) }),
          remove: jest.fn(function() { var i = rows.findIndex(function(r){return r._id===id}); if(i!==-1) rows.splice(i,1); return Promise.resolve({ stats: { removed: 1 } }) })
        }})
      }}
      return q()
    }),
    command: { neq: function(v) { return { $ne: v } }, push: function(v) { return { $push: v } } }
  }
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockDb }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid' } })
  }
})

var dataWrite = require('../cloudfunctions/dataWrite/index')

describe('deleteFamily (mock DB)', function() {
  beforeEach(function() {
    mockStore = { families: [], messages: [], facts: [], insights: [], policies: [], reports: [], operation_logs: [] }
  })

  test('缺少 familyId 返回 400', function() {
    return dataWrite.main({ action: 'deleteFamily' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('家庭不存在返回 404', function() {
    return dataWrite.main({ action: 'deleteFamily', familyId: 'f1' }).then(function(res) {
      expect(res.code).toBe(404)
    })
  })

  test('删除成功返回 200', function() {
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', family_name: '测试', status: 'active' })
    return dataWrite.main({ action: 'deleteFamily', familyId: 'f1' }).then(function(res) {
      expect(res.code).toBe(200)
    })
  })
})
