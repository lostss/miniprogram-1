/**
 * 经济支柱认定（2026-10-21，方案「经济支柱认定」）
 *
 * 原来只认 role（本人 / 经济支柱）—— 但"本人"是建档时的相对关系，
 * 祖父投保、孙辈被保时，被标"本人"的未必是支柱。
 *
 * 现在三级：手动标注 → 按投保人推断（单一投保人直接认定；多个取"为最多成员投保"，
 * 并列取保费贡献最高）→ 退回 role=本人 → members[0]。
 *
 * ⚠️ 这条口径会改变缺口金额（只有支柱能用家庭年收入兜底测算），
 *    所以每条断言都同时看 source —— 报告要写明"按投保人推断"。
 */
const { resolvePillar } = require('../miniprogram/utils/gap-core')

const M = (o) => Object.assign({ member_id: 'm', name: '某人', role: '', income: 0 }, o)
const P = (o) => Object.assign({ status: 'active', insured_name: '', policyholder_name: '', annual_premium: 1000 }, o)

describe('resolvePillar — 经济支柱三级认定', () => {
  test('手动标注（role 含「经济支柱」）优先于一切推断', () => {
    const members = [M({ name: '张三', role: '本人' }), M({ name: '李四', role: '经济支柱' })]
    const r = resolvePillar(members, [P({ insured_name: '张三', policyholder_name: '张三' })])
    expect(r.member.name).toBe('李四')
    expect(r.source).toBe('manual')
    expect(r.label).toBe('手动标注')
  })

  test('单一投保人为他人投保 → 直接认定（即使 role 是配偶）', () => {
    const members = [M({ name: '张三', role: '本人' }), M({ name: '李四', role: '配偶' })]
    const r = resolvePillar(members, [
      P({ insured_name: '张三', policyholder_name: '李四' }),
      P({ insured_name: '孩子', policyholder_name: '李四' })
    ])
    expect(r.member.name).toBe('李四')
    expect(r.source).toBe('policyholder')
    expect(r.label).toBe('按投保人推断')
  })

  test('多个投保人 → 取为最多成员投保者', () => {
    const members = [M({ name: '张三' }), M({ name: '李四' })]
    const r = resolvePillar(members, [
      P({ insured_name: 'A', policyholder_name: '张三' }),
      P({ insured_name: 'B', policyholder_name: '李四' }),
      P({ insured_name: 'C', policyholder_name: '李四' })
    ])
    expect(r.member.name).toBe('李四')
  })

  test('人数并列 → 取保费贡献最高者', () => {
    const members = [M({ name: '张三' }), M({ name: '李四' })]
    const r = resolvePillar(members, [
      P({ insured_name: 'A', policyholder_name: '张三', annual_premium: 50000 }),
      P({ insured_name: 'B', policyholder_name: '李四', annual_premium: 1000 })
    ])
    expect(r.member.name).toBe('张三')
  })

  test('自己给自己投保不算"为他人投保"（否则人人都是支柱）', () => {
    const members = [M({ name: '张三', role: '本人' }), M({ name: '李四', role: '配偶' })]
    const r = resolvePillar(members, [P({ insured_name: '张三', policyholder_name: '张三' })])
    expect(r.source).toBe('role')
    expect(r.member.name).toBe('张三')
  })

  test('无保单、无标注 → 退回 role=本人（保持旧兜底，不产生空支柱）', () => {
    const r = resolvePillar([M({ name: '张三', role: '本人' }), M({ name: '李四' })], [])
    expect(r.member.name).toBe('张三')
    expect(r.source).toBe('role')
  })

  test('失效保单的投保人不参与推断（退保家庭不该改变支柱）', () => {
    const members = [M({ name: '张三', role: '本人' }), M({ name: '李四' })]
    const r = resolvePillar(members, [
      P({ insured_name: 'A', policyholder_name: '李四', status: 'surrendered' })
    ])
    expect(r.member.name).toBe('张三')
  })

  test('投保人不在成员名单 → 不认（宁可退回 role，也不指向不存在的成员）', () => {
    const members = [M({ name: '张三', role: '本人' })]
    const r = resolvePillar(members, [P({ insured_name: 'A', policyholder_name: '外人' })])
    expect(r.member.name).toBe('张三')
    expect(r.source).toBe('role')
  })
})
