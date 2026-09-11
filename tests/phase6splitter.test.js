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

  test('非保障陈述语境不预提取（问候/习惯描述）', () => {
    expect(splitCoverageText('你好')).toEqual([])
    expect(splitCoverageText('不吸烟不喝酒偶尔运动')).toEqual([])
  })

  test('无明确险种词时兜底降置信度行为已移除（交回模型处理）', () => {
    // 旧 C2 兜底把任意文本降档成"拥有保障"污染 AI 上下文，现改为不预提取
    expect(splitCoverageText('客户说好像买过一些保险但具体忘了')).toEqual([])
    expect(splitCoverageText('家庭连收入25万')).toEqual([])
    expect(splitCoverageText('康健华尊的生效日期是2021.7.10')).toEqual([])
  })
})
