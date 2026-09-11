/**
 * queryMemberProfile handler — DB mock 测试
 *
 * 2026-09-11 全面审计 P1-1：该 handler 的 policies 查询原带 `.catch(() => ({ data: [] }))`，
 * 查询失败被**完全静默**地吞成"该成员无保单"（同批 facts 走的 safeQueryAll 虽也降级，但会打日志）。
 * 保单是该工具回答的核心数据，降级成空会让 AI 断言"该成员没有保障"→ 故修复为"失败即抛"。
 *
 * 两条路径的契约差异在此锁定：
 *   - policies 失败 → 500（抛错，不降级）
 *   - facts  失败 → 200 + 降级为空 + 有日志（safeQueryAll 既定语义，可观测降级）
 */
var mockStore = { members: [], facts: [], policies: [] }
var mockFailCollections = []

jest.mock('wx-server-sdk', function() {
  var mockDb = {
    collection: jest.fn(function(name) {
      var rows = mockStore[name] || []
      var makeQuery = function() { return {
        where: jest.fn(function() { return makeQuery() }),
        field: jest.fn(function() { return makeQuery() }),
        orderBy: jest.fn(function() { return makeQuery() }),
        skip: jest.fn(function() { return makeQuery() }),
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
    command: {
      neq: function(v) { return { $ne: v } },
      gte: function(v) { return { $gte: v } },
      lt: function(v) { return { $lt: v } },
      in: function(v) { return { $in: v } }
    }
  }
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockDb }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid', APPID: 'mock_appid' } })
  }
})

var dataQuery = require('../cloudfunctions/dataQuery/index')

describe('queryMemberProfile (mock DB)', function() {
  beforeEach(function() {
    mockStore = {
      members: [{ _id: 'm1', family_id: 'f1', _openid: 'mock_openid', member_id: 'mem_001', name: '张三', role: '本人', gender: '男', age: 35, income: 30 }],
      facts: [{ subject_id: 'mem_001', predicate: '健康异常', object_value: '轻度脂肪肝', status: 'active', confidence: 1 }],
      policies: [{ _id: 'p1', family_id: 'f1', _openid: 'mock_openid', member_id: 'mem_001', insurance_category: '重疾险', sum_assured: 500000, status: 'active' }]
    }
    mockFailCollections = []
  })

  test('正常返回成员画像（含保障清单）', function() {
    return dataQuery.main({ action: 'queryMemberProfile', familyId: 'f1', memberId: 'mem_001' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.profile.member.name).toBe('张三')
      expect(res.data.profile.member.income).toBe(30)
      expect(res.data.profile.policies.length).toBe(1)
      expect(res.data.profile.policies[0].insurance_category).toBe('重疾险')
      expect(res.data.profile.health.length).toBe(1)
    })
  })

  test('缺少定位参数返回 400', function() {
    return dataQuery.main({ action: 'queryMemberProfile', familyId: 'f1' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('成员不存在返回 404', function() {
    mockStore.members = []
    return dataQuery.main({ action: 'queryMemberProfile', familyId: 'f1', memberId: 'mem_xxx' }).then(function(res) {
      expect(res.code).toBe(404)
    })
  })

  // 核心回归：policies 查询失败不得伪装成"该成员无保单"
  test('policies 查询失败 → 返回 500，不吞成"无保单"', function() {
    mockFailCollections = ['policies']
    return dataQuery.main({ action: 'queryMemberProfile', familyId: 'f1', memberId: 'mem_001' }).then(function(res) {
      expect(res.code).toBe(500)
      expect(res.data).toBeUndefined()
    })
  })

  // 同批 facts 走 safeQueryAll：既定语义是"可观测降级"（打日志 + 返回已收集数据），不抛错。
  // 锁定该语义，避免将来被误当"吞错"而改动（改动前需先权衡：facts 缺失是否会导致 AI 误判）
  test('facts 查询失败 → 保持可观测降级（200 + facts 分组为空 + 有日志）', function() {
    mockFailCollections = ['facts']
    var spy = jest.spyOn(console, 'error').mockImplementation(function() {})
    return dataQuery.main({ action: 'queryMemberProfile', familyId: 'f1', memberId: 'mem_001' }).then(function(res) {
      expect(res.code).toBe(200) // 降级不阻断
      expect(res.data.profile.policies.length).toBe(1) // 保单不受影响
      expect(res.data.profile.health).toEqual([]) // facts 降级为空
      var logged = spy.mock.calls.some(function(c) { return String(c[0]).indexOf('safeQueryAll') >= 0 })
      expect(logged).toBe(true) // 降级可观测
      spy.mockRestore()
    })
  })
})
