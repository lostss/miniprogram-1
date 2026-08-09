/**
 * aiExtractBatchPhase + PolicyExtractor.extractOne 单元测试
 * R2 候选 1+2：批量路径单图化（前端分流后 aiExtractBatch 仅服务 1 张），转换收敛到 extractOne
 */

const { aiExtractBatchPhase, extractOne } = require('../cloudfunctions/_shared/ocr-core')

// mock buildBatchExtractionPrompt
function mockBuildPrompt(ocrResults) {
  return { systemPrompt: 'SYS', userPrompt: 'USER ' + ocrResults.length }
}

// 构造 mock safeCallChat，返回指定的原始文本
function makeSafeCallChat(text) {
  return async function() {
    return { text: text, usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } }
  }
}

// noop callChat（实际由 safeCallChat mock 接管）
var noopCallChat = async function() { return { text: '', usage: {} } }

var mockDeps = {
  cloud: {}, db: { collection: function() { return { add: function() { return Promise.resolve({}) } } } },
  openid: 'o1', familyId: 'f1',
  buildBatchExtractionPrompt: mockBuildPrompt,
  safeCallChat: makeSafeCallChat('[]'),
  callChat: noopCallChat,
  AI_TIMEOUT: { OCR: 15000 }
}

function okAiItem(idx) {
  return {
    idx: idx, document_type: 'policy', result: 'success',
    data: {
      contract_basic: { policy_number: 'P00' + idx },
      products: [{ product_name: '重疾险', sum_assured: 500000, annual_premium: 5000 }],
      field_confidence: { sum_assured: 0.9 }, overall_confidence: 0.9
    }
  }
}

describe('PolicyExtractor.extractOne', () => {
  test('成功：返回 policies + cashValueData(null) + docType', () => {
    const ex = extractOne(okAiItem(1), [])
    expect(ex.success).toBe(true)
    expect(ex.policies.length).toBe(1)
    expect(ex.policies[0].product_name).toBe('重疾险')
    expect(ex.cashValueData).toBeNull()
    expect(ex.docType).toBe('policy')
    expect(typeof ex.autoConfirmed).toBe('boolean')
  })

  test('失败：result=fail → 返回 error/errorCode', () => {
    const ex = extractOne({ idx: 1, result: 'fail', message: '无法识别保单信息' }, [])
    expect(ex.success).toBe(false)
    expect(ex.errorCode).toBe('ai_extract_failed')
    expect(ex.error).toBe('无法识别保单信息')
  })

  test('现价表：document_type=cash_value → 返回 cashValueData', () => {
    const ex = extractOne({
      idx: 1, document_type: 'cash_value', result: 'success',
      cash_value_data: {
        header_info: { product_name: '阳光人寿i保', insured_name: '李阳勇' },
        cash_values: [{ y: 1, v: 0 }, { y: 2, v: 5800 }],
        overall_confidence: 0.88
      }
    }, [])
    expect(ex.success).toBe(true)
    expect(ex.cashValueData.product_name).toBe('阳光人寿i保')
    expect(ex.cashValueData.cash_values.length).toBe(2)
  })

  test('aiOverall 兜底：无 overall_confidence 且有字段置信度 → 取字段均值', () => {
    const ex = extractOne({
      idx: 1, result: 'success', document_type: 'policy',
      data: { contract_basic: {}, products: [{ product_name: 'A' }], field_confidence: { a: 0.9, b: 0.7 } }
    }, [])
    expect(ex.success).toBe(true)
    expect(ex.overallConf).toBe(0.8)
  })
})

describe('aiExtractBatchPhase（单图）', () => {
  test('单图成功：AI 返回单元素数组 → 1 个 policies 结果', async () => {
    var ocrResults = [{ fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] }]
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(JSON.stringify([okAiItem(1)])) })
    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results.length).toBe(1)
    expect(res.results[0].success).toBe(true)
    expect(res.results[0].policies.length).toBe(1)
    expect(res.results[0].policies[0].product_name).toBe('重疾险')
    expect(res.splitUsed).toBe(false)
    expect(res.aiCallCount).toBe(1)
    expect(res.successCount).toBe(1)
    expect(res.failCount).toBe(0)
  })

  test('AI 返回单对象（无数组包裹）→ 包装后成功', async () => {
    var ocrResults = [{ fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] }]
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(JSON.stringify(okAiItem(1))) })
    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(true)
    expect(res.results[0].policies[0].product_name).toBe('重疾险')
  })

  test('AI 返回 result=fail → 标记 ai_extract_failed', async () => {
    var ocrResults = [{ fileId: 'cloud://f1', ocrText: '非保单', ocrConfInfo: [] }]
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(JSON.stringify([{ idx: 1, result: 'fail', message: '无法识别保单信息' }])) })
    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(false)
    expect(res.results[0].errorCode).toBe('ai_extract_failed')
    expect(res.results[0].error).toBe('无法识别保单信息')
    expect(res.failCount).toBe(1)
  })

  test('AI 返回非数组 JSON → ai_format', async () => {
    var ocrResults = [{ fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] }]
    var deps = Object.assign({}, mockDeps, { safeCallChat: async function() { return { text: '{"result":"success"}', usage: {} } } })
    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(false)
    expect(res.results[0].errorCode).toBe('ai_format')
  })

  test('AI 返回空数组 → ai_format', async () => {
    var ocrResults = [{ fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] }]
    var res = await aiExtractBatchPhase(ocrResults, mockDeps)
    expect(res.results[0].success).toBe(false)
    expect(res.results[0].errorCode).toBe('ai_format')
  })

  test('safeCallChat 抛错 → ai_batch_failed', async () => {
    var ocrResults = [{ fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] }]
    var deps = Object.assign({}, mockDeps, {
      safeCallChat: async function() { var e = new Error('AI 5xx'); e.code = 'ERR_BAD_RESPONSE'; throw e }
    })
    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(false)
    expect(res.results[0].errorCode).toBe('ai_batch_failed')
  })

  test('现价表单图：返回 cashValueData', async () => {
    var ocrResults = [{ fileId: 'cloud://f1', ocrText: '现价表', ocrConfInfo: [] }]
    var aiItem = {
      idx: 1, document_type: 'cash_value', result: 'success',
      cash_value_data: {
        header_info: { product_name: '阳光人寿i保', insured_name: '李阳勇' },
        cash_values: [{ y: 1, v: 0 }, { y: 2, v: 5800 }],
        overall_confidence: 0.88
      }
    }
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(JSON.stringify([aiItem])) })
    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(true)
    expect(res.results[0].cashValueData).toBeTruthy()
    expect(res.results[0].cashValueData.product_name).toBe('阳光人寿i保')
    expect(res.results[0].cashValueData.cash_values.length).toBe(2)
  })
})
