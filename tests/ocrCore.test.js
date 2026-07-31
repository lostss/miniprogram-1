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

const { matchPoliciesToMembers } = require('../cloudfunctions/ocrService/_shared/ocr-core')

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
