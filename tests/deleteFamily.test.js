/**
 * deleteFamily handler — DB mock 测试
 */
var mockStore = { families: [], messages: [], facts: [], insights: [], policies: [], reports: [], operation_logs: [] }

// DB mock 收敛到 tests/helpers/memory-db（2026-09-15 架构审查候选 4）。
// 旧实现 where 为空实现（恒返回全表）；adapter 真实过滤（neq/push 等操作符同样支持）。
jest.mock('wx-server-sdk', function() {
  const { makeMemoryDb } = require('./helpers/memory-db')
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return makeMemoryDb(mockStore) }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid' } })
  }
})
const { makeMemoryDb } = require('./helpers/memory-db')

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
