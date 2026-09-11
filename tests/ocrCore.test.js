/**
 * ocr-core 单元测试（纯逻辑部分）
 * matchPoliciesToMembers 的成员匹配算法
 * Plan A：成员来自 members 集合（getMembers 走 members 集合）
 */

const MEMBERS = [
  { member_id: 'm1', name: '李牧云', role: '本人' },
  { member_id: 'm2', name: '成员2', role: '' },
  { member_id: 'm3', name: '成员3', role: '' }
]

const mockDb = {
  collection: function() {
    return {
      where: function() {
        return {
          field: function() { return this },
          limit: function() { return this },
          get: function() { return Promise.resolve({ data: MEMBERS }) },
          update: function() { return Promise.resolve({ stats: { updated: 1 } }) },
          remove: function() { return Promise.resolve({ stats: { removed: 1 } }) }
        }
      },
      add: function() { return Promise.resolve({ _id: 'new_mem' }) },
      doc: function() { return { update: function() { return Promise.resolve({}) }, remove: function() { return Promise.resolve({}) } } },
      update: function() { return Promise.resolve({ stats: { updated: 1 } }) }
    }
  }
}

const { matchPoliciesToMembers, extractOne } = require('../cloudfunctions/ocrService/_shared/ocr-core')

describe('matchPoliciesToMembers', () => {
  test('精确匹配被保人到成员', async () => {
    const policies = [{ insured_name: '李牧云', policyholder_name: '李牧云', product_name: '重疾险' }]
    await matchPoliciesToMembers({ db: mockDb, familyId: 'f1', openid: 'o1', allPolicies: policies })
    expect(policies[0].member_id).toBe('m1')
  })

  test('骨架成员按被保人自动改名', async () => {
    const policies = [{ insured_name: '王芳', policyholder_name: '王芳', product_name: '意外险' }]
    await matchPoliciesToMembers({ db: mockDb, familyId: 'f1', openid: 'o1', allPolicies: policies })
    expect(policies[0].member_id).toBe('m2')
  })

  test('被保人+投保人=同一人只匹配一次', async () => {
    const policies = [{ insured_name: '李牧云', policyholder_name: '李牧云', product_name: '医疗险' }]
    await matchPoliciesToMembers({ db: mockDb, familyId: 'f1', openid: 'o1', allPolicies: policies })
    expect(policies[0].member_id).toBe('m1')
  })
})

// 现价表片段拦截（2026-09-09）：mixed 丢弃 + cash_value 完整性校验
describe('extractOne 现价表片段拦截', () => {
  function buildExtract(documentType, cashValues) {
    return {
      result: 'success',
      document_type: documentType,
      data: {
        contract_basic: { policy_number: 'P1', insurance_company: '安心人寿', insured_name: '李阳勇' },
        products: [{ product_name: '安心保臻选版定期重大疾病保险', insurance_category: '重疾', sum_assured: 500000, annual_premium: 1830 }],
        field_confidence: { product_name: 0.95 },
        overall_confidence: 0.9
      },
      cash_value_data: cashValues ? { header_info: {}, cash_values: cashValues, overall_confidence: 0.9 } : undefined
    }
  }

  // 2026-09-11：mixed 不再无条件丢弃现价表——完整表保留（原策略会误杀"保单正页 + 现价表同屏"的真表）
  test('mixed：同图含完整现价表 → 保留现价表，docType 仍降级为 policy', () => {
    const cv = [1, 2, 3, 4, 5].map(y => ({ y, v: y * 100 }))
    const ex = extractOne(buildExtract('mixed', cv), [])
    expect(ex.cashValueData).not.toBeNull()
    expect(ex.cashValueData.cash_values).toHaveLength(5)
    expect(ex.docType).toBe('policy') // 同图以保单主体为主，分组仍按 policy
  })

  test('mixed：现价表为残留片段（年度不连续/行数不足）→ 仍丢弃', () => {
    const ex = extractOne(buildExtract('mixed', [{ y: 12, v: 100 }, { y: 13, v: 200 }]), [])
    expect(ex.cashValueData).toBeNull()
    expect(ex.docType).toBe('policy')
  })

  test('cash_value：年度不从 1 起 / 行数不足 → 不提取', () => {
    const ex = extractOne(buildExtract('cash_value', [{ y: 12, v: 100 }, { y: 13, v: 200 }]), [])
    expect(ex.cashValueData).toBeNull()
  })

  test('cash_value：自 1 起连续且 ≥5 行 → 保留', () => {
    const cv = [1, 2, 3, 4, 5].map(y => ({ y, v: y * 100 }))
    const ex = extractOne(buildExtract('cash_value', cv), [])
    expect(ex.cashValueData).not.toBeNull()
    expect(ex.cashValueData.cash_values).toHaveLength(5)
    expect(ex.docType).toBe('cash_value')
  })
})
