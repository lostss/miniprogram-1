/**
 * getFamily handler — DB mock 集成测试
 * （原 queryFamily 已重命名为 getFamily，路由仍在 dataQuery）
 */
var mockStore = { families: [], members: [], finances: [], policies: [], reports: [] }

// DB mock 收敛到 tests/helpers/memory-db（2026-09-15 架构审查候选 4）。
// 旧 where 是空实现（且只取 rows[0]）；adapter 真实过滤。
jest.mock('wx-server-sdk', function() {
  const { makeMemoryDb } = require('./helpers/memory-db')
  return {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return makeMemoryDb(mockStore) }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid', APPID: 'mock_appid' } }),
    callFunction: jest.fn(function() { return Promise.resolve({ result: { code: 200 } }) })
  }
})
const { makeMemoryDb } = require('./helpers/memory-db')

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
