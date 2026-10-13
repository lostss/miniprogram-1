/**
 * policyToFacts 单测 — 保单 → 结构化事实（纯函数，无 db 依赖）
 *
 * 覆盖 2026-09-18 报告页审计：补「受益人」保单属性。此前受益人既不在 fact 管道、
 * 也不在 POLICY_ATTRS，导致 AI 建议"指定受益人做资产隔离"时看不到现状。
 */
const { policyToFacts } = require('../cloudfunctions/dataWrite/policyToFacts')
const { POLICY_ATTRS, isPolicyAttr } = require('../cloudfunctions/_shared/fact-vocab')

function base(over = {}) {
  return Object.assign({ id: 'pol_1', product_name: 'X寿', insured_name: '李阳勇' }, over)
}

describe('policyToFacts — 受益人（2026-09-18 报告页审计）', () => {
  test('非空 → 产出 policy→literal 的「受益人」事实', () => {
    const facts = policyToFacts(base({ beneficiary_name: '王小明' }), { memberName: '李阳勇' })
    const b = facts.find(f => f.predicate === '受益人')
    expect(b).toBeTruthy()
    expect(b.subjectType).toBe('policy')
    expect(b.subjectId).toBe('pol_1')
    expect(b.objectType).toBe('literal')
    expect(b.objectValue).toBe('王小明')
  })

  test('缺失 / null / 空串 → 不产出该事实（lit 空值守卫，不给无受益人的保单添噪）', () => {
    for (const v of [undefined, null, '']) {
      const facts = policyToFacts(base({ beneficiary_name: v }), { memberName: '李阳勇' })
      expect(facts.find(f => f.predicate === '受益人')).toBeUndefined()
    }
  })

  test('受益人属保单节点属性集（与 queryFacts 默认排除策略一致，不给成员事实视图添噪）', () => {
    expect(POLICY_ATTRS).toContain('受益人')
    expect(isPolicyAttr('受益人')).toBe(true)
  })

  test('无 product_name → 整体返回空数组（既有守卫未被改动）', () => {
    expect(policyToFacts({ id: 'pol_1' }, {})).toEqual([])
  })
})
