/**
 * member-dimensions 纯数据模块测试
 * RED phase
 */
const { MEMBER_DIMENSIONS, FAMILY_DIMENSIONS, ZH_TO_EN, EN_TO_ZH } = require('../cloudfunctions/dataWrite/member-dimensions')

describe('维度映射', () => {
  test('成员维度7个（含婚姻状况）', () => {
    expect(MEMBER_DIMENSIONS).toHaveLength(7)
    expect(MEMBER_DIMENSIONS).toContain('age')
    expect(MEMBER_DIMENSIONS).toContain('gender')
    expect(MEMBER_DIMENSIONS).toContain('role')
    expect(MEMBER_DIMENSIONS).toContain('health')
    expect(MEMBER_DIMENSIONS).toContain('occupation')
    expect(MEMBER_DIMENSIONS).toContain('education')
    expect(MEMBER_DIMENSIONS).toContain('marital_status')
  })

  test('家庭维度4个', () => {
    expect(FAMILY_DIMENSIONS).toHaveLength(4)
    expect(FAMILY_DIMENSIONS).toContain('income')
    expect(FAMILY_DIMENSIONS).toContain('annual_premium_budget')
    expect(FAMILY_DIMENSIONS).toContain('debt')
    expect(FAMILY_DIMENSIONS).toContain('fixed_expense')
  })

  test('中英映射一一对应', () => {
    const zhKeys = Object.keys(ZH_TO_EN)
    const enKeys = Object.keys(EN_TO_ZH)
    expect(zhKeys.length).toBe(enKeys.length)
    zhKeys.forEach(zh => {
      const en = ZH_TO_EN[zh]
      expect(EN_TO_ZH[en]).toBe(zh)
    })
  })

  test('ZH_TO_EN值都在MEMBER_DIMENSIONS中', () => {
    Object.values(ZH_TO_EN).forEach(en => {
      expect(MEMBER_DIMENSIONS).toContain(en)
    })
  })

  test('EN_TO_ZH键都在MEMBER_DIMENSIONS中', () => {
    Object.keys(EN_TO_ZH).forEach(en => {
      expect(MEMBER_DIMENSIONS).toContain(en)
    })
  })

  test('所有成员维度有对应中文', () => {
    MEMBER_DIMENSIONS.forEach(en => {
      expect(EN_TO_ZH).toHaveProperty(en)
    })
  })
})
