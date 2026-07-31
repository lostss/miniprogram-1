/**
 * aiExtractBatch handler 单元测试
 */
// wx-server-sdk 由 jest.config.js 的 moduleNameMapper 自动映射到 __mocks__/cloudSDKMock

// mock ocr-core 整体，避免触发 tencentcloud-sdk 加载
jest.mock('../cloudfunctions/ocrService/_shared/ocr-core', () => ({
  ocrPhase: jest.fn(),
  aiPhase: jest.fn(),
  aiExtractBatchPhase: jest.fn(),
  matchPoliciesToMembers: jest.fn(),
  buildPolicyFromExtract: jest.fn(),
  _toNum: jest.fn()
}))

// mock 间接依赖（ocr-extractor 加载 tencentcloud-sdk 会触发循环）
jest.mock('../cloudfunctions/ocrService/_shared/ocr-extractor', () => ({
  ocrRecognize: jest.fn(),
  aiExtract: jest.fn()
}))

const handlers = require('../cloudfunctions/ocrService/handlers')
const { aiExtractBatchPhase } = require('../cloudfunctions/ocrService/_shared/ocr-core')

var mockDb = {
  collection: function() {
    return {
      add: function() { return Promise.resolve({ _id: 'log1' }) },
      where: function() { return this },
      update: function() { return Promise.resolve({}) }
    }
  }
}

describe('aiExtractBatch handler', () => {
  beforeEach(() => { aiExtractBatchPhase.mockReset() })

  test('参数校验：缺少 ocr_results 返回 400', async () => {
    var res = await handlers.aiExtractBatch(mockDb, 'o1', { familyId: 'f1' })
    expect(res.code).toBe(400)
    expect(res.msg).toContain('ocr_results')
  })

  test('参数校验：ocr_results 非数组返回 400', async () => {
    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: 'notarray' })
    expect(res.code).toBe(400)
  })

  test('参数校验：空数组返回 400', async () => {
    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: [] })
    expect(res.code).toBe(400)
  })

  test('参数校验：超过 9 张返回 400', async () => {
    var ocrResults = Array.from({ length: 10 }, function(_, i) { return { fileId: 'cloud://f' + i, ocrText: 'text', ocrConfInfo: [] } })
    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: ocrResults })
    expect(res.code).toBe(400)
    expect(res.msg).toContain('9')
  })

  test('空 ocrText 过滤：标记 ocr_empty，不参与 AI 调用', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '', ocrConfInfo: [] }
    ]
    aiExtractBatchPhase.mockResolvedValue({
      results: [{ idx: 1, fileId: 'cloud://f1', success: true, policies: [{ product_name: 'A' }] }],
      totalDurationMs: 5000, splitUsed: false, aiCallCount: 1, tokens: {}, successCount: 1, failCount: 0
    })

    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: ocrResults, familyId: 'f1' })
    expect(res.code).toBe(200)
    expect(res.data.results.length).toBe(2)
    expect(res.data.results[0].success).toBe(true)
    expect(res.data.results[1].success).toBe(false)
    expect(res.data.results[1].errorCode).toBe('ocr_empty')
    // aiExtractBatchPhase 只收到 1 个有效 ocrResult
    expect(aiExtractBatchPhase.mock.calls[0][0].length).toBe(1)
  })

  test('正常调用：返回 results 和元数据', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '保单B', ocrConfInfo: [] }
    ]
    aiExtractBatchPhase.mockResolvedValue({
      results: [
        { idx: 1, fileId: 'cloud://f1', success: true, policies: [{ product_name: 'A' }] },
        { idx: 2, fileId: 'cloud://f2', success: true, policies: [{ product_name: 'B' }] }
      ],
      totalDurationMs: 8500, splitUsed: false, aiCallCount: 1, tokens: { total_tokens: 500 }, successCount: 2, failCount: 0
    })

    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: ocrResults, familyId: 'f1' })
    expect(res.code).toBe(200)
    expect(res.data.results.length).toBe(2)
    expect(res.data.total_duration_ms).toBe(8500)
    expect(res.data.split_used).toBe(false)
    expect(res.data.ai_call_count).toBe(1)
  })

  test('整体异常：所有图标记 ai_batch_failed', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] }
    ]
    aiExtractBatchPhase.mockRejectedValue(new Error('AI 服务异常'))

    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: ocrResults, familyId: 'f1' })
    expect(res.code).toBe(200)
    expect(res.data.results.length).toBe(1)
    expect(res.data.results[0].success).toBe(false)
    expect(res.data.results[0].errorCode).toBe('ai_batch_failed')
  })
})
