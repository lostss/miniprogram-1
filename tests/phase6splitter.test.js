const { splitCoverageText } = require('../cloudfunctions/conversationAI/policyFactSplitter')

describe('policyFactSplitter (C1/C2)', () => {
  test('多块保障描述拆分为多条', () => {
    const r = splitCoverageText('我有重疾险50万，还有医疗险')
    expect(r.length).toBe(2)
    expect(r[0]).toEqual({ predicate: '拥有保障', objectValue: '重疾险,保额50万', confidence: 0.9 })
    expect(r[1]).toEqual({ predicate: '拥有保障', objectValue: '医疗险', confidence: 0.9 })
  })

  test('公司/团险识别为公司提供保障', () => {
    const r = splitCoverageText('公司给了意外险')
    expect(r.length).toBe(1)
    expect(r[0].predicate).toBe('公司提供保障')
    expect(r[0].objectValue).toBe('意外险')
  })

  test('C2：无分隔口语拆不开保持原样并降置信度', () => {
    const r = splitCoverageText('不吸烟不喝酒偶尔运动')
    expect(r.length).toBe(1)
    expect(r[0].objectValue).toBe('不吸烟不喝酒偶尔运动')
    expect(r[0].confidence).toBe(0.7)
  })

  test('无险种关键词时整段兜底降置信度', () => {
    const r = splitCoverageText('客户说好像买过一些保险但具体忘了')
    expect(r.length).toBe(1)
    expect(r[0].confidence).toBe(0.7)
  })
})
