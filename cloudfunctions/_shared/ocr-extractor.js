/**
 * ocr-extractor — OCR 识别 + AI 提取（ocr-core 内部子模块）
 * 对外接口: ocrRecognize(fileId, cloud), aiExtract(ocrText, ocrConfInfo, { buildExtractionPrompt, safeCallChat, callChat, cloud, db, openid, familyId })
 *
 * _parseAIJSON 已抽到 _shared/parse-ai-json.js，与 reportAI 共用同一事实源。
 * 此处保留 re-export 以向后兼容 ocr-core 等内部消费方。
 */
const { OCR, AI, AI_TIMEOUT } = require('./config')
const { parseAIJSON: _parseAIJSON } = require('./parse-ai-json')
const { withRetry } = require('./retry')
const { logOperation } = require('./logSeam')

let _ocrClient = null
function _getOcrClient() {
  if (_ocrClient) return _ocrClient
  const ocrModule = require('tencentcloud-sdk-nodejs-ocr').ocr.v20181119
  const secretId = process.env.TENCENT_SECRET_ID || process.env.TENCENTCLOUD_SECRETID
  const secretKey = process.env.TENCENT_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY
  if (!secretId || !secretKey) throw new Error('缺少 TENCENT_SECRET_ID/TENCENT_SECRET_KEY 环境变量')
  _ocrClient = new ocrModule.Client({ credential: { secretId, secretKey }, region: OCR.REGION, profile: { httpProfile: { endpoint: OCR.ENDPOINT } } })
  return _ocrClient
}

async function ocrRecognize(tempFileURL) {
  const client = _getOcrClient()
  try {
    // 架构审计第 14 轮候选 #3：重试委托 withRetry（原内联 setTimeout 1000ms）
    return await withRetry(
      async () => {
        const ocrRes = await client.GeneralFastOCR({ ImageUrl: tempFileURL })
        if (ocrRes && ocrRes.TextDetections && ocrRes.TextDetections.length > 0) {
          const text = ocrRes.TextDetections.map(td => td.DetectedText || '').join('\n').trim()
          const confs = ocrRes.TextDetections.map(td => ({ text: (td.DetectedText || '').substring(0, 30), ocr_conf: td.Confidence || 0 }))
          return { text, confs }
        }
        return { text: '', confs: [] }
      },
      { maxAttempts: 2, delayMs: 1000, label: 'ocr-extractor recognize' }
    )
  } catch (e) {
    console.error('[ocr-extractor] OCR 重试后仍失败:', e.message)
    return { text: '', confs: [] }
  }
}

/**
 * @returns {{ success: boolean, extractRes?: object, tokens?: object, error_code?: string }}
 */
async function aiExtract(ocrText, ocrConfInfo, deps) {
  const { buildExtractionPrompt, safeCallChat, callChat, cloud, db, openid, familyId, AI_TIMEOUT } = deps

  const { systemPrompt, userPrompt } = buildExtractionPrompt(ocrText, ocrConfInfo)

  // 架构审计第 14 轮候选 #3：重试委托 withRetry
  // 原逻辑：首次解析失败 → 等 600ms → 用截断 ocrText 重试。fn 内根据 attempt 切换 messages，
  // 解析失败转为 ai_format error 由 retryOn 识别；safeCallChat 抛错则不重试（与原逻辑一致）。
  try {
    const result = await withRetry(
      async (attempt) => {
        const messages = attempt === 0
          ? [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
          : [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: ocrText.substring(0, 4000) }
          ]
        const sessionId = (attempt === 0 ? 'ocr_' : 'ocr_retry_') + Date.now().toString(36)
        const res = await safeCallChat(
          messages,
          callChat,
          { cloud, db, openid, familyId, sessionId, model: AI.OCR_MODEL, action: 'ocr_extract', skipInjection: true, skipOutputAudit: true, skipContentSafety: true },
          { maxTokens: AI.OCR_MAX_TOKENS, temperature: AI.OCR_TEMPERATURE, responseFormat: { type: 'json_object' }, timeoutMs: AI_TIMEOUT.OCR, cacheKey: 'ocr-extract-v1' }
        )
        const parsed = _parseAIJSON(res.text)
        if (!parsed) {
          // 诊断日志：AI 返回内容但 JSON 解析失败时，记录前 500 字符
          console.error('[ocr-extractor] ai_format, raw text (first 500):', String(res.text || '').substring(0, 500))
          const err = new Error('ai_format')
          err.code = 'ai_format'
          throw err
        }
        return { parsed, usage: res.usage }
      },
      {
        // DeepSeek JSON Output 模式有概率返回空 content（官方已知问题）
        // DeepSeek 并发 2500，重试无 429 风险，对 ai_empty 启用 1 次重试
        maxAttempts: 2,
        delayMs: 500,
        retryOn: function(e) { return e.code === 'ai_empty' },
        label: 'ocr-extractor aiExtract'
      }
    )
    return { success: true, extractRes: result.parsed, tokens: result.usage }
  } catch (e) {
    logOperation(db, {
      openid, familyId: familyId || undefined, action: 'ocr_ai_extract',
      result: { status: 'fail', summary: 'AI提取失败', errorCode: (e.code || 'ai_exception') },
      meta: { ocrTextLen: String(ocrText || '').length, error: (e && e.message || '') }
    }).catch(function () {})
    // Bug-10 修复：默认错误码与 logOperation 保持一致为 'ai_exception'，
    // 避免非格式错误（如超时/服务异常）被误标为 'ai_format'，干扰上游重试策略
    return { success: false, error_code: (e.code || 'ai_exception') }
  }
}

module.exports = { ocrRecognize, aiExtract, _parseAIJSON }
