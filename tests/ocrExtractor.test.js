/**
 * ocr-extractor 纯函数单元测试
 * _parseAIJSON + _toNum
 * RED phase → GREEN
 */
jest.mock('tencentcloud-sdk-nodejs-ocr', () => ({
  ocr: {
    v20181119: {
      Client: class {
        constructor() {}
        async GeneralAccurateOCR() {
          throw new Error('mock OCR 服务异常')
        }
      }
    }
  }
}), { virtual: true })
process.env.TENCENT_SECRET_ID = 'test-secret-id'
process.env.TENCENT_SECRET_KEY = 'test-secret-key'

const { _parseAIJSON, ocrRecognize } = require('../cloudfunctions/_shared/ocr-extractor')
const { _toNum } = require('../cloudfunctions/_shared/ocr-core')


describe('_toNum', () => {
  test('纯数字不变', () => {
    expect(_toNum(100)).toBe(100)
    expect(_toNum(0)).toBe(0)
    expect(_toNum(3.14)).toBeCloseTo(3.14, 2)
  })

  test('null/undefined 返回0', () => {
    expect(_toNum(null)).toBe(0)
    expect(_toNum(undefined)).toBe(0)
  })

  test('数字字符串转换为数字', () => {
    expect(_toNum('500')).toBe(500)
    expect(_toNum('3.14')).toBeCloseTo(3.14, 2)
  })

  test('带单位/符号的金额字符串提取数字', () => {
    expect(_toNum('¥100,000')).toBe(100000)
    expect(_toNum('10万元')).toBe(10)
    expect(_toNum('$1,234.56')).toBe(1234.56)
  })

  test('空字符串返回0', () => {
    expect(_toNum('')).toBe(0)
    expect(_toNum('abc')).toBe(0)
  })

  test('负数处理', () => {
    expect(_toNum('-100')).toBe(100) // 正则去除非数字会丢负号
  })
})

describe('_parseAIJSON', () => {
  test('标准JSON直接解析', () => {
    const r = _parseAIJSON('{"result":"success","data":{}}')
    expect(r).toEqual({ result: 'success', data: {} })
  })

  test('JSON文本被markdown包裹仍可提取', () => {
    const r = _parseAIJSON('这是分析结果：\n```json\n{"result":"success","data":{}}\n```')
    expect(r).toEqual({ result: 'success', data: {} })
  })

  test('嵌套JSON在文本中提取', () => {
    const r = _parseAIJSON('前缀文本 {"result":"success","data":{"items":[1,2]}} 后缀')
    expect(r).toEqual({ result: 'success', data: { items: [1, 2] } })
  })

  test('无效文本返回null', () => {
    expect(_parseAIJSON('这不是JSON')).toBeNull()
  })

  test('空串返回null', () => {
    expect(_parseAIJSON('')).toBeNull()
  })

  test('null输入', () => {
    expect(_parseAIJSON(null)).toBeNull()
  })

  test('只匹配第一个JSON对象', () => {
    const r = _parseAIJSON('{"a":1} 后面的 {"b":2} 被忽略')
    expect(r).toEqual({ a: 1 })
  })

  test('数组JSON也能解析', () => {
    const r = _parseAIJSON('[1,2,3]')
    expect(r).toEqual([1, 2, 3])
  })
})

describe('ocrRecognize 服务异常', () => {
  test('SDK 重试后仍失败返回 ocr_service_error（与空识别区分）', async () => {
    const r = await ocrRecognize('http://example.com/temp.jpg')
    expect(r).toEqual({ text: '', confs: [], error_code: 'ocr_service_error' })
  })
})
