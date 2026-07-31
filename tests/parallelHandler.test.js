/**
 * aiExtractParallel handler 单元测试（方案 D：DeepSeek 并行）
 */
// wx-server-sdk 由 jest.config.js 的 moduleNameMapper 自动映射到 __mocks__/cloudSDKMock

// mock ocr-core 整体，避免触发 tencentcloud-sdk 加载
jest.mock('../cloudfunctions/ocrService/_shared/ocr-core', () => ({
  ocrPhase: jest.fn(),
  aiPhase: jest.fn(),
  aiExtractBatchPhase: jest.fn(),
  matchPoliciesToMembers: jest.fn(),
  buildPolicyFromExtract: jest.fn(),
  _toNum: jest.fn(),
  processOneImage: jest.fn()
}))

// mock 间接依赖（ocr-extractor 加载 tencentcloud-sdk 会触发循环）
jest.mock('../cloudfunctions/ocrService/_shared/ocr-extractor', () => ({
  ocrRecognize: jest.fn(),
  aiExtract: jest.fn()
}))

const handlers = require('../cloudfunctions/ocrService/handlers')
const { aiPhase } = require('../cloudfunctions/ocrService/_shared/ocr-core')

var mockDb = {
  collection: function() {
    return {
      add: function() { return Promise.resolve({ _id: 'log1' }) },
      where: function() { return this },
      update: function() { return Promise.resolve({}) }
    }
  }
}

function okAiResult(productName, tokens) {
  return {
    success: true,
    policies: [{ product_name: productName, id: 'pol_1' }],
    cashValueData: null,
    document_type: 'policy',
    tokens: tokens || { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
  }
}

describe('aiExtractParallel handler', () => {
  beforeEach(() => { aiPhase.mockReset() })

  test('参数校验：缺少 ocr_results 返回 400', async () => {
    var res = await handlers.aiExtractParallel(mockDb, 'o1', { familyId: 'f1' })
    expect(res.code).toBe(400)
    expect(res.msg).toContain('ocr_results')
  })

  test('参数校验：ocr_results 非数组返回 400', async () => {
    var res = await handlers.aiExtractParallel(mockDb, 'o1', { ocr_results: 'notarray' })
    expect(res.code).toBe(400)
  })

  test('参数校验：空数组返回 400', async () => {
    var res = await handlers.aiExtractParallel(mockDb, 'o1', { ocr_results: [] })
    expect(res.code).toBe(400)
  })

  test('参数校验：超过 10 张返回 400', async () => {
    var ocrResults = Array.from({ length: 11 }, function(_, i) { return { fileId: 'cloud://f' + i, ocrText: 'text', ocrConfInfo: [] } })
    var res = await handlers.aiExtractParallel(mockDb, 'o1', { ocr_results: ocrResults })
    expect(res.code).toBe(400)
    expect(res.msg).toContain('10')
  })

  test('空 ocrText 过滤：标记 ocr_empty，不调用 aiPhase', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '', ocrConfInfo: [] }
    ]
    aiPhase.mockResolvedValue(okAiResult('A'))

    var res = await handlers.aiExtractParallel(mockDb, 'o1', { ocr_results: ocrResults, familyId: 'f1' })
    expect(res.code).toBe(200)
    expect(res.data.results.length).toBe(2)
    expect(res.data.results[0].success).toBe(true)
    expect(res.data.results[1].success).toBe(false)
    expect(res.data.results[1].errorCode).toBe('ocr_empty')
    // aiPhase 只收到 1 个有效 ocrResult
    expect(aiPhase.mock.calls.length).toBe(1)
    expect(aiPhase.mock.calls[0][0].ocrText).toBe('保单A')
  })

  test('全部为空：不调用 AI，全部标记 ocr_empty', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '', ocrConfInfo: [] }
    ]
    var res = await handlers.aiExtractParallel(mockDb, 'o1', { ocr_results: ocrResults })
    expect(res.code).toBe(200)
    expect(aiPhase.mock.calls.length).toBe(0)
    expect(res.data.ai_call_count).toBe(0)
    expect(res.data.results.every(function(r) { return !r.success && r.errorCode === 'ocr_empty' })).toBe(true)
  })

  test('N 张并发：每张独立调用 aiPhase，结果按原始顺序返回', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '保单B', ocrConfInfo: [] },
      { fileId: 'cloud://f3', ocrText: '现价表C', ocrConfInfo: [] }
    ]
    aiPhase.mockImplementation(function(opts) {
      return Promise.resolve(okAiResult(opts.ocrText === '现价表C' ? 'C' : (opts.ocrText === '保单B' ? 'B' : 'A')))
    })

    var res = await handlers.aiExtractParallel(mockDb, 'o1', { ocr_results: ocrResults, familyId: 'f1' })
    expect(res.code).toBe(200)
    // 每张都独立调用了一次
    expect(aiPhase.mock.calls.length).toBe(3)
    expect(res.data.ai_call_count).toBe(3)
    // 结果顺序与输入一致
    expect(res.data.results.map(function(r) { return r.fileId })).toEqual(['cloud://f1', 'cloud://f2', 'cloud://f3'])
    expect(res.data.results.every(function(r) { return r.success })).toBe(true)
    expect(res.data.success_count).toBe(3)
    expect(res.data.fail_count).toBe(0)
    // tokens 汇总
    expect(res.data.tokens.total_tokens).toBe(450)
  })

  test('单张失败不影响其他张（各自独立 error_code）', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '坏图B', ocrConfInfo: [] },
      { fileId: 'cloud://f3', ocrText: '保单C', ocrConfInfo: [] }
    ]
    aiPhase.mockImplementation(function(opts) {
      if (opts.ocrText === '坏图B') {
        return Promise.resolve({ success: false, error: 'AI返回格式错误', error_code: 'ai_format' })
      }
      return Promise.resolve(okAiResult(opts.ocrText))
    })

    var res = await handlers.aiExtractParallel(mockDb, 'o1', { ocr_results: ocrResults })
    expect(res.code).toBe(200)
    expect(res.data.results[0].success).toBe(true)
    expect(res.data.results[1].success).toBe(false)
    expect(res.data.results[1].errorCode).toBe('ai_format')
    expect(res.data.results[2].success).toBe(true)
    expect(res.data.success_count).toBe(2)
    expect(res.data.fail_count).toBe(1)
  })
})
