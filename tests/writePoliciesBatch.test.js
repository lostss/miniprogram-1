/**
 * writePoliciesBatch handler — DB mock 集成测试
 *
 * 2026-09-15 架构审查候选 4：DB mock 统一为 tests/helpers/memory-db。旧桩三处与生产语义不符：
 *   1) where().get() 恒只返回【首个】匹配行（等价于隐式 limit(1)）→ 与真实"返回全部匹配"不同；
 *   2) where().count() 忽略条件、按 _openid 硬编码统计；
 *   3) add(data) 按非 SDK 形状入参（SDK 是 add({ data })）→ 落库记录会多一层 data 嵌套。
 * store 即表容器（db 持有其引用）：加载期构造 + beforeEach 原地清空，不可重新赋值。
 */
const { makeMemoryDb } = require('./helpers/memory-db')
const mockStore = { families: [], members: [], policies: [], agent_logs: [] }
const mockMemDb = makeMemoryDb(mockStore)

jest.mock('wx-server-sdk', function() {
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockMemDb }),
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

describe('writePoliciesBatch (memory-db)', function() {
  beforeEach(function() {
    // 原地清空（不重新赋值）：db 持有 mockStore 的引用
    Object.keys(mockStore).forEach(function(k) { mockStore[k].length = 0 })
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', members: [], engagement_stage: 'onboarding' })
    mockStore.members.push(
      { _id: 'mm1', family_id: 'f1', _openid: 'mock_openid', member_id: 'm1', name: '张三', role: '本人' },
      { _id: 'mm2', family_id: 'f1', _openid: 'mock_openid', member_id: 'm2', name: '李四', role: '配偶' }
    )
  })

  test('缺少 familyId 返回 400', function() {
    return dataWrite.main({ action: 'writePoliciesBatch', policies: [{ insured_name: '张三' }] }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  // 2026-09-19（流程审计 UX3）：写保单必须重算完整度 —— 原先只在 updateFamily/reportAI 里重算，
  // OCR 存完一批后首页完整度圆环仍是旧值（用户以为没生效）。
  // calcCompletenessScore：有成员 +20、有保单 +20（成员资料不全故不满分）→ 至少 20。
  test('批次写入后重算 completeness_score（首页圆环据此更新）', function() {
    return dataWrite.main({ action: 'writePoliciesBatch', familyId: 'f1', policies: [{ insured_name: '张三', product_name: '储蓄险', sum_assured: 100000 }] }).then(function(res) {
      expect(res.code).toBe(200)
      const fam = mockStore.families.find(function(f) { return f._id === 'f1' })
      expect(fam.completeness_score).toBeGreaterThanOrEqual(20)
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
      // 2026-09-15：落库记录是**平铺**的（{ _id, ...payload.data }）。原注释与断言写成
      // `row.data.*` 是旧桩的产物——旧桩 add(data) 按非 SDK 形状入参，落库多了一层 data 嵌套，
      // 于是测试断言的形状在生产中并不存在（memory-db 注释亦记载了该结论）。
      const row = mockStore.policies.find(p => p.insured_name === '张三' && p.product_name === '储蓄险')
      expect(row.sum_assured).toBe(800000)
      expect(row.annual_premium).toBe(15000)
    })
  })

  test('H2：手填 "1.2亿" 落库为 120000000', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '团险', sum_assured: '1.2亿' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.product_name === '团险')
      expect(row.sum_assured).toBe(120000000)
    })
  })

  test('H2：OCR 直传元数字原样保留（不误乘万）', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '重疾险', sum_assured: 500000, annual_premium: 8000 }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.product_name === '重疾险')
      expect(row.sum_assured).toBe(500000)
      expect(row.annual_premium).toBe(8000)
    })
  })

  test('H2：非法金额字符串兜底 0（不落库 NaN/字符串）', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '异常', sum_assured: 'abc' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.product_name === '异常')
      expect(row.sum_assured).toBe(0)
    })
  })

  test('H2：千分位 "80,000" 数字化为 80000', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '重疾险', sum_assured: '80,000' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.product_name === '重疾险')
      expect(row.sum_assured).toBe(80000)
    })
  })

  // ===== OCR 审计 M4：effective_date 格式规范 =====
  test('M4：中文日期 "2024年01月15日" → 规范为 2024-01-15', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '规范日期', effective_date: '2024年01月15日' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.product_name === '规范日期')
      expect(row.effective_date).toBe('2024-01-15')
    })
  })

  test('M4：斜杠日期 "2024/1/15" → 规范为 2024-01-15', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '斜杠日期', effective_date: '2024/1/15' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.product_name === '斜杠日期')
      expect(row.effective_date).toBe('2024-01-15')
    })
  })

  test('M4：已标准 YYYY-MM-DD 原样保留', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '标准日期', effective_date: '2024-01-15' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.product_name === '标准日期')
      expect(row.effective_date).toBe('2024-01-15')
    })
  })

  test('M4：无法解析的日期 → 置空（不落垃圾数据）', function() {
    return dataWrite.main({
      action: 'writePoliciesBatch', familyId: 'f1',
      policies: [{ insured_name: '张三', product_name: '脏日期', effective_date: '1年' }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      const row = mockStore.policies.find(p => p.product_name === '脏日期')
      expect(row.effective_date).toBe('')
    })
  })
})
