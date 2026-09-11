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
  test('有 policy_number：同号同产品名判重（OCR 两次提取同保单同产品）', function() {
    var r = pw._dedupPolicies([
      { policy_number: 'P1', product_name: '康宁' },
      { policy_number: 'P1', product_name: '康宁' }
    ])
    expect(r.dedupedPolicies.length).toBe(1)
    expect(r.dedupSkipped).toBe(1)
  })
  test('P-DUP：同保单号多产品（主险+附加险）不互相去重', function() {
    var r = pw._dedupPolicies([
      { policy_number: 'P1', product_name: '康宁终身寿险' },
      { policy_number: 'P1', product_name: '康宁附加住院医疗' },
      { policy_number: 'P1', product_name: '康宁终身寿险' }
    ])
    expect(r.dedupedPolicies.length).toBe(2)
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

  // ===== OCR 审计 H2：人工编辑路径金额归一（万/亿→元 + 数字化） =====
  test('H2：手填 "80万" 落库为 800000（元数字）', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '储蓄险', sum_assured: '80万', annual_premium: '1.5万' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      // mock 的 add 模拟真实 SDK 语义：row = { _id, data: doc }，落库数据在 row.data
      const row = mockStore.policies.find(p => p.data && p.data.insured_name === '张三' && p.data.product_name === '储蓄险')
      expect(row.data.sum_assured).toBe(800000)
      expect(row.data.annual_premium).toBe(15000)
    })
  })

  test('H2：手填 "1.2亿" 落库为 120000000', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '团险', sum_assured: '1.2亿' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.data && p.data.product_name === '团险')
      expect(row.data.sum_assured).toBe(120000000)
    })
  })

  test('H2：OCR 直传元数字原样保留（不误乘万）', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '重疾险', sum_assured: 500000, annual_premium: 8000 }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.data && p.data.product_name === '重疾险')
      expect(row.data.sum_assured).toBe(500000)
      expect(row.data.annual_premium).toBe(8000)
    })
  })

  test('H2：非法金额字符串兜底 0（不落库 NaN/字符串）', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '异常', sum_assured: 'abc' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.data && p.data.product_name === '异常')
      expect(row.data.sum_assured).toBe(0)
    })
  })

  test('H2：千分位 "80,000" 数字化为 80000', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '重疾险', sum_assured: '80,000' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.data && p.data.product_name === '重疾险')
      expect(row.data.sum_assured).toBe(80000)
    })
  })

  // ===== OCR 审计 M4：effective_date 格式规范 =====
  test('M4：中文日期 "2024年01月15日" → 规范为 2024-01-15', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '规范日期', effective_date: '2024年01月15日' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.data && p.data.product_name === '规范日期')
      expect(row.data.effective_date).toBe('2024-01-15')
    })
  })

  test('M4：斜杠日期 "2024/1/15" → 规范为 2024-01-15', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '斜杠日期', effective_date: '2024/1/15' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.data && p.data.product_name === '斜杠日期')
      expect(row.data.effective_date).toBe('2024-01-15')
    })
  })

  test('M4：已标准 YYYY-MM-DD 原样保留', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '标准日期', effective_date: '2024-01-15' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.data && p.data.product_name === '标准日期')
      expect(row.data.effective_date).toBe('2024-01-15')
    })
  })

  test('M4：无法解析的日期 → 置空（不落垃圾数据）', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '脏日期', effective_date: '1年' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.data && p.data.product_name === '脏日期')
      expect(row.data.effective_date).toBe('')
    })
  })
})
