// role-infer 纯模块单测（候选 2：自 ocr-flow 组件下沉的角色推断规则）
// 用例锁定原 _runRoleStage/_applyRoleState 的既有行为，防下沉回归
const { buildBirthMap, ageFromBirth, occupiedRoles, inferRelation, applyRoleConflicts } = require('../miniprogram/utils/role-infer')

const Y = new Date().getFullYear()

describe('buildBirthMap', () => {
  test('提取投保人/被保人/受益人出生日期', () => {
    const m = buildBirthMap([
      { policyholder_name: '老张', policyholder_birth_date: '1960-01-01' },
      { insured_name: '小张', insured_birth_date: '1995-01-01' },
      { beneficiary_name: '张妻', beneficiary_birth_date: '1962-01-01' }
    ])
    expect(m['老张']).toBe('1960-01-01')
    expect(m['小张']).toBe('1995-01-01')
    expect(m['张妻']).toBe('1962-01-01')
  })

  test('无出生日期/无名的不入 map', () => {
    const m = buildBirthMap([{ policyholder_name: 'A', policyholder_birth_date: '1990-01-01' }, { insured_name: 'B' }])
    expect(Object.keys(m)).toEqual(['A'])
  })
})

describe('ageFromBirth', () => {
  test('有效日期 → 当年减出生年', () => {
    expect(ageFromBirth(Y - 30 + '-01-01')).toBe(30)
  })
  test('无效/缺失 → NaN', () => {
    expect(Number.isNaN(ageFromBirth(''))).toBe(true)
    expect(Number.isNaN(ageFromBirth('not-a-date'))).toBe(true)
    expect(Number.isNaN(ageFromBirth(null))).toBe(true)
  })
})

describe('occupiedRoles', () => {
  test('只收集 本人/配偶，携带 memberId', () => {
    const occ = occupiedRoles([
      { name: '老张', role: '本人', member_id: 'm1' },
      { name: '张妻', role: '配偶', member_id: 'm2' },
      { name: '小张', role: '子女', member_id: 'm3' }
    ])
    expect(occ).toEqual({ 本人: { name: '老张', memberId: 'm1' }, 配偶: { name: '张妻', memberId: 'm2' } })
  })
})

describe('inferRelation 年龄差推断', () => {
  const holderBirth = (Y - 40) + '-01-01' // 40 岁
  const bm = buildBirthMap([
    { policyholder_name: '爸', policyholder_birth_date: holderBirth },
    { insured_name: '儿', insured_birth_date: (Y - 10) + '-01-01' },   // 差 +30 → 子女
    { insured_name: '爷', insured_birth_date: (Y - 70) + '-01-01' },   // 差 -30 → 父母
    { insured_name: '妻', insured_birth_date: (Y - 41) + '-01-01' }    // 差 -1 → 配偶
  ])
  const holderAge = ageFromBirth(holderBirth)

  test('差 >18 → 子女；差 <-18 → 父母；其余 → 配偶', () => {
    expect(inferRelation('儿', holderAge, bm, {})).toBe('子女')
    expect(inferRelation('爷', holderAge, bm, {})).toBe('父母')
    expect(inferRelation('妻', holderAge, bm, {})).toBe('配偶')
  })

  test('出生缺失/年龄不可比 → 其他', () => {
    expect(inferRelation('路人', holderAge, bm, {})).toBe('其他')
    expect(inferRelation('儿', NaN, bm, {})).toBe('其他')
  })

  test('配偶已被占用 → 其他（角色互斥）', () => {
    expect(inferRelation('妻', holderAge, bm, { 配偶: { name: '前任', memberId: 'x' } })).toBe('其他')
  })
})

describe('applyRoleConflicts 冲突标注', () => {
  const list = [
    { name: '老张', role: '本人' },
    { name: '张妻', role: '配偶' },
    { name: '小张', role: '子女' }
  ]

  test('每项标出"其它角色占用者"（切换角色时提示），自己当前角色豁免', () => {
    const res = applyRoleConflicts(list, {})
    // 老张(本人) 不标本人，但配偶被张妻占 → 提示
    expect(res[0].conflict).toEqual({ 配偶: '张妻' })
    // 张妻(配偶) 标本人占用
    expect(res[1].conflict).toEqual({ 本人: '老张' })
    // 小张(子女) 两者都标
    expect(res[2].conflict).toEqual({ 本人: '老张', 配偶: '张妻' })
  })

  test('外部占用（家庭既有但不在列表）也能标出', () => {
    const res = applyRoleConflicts([{ name: '小张', role: '子女' }], { 本人: { name: '老张', memberId: 'm1' } })
    expect(res[0].conflict).toEqual({ 本人: '老张' })
  })

  test('不改原列表（返回新对象）', () => {
    const src = [{ name: 'A', role: '本人' }]
    const res = applyRoleConflicts(src, {})
    expect(src[0]).not.toHaveProperty('conflict')
    expect(res[0]).toHaveProperty('conflict')
  })
})
