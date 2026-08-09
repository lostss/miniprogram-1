/**
 * chat-source v9 工具意图标识解析测试
 * 覆盖：标识剥离、嵌套 JSON（args 含对象）、解析失败兜底、无标识原样
 */
const { _extractToolIntent } = require('../miniprogram/utils/chat-source')

describe('_extractToolIntent', () => {
  test('无标识 → 文本原样返回，toolIntent=null', () => {
    const r = _extractToolIntent('这是一个普通回复')
    expect(r.text).toBe('这是一个普通回复')
    expect(r.toolIntent).toBeNull()
  })

  test('末尾独立行标识 → 剥离标识行 + 解析 intent', () => {
    const r = _extractToolIntent('已为您更新家庭年收入为 25 万\n{TOOL_INTENT:{"tools":[{"name":"updateFinances","args":{"annual_income":250000}}]}}')
    expect(r.text).toBe('已为您更新家庭年收入为 25 万')
    expect(r.toolIntent).not.toBeNull()
    expect(r.toolIntent.tools[0].name).toBe('updateFinances')
    expect(r.toolIntent.tools[0].args.annual_income).toBe(250000)
  })

  test('嵌套 JSON（args 含对象）→ 贪婪匹配到最后闭合括号', () => {
    const json = '{"tools":[{"name":"addPolicy","args":{"product_name":"康宁","sum_assured":1000000,"beneficiary":{"name":"谢敏","ratio":"50%"}}}]}'
    const r = _extractToolIntent('已添加保单\n{TOOL_INTENT:' + json + '}')
    expect(r.toolIntent).not.toBeNull()
    expect(r.toolIntent.tools[0].args.beneficiary.ratio).toBe('50%')
  })

  test('标识 JSON 解析失败 → 兜底 toolIntent=null，标识行仍剥离', () => {
    const r = _extractToolIntent('回复\n{TOOL_INTENT:{bad json')
    expect(r.text).toBe('回复')
    expect(r.toolIntent).toBeNull()
  })

  test('多行文本 + 标识在中间 → 仅剥离标识行，其余保留', () => {
    const r = _extractToolIntent('第一行\n{TOOL_INTENT:{"tools":[{"name":"addFact","args":{}}]}}\n第三行')
    expect(r.text).toBe('第一行\n第三行')
    expect(r.toolIntent).not.toBeNull()
  })
})
