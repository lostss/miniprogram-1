/**
 * setStage handler — DB mock 测试
 */
var mockStore = { families: [] }

jest.mock('wx-server-sdk', function() {
  var mockDb = {
    collection: jest.fn(function(name) {
      var rows = mockStore[name] || []
      var q = function() { return {
        where: jest.fn(function() { return q() }),
        get: jest.fn(function() { return Promise.resolve({ data: rows }) }),
        update: jest.fn(function() { return Promise.resolve({ stats: { updated: 1 } }) })
      }}
      return q()
    }),
    command: {}
  }
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockDb }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid' } })
  }
})

var dataWrite = require('../cloudfunctions/dataWrite/index')

describe('setStage (mock DB)', function() {
  test('缺少 familyId 返回 400', function() {
    return dataWrite.main({ action: 'setStage' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('非法 stage 返回 400', function() {
    return dataWrite.main({ action: 'setStage', familyId: 'f1', stage: 'invalid' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('合法 stage 返回 200', function() {
    return dataWrite.main({ action: 'setStage', familyId: 'f1', stage: 'profiling' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.stage).toBe('profiling')
    })
  })
})
