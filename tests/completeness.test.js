/**
 * completeness 纯函数测试
 * RED phase — calcCompletenessScore
 */
const { calcCompletenessScore } = require('../cloudfunctions/dataWrite/_shared/completeness')

describe('calcCompletenessScore', () => {
  test('空家庭返回0', () => {
    expect(calcCompletenessScore({})).toBe(0)
  })

  test('仅有成员+姓名角色性别年龄齐全=40分', () => {
    const f = { members: [{ name: '张', role: '本人', gender: '男', age: '35' }] }
    expect(calcCompletenessScore(f)).toBe(40)
  })

  test('成员不全减半', () => {
    const f = { members: [{ name: '张', role: '本人' }] } // 缺gender/age
    expect(calcCompletenessScore(f)).toBe(20)
  })

  test('有保单+20', () => {
    const f = { members: [], policies: [{ id: '1' }] }
    expect(calcCompletenessScore(f, [{ id: '1' }])).toBe(20)
  })

  test('收入+15, 负债+15（固定支出已从模型移除，不再计分）', () => {
    const f = { financial_snapshot: { income: 100000, debt: { amount: 50000 }, fixed_expense: 5000 } }
    expect(calcCompletenessScore(f)).toBe(30)
  })

  test('负债无amount不计分', () => {
    const f = { financial_snapshot: { income: 100000, debt: {} } }
    expect(calcCompletenessScore(f)).toBe(15)
  })

  test('满分 90 封顶（固定支出权重已移除）', () => {
    const f = { members: [{ name: '张', role: '本人', gender: '男', age: '35' }, { name: '李', role: '配偶', gender: '女', age: '33' }], financial_snapshot: { income: 100000, debt: { amount: 50000 }, fixed_expense: 5000 } }
    expect(calcCompletenessScore(f, [{ id: '1' }])).toBe(90)
  })

  test('多项齐备也不溢出（上限仍为 90）', () => {
    const f = { members: [{ name: '张', role: '本人', gender: '男', age: '35' }, { name: '李', role: '配偶', gender: '女', age: '33' }, { name: '王', role: '子女', gender: '男', age: '5' }], financial_snapshot: { income: 100000, debt: { amount: 50000 }, fixed_expense: 5000 } }
    expect(calcCompletenessScore(f, [{ id: '1' }, { id: '2' }])).toBe(90)
  })
})
