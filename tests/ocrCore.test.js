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

// 2026-09-19：本文件的手写原生 mock 保留（candidate 4 的迁移候选），但补两项能力：
//   ① where().get() 返回可切换的成员集（骨架成员会"改名复用"而非新增，测建档时必须能换成无骨架的表）
//   ② add 记录入参（P1-2 要断言"谁被建档"）
const addedMembers = []
let currentMembers = MEMBERS.slice()
function setMembers(list) { currentMembers = list.slice() }

const mockDb = {
  collection: function() {
    return {
      where: function() {
        return {
          field: function() { return this },
          limit: function() { return this },
          get: function() { return Promise.resolve({ data: currentMembers }) },
          update: function() { return Promise.resolve({ stats: { updated: 1 } }) },
          remove: function() { return Promise.resolve({ stats: { removed: 1 } }) }
        }
      },
      add: function(payload) {
        addedMembers.push((payload && payload.data) || payload || {})
        return Promise.resolve({ _id: 'new_mem' })
      },
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

// ===========================================================================
// 2026-09-19 流程审计 P1-2：本批保单涉及的**每个人**都参与建档判定，不只被保人
//   （原实现只把未匹配上的 insured_name 建档 → 角色卡承诺"添加"的投保人/受益人永不创建，
//     前端写入后按姓名回查也找不到 → 角色确认被静默丢弃）
// ===========================================================================
describe('matchPoliciesToMembers — 建档范围（P1-2）', () => {
  // add 也被 operation_logs / 其它集合使用 → 只取"成员文档"（成员必有 member_id）
  const createdMembers = () => addedMembers.filter(m => m.member_id)

  beforeEach(function() {
    addedMembers.length = 0
    // 无骨架成员：否则未匹配的人会"改名复用"骨架而不产生 add，测不到建档
    setMembers([{ member_id: 'm1', name: '李牧云', role: '本人', birth_date: '1985-01-01' }])
  })
  afterEach(function() { setMembers(MEMBERS) })

  test('投保人 / 受益人不在成员表 → 一并建档，角色留空（由角色卡回写）', async () => {
    const policies = [{ insured_name: '李牧云', policyholder_name: '王芳', beneficiary_name: '小李', product_name: '重疾险' }]
    await matchPoliciesToMembers({ db: mockDb, familyId: 'f1', openid: 'o1', allPolicies: policies })

    expect(createdMembers().map(m => m.name).sort()).toEqual(['小李', '王芳']) // 被保人李牧云已在成员表 → 不重复建
    createdMembers().forEach(m => {
      expect(m.role).toBe('')
      expect(m.status).toBe('active')
      expect(m.family_id).toBe('f1')
    })
  })

  test('受益人缺出生日期也建档（原先被 `beneficiary_birth_date ?` 挡在候选之外）', async () => {
    const policies = [{ insured_name: '李牧云', beneficiary_name: '王芳', product_name: '寿险' }]
    await matchPoliciesToMembers({ db: mockDb, familyId: 'f1', openid: 'o1', allPolicies: policies })
    expect(createdMembers().map(m => m.name)).toEqual(['王芳'])
  })

  test('法定 / 法定继承人 / 未指定属占位文案 → 不建档（与前端 bloodNames 同一规则）', async () => {
    for (const b of ['法定', '法定继承人', '未指定']) {
      addedMembers.length = 0
      await matchPoliciesToMembers({ db: mockDb, familyId: 'f1', openid: 'o1', allPolicies: [{ insured_name: '李牧云', beneficiary_name: b, product_name: '寿险' }] })
      expect(createdMembers()).toEqual([])
    }
  })

  test('保单已带 member_id → 整体跳过（原守卫保持，避免重复建档）', async () => {
    await matchPoliciesToMembers({ db: mockDb, familyId: 'f1', openid: 'o1', allPolicies: [{ member_id: 'm1', insured_name: '新人', policyholder_name: '另一人', product_name: 'X' }] })
    expect(createdMembers()).toEqual([])
  })

  test('投保人/受益人只参与建档，不抢占保单的 member_id（该字段恒指被保人）', async () => {
    const policies = [{ insured_name: '李牧云', policyholder_name: '王芳', beneficiary_name: '小李', product_name: '重疾险' }]
    await matchPoliciesToMembers({ db: mockDb, familyId: 'f1', openid: 'o1', allPolicies: policies })
    expect(policies[0].member_id).toBe('m1') // = 被保人李牧云，而非投保人王芳
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
