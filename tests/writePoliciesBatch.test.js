/**
 * writePoliciesBatch handler — DB mock 集成测试
 */
var mockStore = { families: [{ _id: 'f1', _openid: 'mock_openid', members: [], engagement_stage: 'onboarding' }], policies: [], agent_logs: [] }

jest.mock('wx-server-sdk', function() {
  // mock where 条件过滤：按查询条件逐字段匹配
  function matchWhere(row, cond) {
    if (!cond || typeof cond !== 'object') return true
    return Object.keys(cond).every(function(k) {
      var condVal = cond[k]
      var rowVal = row[k]
      if (condVal && typeof condVal === 'object' && '$ne' in condVal) return rowVal !== condVal.$ne
      if (condVal && typeof condVal === 'object' && condVal.$ne !== undefined) return rowVal !== condVal.$ne
      return rowVal === condVal
    })
  }
  var mockDb = {
    collection: jest.fn(function(name) {
      var rows = mockStore[name] || []
      return {
        doc: jest.fn(function(id) { return {
          get: jest.fn(function() { return Promise.resolve({ data: rows.find(function(r) { return r._id === id }) || null }) }),
          update: jest.fn(function() { return Promise.resolve({ stats: { updated: 1 } }) })
        }}),
        where: jest.fn(function(cond) {
          var filtered = rows.filter(function(r) { return matchWhere(r, cond) })
          return {
            count: jest.fn(function() { return Promise.resolve({ total: filtered.length }) }),
            get: jest.fn(function() { return Promise.resolve({ data: filtered.length > 0 ? [filtered[0]] : [] }) }),
            update: jest.fn(function() { return Promise.resolve({ stats: { updated: filtered.length } }) }),
            remove: jest.fn(function() { return Promise.resolve({ stats: { removed: filtered.length } }) }),
            field: jest.fn(function() { return {
              limit: jest.fn(function() { return {
                get: jest.fn(function() { return Promise.resolve({ data: filtered.length > 0 ? [filtered[0]] : [] }) })
              }})
            }}),
            limit: jest.fn(function() { return {
              get: jest.fn(function() { return Promise.resolve({ data: filtered }) })
            }})
          }
        }),
        add: jest.fn(function(data) { var id = 'pol_' + Date.now(); rows.push({ _id: id, ...data }); return Promise.resolve({ _id: id }) }),
        count: jest.fn(function() { return Promise.resolve({ total: rows.filter(function(r) { return r._openid === 'mock_openid' }).length }) })
      }
    }),
    command: { push: function(v) { return { $push: v } }, serverDate: function() { return new Date('2026-01-01') }, neq: function(v) { return { $ne: v } } }
  }
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockDb }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid', APPID: 'mock_appid' } })
  }
})

var dataWrite = require('../cloudfunctions/dataWrite/index')
var pw = require('../cloudfunctions/dataWrite/policy-write')

describe('ingestPolicies step — _dedupPolicies（候选 3 step 化）', function() {
  test('有 policy_number：按号去重（同号不同产品名也算重复）', function() {
    var r = pw._dedupPolicies([
      { policy_number: 'P1', product_name: '康宁' },
      { policy_number: 'P1', product_name: '康宁·升级版' }
    ])
    expect(r.dedupedPolicies.length).toBe(1)
    expect(r.dedupSkipped).toBe(1)
  })
  test('无保单号：按 产品+被保人+投保人 去重', function() {
    var r = pw._dedupPolicies([
      { product_name: '康宁', insured_name: '张三', policyholder_name: '张三' },
      { product_name: '康宁', insured_name: '张三', policyholder_name: '张三' }
    ])
    expect(r.dedupedPolicies.length).toBe(1)
    expect(r.dedupSkipped).toBe(1)
  })
  test('不同保单不误去重', function() {
    var r = pw._dedupPolicies([
      { policy_number: 'P1' },
      { policy_number: 'P2' }
    ])
    expect(r.dedupedPolicies.length).toBe(2)
    expect(r.dedupSkipped).toBe(0)
  })
})

describe('writePoliciesBatch (mock DB)', function() {
  beforeEach(function() {
    mockStore = {
      families: [{ _id: 'f1', _openid: 'mock_openid', members: [], engagement_stage: 'onboarding' }],
      members: [
        { _id: 'mm1', family_id: 'f1', _openid: 'mock_openid', member_id: 'm1', name: '张三', role: '本人' },
        { _id: 'mm2', family_id: 'f1', _openid: 'mock_openid', member_id: 'm2', name: '李四', role: '配偶' }
      ],
      policies: [], agent_logs: []
    }
  })

  test('缺少 familyId 返回 400', function() {
    return dataWrite.main({ action: 'writePoliciesBatch', policies: [{ insured_name: '张三' }] }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('缺少 policies 返回 400', function() {
    return dataWrite.main({ action: 'writePoliciesBatch', familyId: 'f1' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('空 policies 数组返回 400', function() {
    return dataWrite.main({ action: 'writePoliciesBatch', familyId: 'f1', policies: [] }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('成功批量写入返回 200', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '重疾险', sum_assured: 500000 }, { insured_name: '李四', product_name: '医疗险' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.written).toBe(2)
      expect(res.data.total).toBe(2)
      expect(res.data.results.length).toBe(2)
      expect(res.data.results[0].ok).toBe(true)
      expect(res.data.results[1].ok).toBe(true)
    })
  })

  test('部分失败时返回 200且written=1', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '重疾险' }, { product_name: '无被保人' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.written).toBe(1) // 第二个缺 insured_name，返回400不计入
      expect(res.data.results[0].ok).toBe(true)
      expect(res.data.results[1].ok).toBe(false)
    })
  })
})
