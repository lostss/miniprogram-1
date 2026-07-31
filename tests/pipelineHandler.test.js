/**
 * ocrExtractParallel handler 单元测试（方案 E：云端 OCR→AI 流水线并行）
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
const { ocrPhase, aiPhase } = require('../cloudfunctions/ocrService/_shared/ocr-core')

var mockDb = {
  collection: function() {
    return {
      add: function() { return Promise.resolve({ _id: 'log1' }) },
      where: function() { return this },
      update: function() { return Promise.resolve({}) }
    }
  }
}

function okOcrResult(text) {
  return { ocrText: text, ocrConfInfo: [{ text: text, ocr_conf: 95 }], t0: 100, t1: 200, t2: 300 }
}

function okAiResult(productName) {
  return {
    success: true,
    policies: [{ product_name: productName, id: 'pol_1' }],
    cashValueData: null,
    document_type: 'policy',
    tokens: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
  }
}

describe('ocrExtractParallel handler', () => {
  beforeEach(() => { ocrPhase.mockReset(); aiPhase.mockReset() })

  test('参数校验：缺少 fileIds 返回 400', async () => {
    var res = await handlers.ocrExtractParallel(mockDb, 'o1', { familyId: 'f1' })
    expect(res.code).toBe(400)
    expect(res.msg).toContain('fileIds')
  })

  test('参数校验：fileIds 非数组返回 400', async () => {
    var res = await handlers.ocrExtractParallel(mockDb, 'o1', { fileIds: 'notarray' })
    expect(res.code).toBe(400)
  })

  test('参数校验：空数组返回 400', async () => {
    var res = await handlers.ocrExtractParallel(mockDb, 'o1', { fileIds: [] })
    expect(res.code).toBe(400)
  })

  test('参数校验：超过 10 张返回 400', async () => {
    var fileIds = Array.from({ length: 11 }, function(_, i) { return 'cloud://f' + i })
    var res = await handlers.ocrExtractParallel(mockDb, 'o1', { fileIds: fileIds })
    expect(res.code).toBe(400)
    expect(res.msg).toContain('10')
  })

  test('参数校验：非法 fileId 格式返回 400', async () => {
    var res = await handlers.ocrExtractParallel(mockDb, 'o1', { fileIds: ['not-cloud-url'] })
    expect(res.code).toBe(400)
    expect(res.msg).toContain('cloud://')
  })

  test('正常流程：每张 OCR→AI 各调用一次，结果按原始顺序返回', async () => {
    ocrPhase.mockImplementation(function(opts) { return Promise.resolve(okOcrResult(opts.fileId === 'cloud://f2' ? '保单B' : '保单A')) })
    aiPhase.mockImplementation(function(opts) { return Promise.resolve(okAiResult(opts.ocrText === '保单B' ? 'B' : 'A')) })

    var res = await handlers.ocrExtractParallel(mockDb, 'o1', { fileIds: ['cloud://f1', 'cloud://f2'], familyId: 'f1' })
    expect(res.code).toBe(200)
    expect(ocrPhase.mock.calls.length).toBe(2)
    expect(aiPhase.mock.calls.length).toBe(2)
    expect(res.data.results.map(function(r) { return r.fileId })).toEqual(['cloud://f1', 'cloud://f2'])
    expect(res.data.results.every(function(r) { return r.success })).toBe(true)
    expect(res.data.success_count).toBe(2)
    expect(res.data.ai_call_count).toBe(2)
    expect(res.data.tokens.total_tokens).toBe(300)
  })

  test('OCR 结果为空：标记 ocr_empty，不进入 AI', async () => {
    ocrPhase.mockResolvedValue(okOcrResult(''))
    var res = await handlers.ocrExtractParallel(mockDb, 'o1', { fileIds: ['cloud://f1'] })
    expect(res.code).toBe(200)
    expect(aiPhase.mock.calls.length).toBe(0)
    expect(res.data.results[0].success).toBe(false)
    expect(res.data.results[0].errorCode).toBe('ocr_empty')
  })

  test('OCR 异常：标记 ocr_failed，不影响其他张', async () => {
    ocrPhase.mockImplementation(function(opts) {
      if (opts.fileId === 'cloud://f2') return Promise.reject(new Error('OCR API 超时'))
      return Promise.resolve(okOcrResult('保单A'))
    })
    aiPhase.mockResolvedValue(okAiResult('A'))
    var res = await handlers.ocrExtractParallel(mockDb, 'o1', { fileIds: ['cloud://f1', 'cloud://f2'] })
    expect(res.code).toBe(200)
    expect(res.data.results[0].success).toBe(true)
    expect(res.data.results[1].success).toBe(false)
    expect(res.data.results[1].errorCode).toBe('ocr_failed')
    expect(res.data.success_count).toBe(1)
  })

  test('AI 失败隔离：单张 AI 失败不影响其他张', async () => {
    ocrPhase.mockImplementation(function(opts) { return Promise.resolve(okOcrResult(opts.fileId)) })
    aiPhase.mockImplementation(function(opts) {
      if (opts.ocrText === 'cloud://f2') return Promise.resolve({ success: false, error: 'AI返回格式错误', error_code: 'ai_format' })
      return Promise.resolve(okAiResult('A'))
    })
    var res = await handlers.ocrExtractParallel(mockDb, 'o1', { fileIds: ['cloud://f1', 'cloud://f2'] })
    expect(res.code).toBe(200)
    expect(res.data.results[0].success).toBe(true)
    expect(res.data.results[1].success).toBe(false)
    expect(res.data.results[1].errorCode).toBe('ai_format')
  })

  test('流水线重叠：首张 OCR 完成后立即进入 AI，不等全部 OCR 完成', async () => {
    var ocr2Done = false
    ocrPhase.mockImplementation(function(opts) {
      if (opts.fileId === 'cloud://f2') {
        // 第二张 OCR 延迟 50ms，模拟慢图
        return new Promise(function(resolve) {
          setTimeout(function() { ocr2Done = true; resolve(okOcrResult('保单B')) }, 50)
        })
      }
      return Promise.resolve(okOcrResult('保单A'))
    })
    var aiCalledBeforeOcr2Done = false
    aiPhase.mockImplementation(function() {
      if (!ocr2Done) aiCalledBeforeOcr2Done = true
      return Promise.resolve(okAiResult('A'))
    })
    var res = await handlers.ocrExtractParallel(mockDb, 'o1', { fileIds: ['cloud://f1', 'cloud://f2'] })
    expect(res.code).toBe(200)
    // 若流水线成立：第 1 张的 AI 应在第 2 张 OCR 完成前开始
    expect(aiCalledBeforeOcr2Done).toBe(true)
    expect(aiPhase.mock.calls.length).toBe(2)
  })
})
