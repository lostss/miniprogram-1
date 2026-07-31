/**
 * aiExtractBatchPhase 单元测试
 * mock safeCallChat + callChat，验证编排逻辑
 */
jest.mock('wx-server-sdk', () => require('./__mocks__/cloudSDKMock'))

const { aiExtractBatchPhase } = require('../cloudfunctions/_shared/ocr-core')

// mock buildBatchExtractionPrompt
function mockBuildPrompt(ocrResults) {
  return { systemPrompt: 'SYS', userPrompt: 'USER ' + ocrResults.length }
}

// 构造 mock safeCallChat，返回指定的 JSON 数组
function makeSafeCallChat(aiResponseArray) {
  return async function(messages, callChat, ctx, opts) {
    return {
      text: JSON.stringify(aiResponseArray),
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 }
    }
  }
}

//  noop callChat（实际由 safeCallChat mock 接管）
var noopCallChat = async function() { return { text: '', usage: {} } }

var mockDeps = {
  cloud: {}, db: { collection: function() { return { add: function() { return Promise.resolve({}) } } } },
  openid: 'o1', familyId: 'f1',
  buildBatchExtractionPrompt: mockBuildPrompt,
  safeCallChat: makeSafeCallChat([]),
  callChat: noopCallChat,
  AI_TIMEOUT: { OCR: 15000 }
}

describe('aiExtractBatchPhase', () => {
  test('单次调用：3张图全部成功，返回3个 policies 结果', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '保单B', ocrConfInfo: [] },
      { fileId: 'cloud://f3', ocrText: '保单C', ocrConfInfo: [] }
    ]
    var aiResp = [
      { idx: 1, document_type: 'policy', result: 'success', data: { contract_basic: { policy_number: 'P001', policyholder_name: '张三', insured_name: '张三' }, products: [{ product_name: '重疾险', sum_assured: 500000, annual_premium: 5000 }], field_confidence: { policy_number: 0.9, insurance_company: 0.9, policyholder_name: 0.9, insured_name: 0.9, sum_assured: 0.9, annual_premium: 0.9 }, overall_confidence: 0.9 } },
      { idx: 2, document_type: 'policy', result: 'success', data: { contract_basic: { policy_number: 'P002' }, products: [{ product_name: '医疗险' }], field_confidence: {}, overall_confidence: 0.8 } },
      { idx: 3, document_type: 'policy', result: 'success', data: { contract_basic: {}, products: [{ product_name: '意外险' }], field_confidence: {}, overall_confidence: 0.85 } }
    ]
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(aiResp) })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results.length).toBe(3)
    expect(res.results[0].success).toBe(true)
    expect(res.results[0].policies.length).toBe(1)
    expect(res.results[0].policies[0].product_name).toBe('重疾险')
    expect(res.results[1].success).toBe(true)
    expect(res.results[2].success).toBe(true)
    expect(res.splitUsed).toBe(false)
    expect(res.aiCallCount).toBe(1)
    expect(res.successCount).toBe(3)
    expect(res.failCount).toBe(0)
  })

  test('部分失败：某张图 result=fail，其他图正常返回', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '非保单', ocrConfInfo: [] }
    ]
    var aiResp = [
      { idx: 1, document_type: 'policy', result: 'success', data: { contract_basic: {}, products: [{ product_name: '寿险' }], field_confidence: {}, overall_confidence: 0.85 } },
      { idx: 2, document_type: 'unknown', result: 'fail', message: '无法识别保单信息' }
    ]
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(aiResp) })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(true)
    expect(res.results[1].success).toBe(false)
    expect(res.results[1].errorCode).toBe('ai_extract_failed')
    expect(res.results[1].error).toBe('无法识别保单信息')
    expect(res.successCount).toBe(1)
    expect(res.failCount).toBe(1)
  })

  test('AI 返回数组长度不匹配：缺失的 idx 标记 ai_length_mismatch', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '保单B', ocrConfInfo: [] },
      { fileId: 'cloud://f3', ocrText: '保单C', ocrConfInfo: [] }
    ]
    // AI 只返回 2 个（缺 idx=2）
    var aiResp = [
      { idx: 1, document_type: 'policy', result: 'success', data: { contract_basic: {}, products: [{ product_name: 'A' }], field_confidence: {}, overall_confidence: 0.8 } },
      { idx: 3, document_type: 'policy', result: 'success', data: { contract_basic: {}, products: [{ product_name: 'C' }], field_confidence: {}, overall_confidence: 0.8 } }
    ]
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(aiResp) })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(true)
    expect(res.results[1].success).toBe(false)
    expect(res.results[1].errorCode).toBe('ai_length_mismatch')
    expect(res.results[2].success).toBe(true)
  })

  test('AI 返回非数组 JSON：所有图标记 ai_format', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] }
    ]
    var deps = Object.assign({}, mockDeps, {
      safeCallChat: async function() { return { text: '{"result":"success"}', usage: {} } }
    })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(false)
    expect(res.results[0].errorCode).toBe('ai_format')
  })

  test('safeCallChat 抛错：所有图标记 ai_batch_failed', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '保单B', ocrConfInfo: [] }
    ]
    var deps = Object.assign({}, mockDeps, {
      safeCallChat: async function() { var e = new Error('AI 5xx'); e.code = 'ERR_BAD_RESPONSE'; throw e }
      })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(false)
    expect(res.results[0].errorCode).toBe('ai_batch_failed')
    expect(res.results[1].success).toBe(false)
    expect(res.results[1].errorCode).toBe('ai_batch_failed')
  })

  test('超限拆分：总字符数超过 84000 触发对半拆分，aiCallCount=2', async () => {
    // 构造 2 张图，每张 50000 字符（总 100000 > 84000）
    var longText = 'A'.repeat(50000)
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: longText, ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: longText, ocrConfInfo: [] }
    ]
    // 每次 AI 调用返回单图成功
    var callCount = 0
    var deps = Object.assign({}, mockDeps, {
      safeCallChat: async function() {
        callCount++
        return {
          text: JSON.stringify([{ idx: 1, document_type: 'policy', result: 'success', data: { contract_basic: {}, products: [{ product_name: 'P' + callCount }], field_confidence: {}, overall_confidence: 0.8 } }]),
          usage: { total_tokens: 300 }
        }
      }
    })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.splitUsed).toBe(true)
    expect(res.aiCallCount).toBe(2)
    expect(res.results.length).toBe(2)
    expect(res.results[0].success).toBe(true)
    expect(res.results[1].success).toBe(true)
    expect(callCount).toBe(2)
  })

  test('现价表提取：document_type=cash_value 时返回 cashValueData', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '现价表', ocrConfInfo: [] }
    ]
    var aiResp = [
      {
        idx: 1, document_type: 'cash_value', result: 'success',
        cash_value_data: {
          header_info: { product_name: '阳光人寿i保', insured_name: '李阳勇' },
          cash_values: [{ y: 1, v: 0 }, { y: 2, v: 5800 }],
          overall_confidence: 0.88
        }
      }
    ]
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(aiResp) })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(true)
    expect(res.results[0].cashValueData).toBeTruthy()
    expect(res.results[0].cashValueData.product_name).toBe('阳光人寿i保')
    expect(res.results[0].cashValueData.cash_values.length).toBe(2)
  })
})
