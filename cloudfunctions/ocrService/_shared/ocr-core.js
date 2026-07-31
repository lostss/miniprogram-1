/**
 * ocr-core v2.0 — 薄编排层，委托给内部子模块
 * - ocr-extractor: OCR 识别 + AI 提取
 * - ocr-confidence: 置信度计算
 * - member-matcher: 成员匹配（统一导出）
 */

const { ocrRecognize, aiExtract } = require('./ocr-extractor')
const { calcConfidence } = require('./ocr-confidence')
const { matchPoliciesToMembers } = require('./member-matcher')
const { AI_TIMEOUT } = require('./config')
// 架构审计第 6 轮：日志写入统一走 logSeam.logOperation
const { logOperation: opLog } = require('./logSeam')
const { canonCat } = require('./thresholds')

function _toNum(v) {
  if (typeof v === 'number') return v
  if (v === null || v === undefined) return 0
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''))
  return isNaN(n) ? 0 : n
}

/**
 * 构建保单对象（架构审计 I：从 processOneImage 内联外移）
 * 单一职责：AI 提取结果 → 保单记录数组，含 ID 生成/字段映射/置信度附注
 *
 * @param {array} products - AI 提取的产品数组
 * @param {object} contractBasic - 合同基本信息
 * @param {object} conf - { overallConf, fieldConf, ocrReliable, autoConfirmed }
 * @returns {array} 保单对象数组
 */
function buildPolicyFromExtract(products, contractBasic, conf) {
  const { overallConf, fieldConf, ocrReliable, autoConfirmed } = conf
  return (products || []).map(product => ({
    id: 'pol_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    member_id: '',
    policy_number: contractBasic.policy_number || '',
    insurer: contractBasic.insurance_company || '',
    effective_date: contractBasic.contract_effective_date || '',
    policyholder_name: contractBasic.policyholder_name || '',
    insured_name: contractBasic.insured_name || '',
    beneficiary_name: contractBasic.beneficiary_name || '',
    special_agreement: contractBasic.special_agreement || '',
    product_name: product.product_name || '',
    insurance_category: canonCat(product.insurance_category || ''),
    insurance_type: product.insurance_type || '',
    insurance_period: product.insurance_period || '',
    sum_assured: _toNum(product.sum_assured),
    payment_method: product.payment_method || '',
    payment_period: product.payment_period || '',
    annual_premium: _toNum(product.annual_premium),
    confidence: overallConf,
    field_confidence: fieldConf,
    confidence_source: ocrReliable ? 'ocr' : 'ai',
    auto_confirmed: autoConfirmed,
    insured_birth_date: contractBasic.insured_birth_date || '',
    policyholder_birth_date: contractBasic.policyholder_birth_date || '',
    beneficiary_birth_date: contractBasic.beneficiary_birth_date || ''
  }))
}

/**
 * @param {object} opts
 * @param opts.cloud - wx-server-sdk cloud 实例
 * @param opts.db - 数据库实例
 * @param opts.buildExtractionPrompt - prompts.js 导出的 prompt 构建函数
 * @param opts.fileId - 云存储文件 ID
 * @param opts.familyId
 * @param opts.openid
 * @param opts.source - 'ocr' | 'ocr_batch' | 'ocr_anon'
 * @returns {{ success: boolean, policiesCount: number, policies?: array, error?: string, error_code?: string }}
 */
// ---- 拆分接口：OCR 阶段（可并发，无 429 风险） ----
async function ocrPhase({ cloud, fileId, openid, familyId }) {
  const t0 = Date.now()
  const tempRes = await cloud.getTempFileURL({ fileList: [fileId] })
  const tempFile = tempRes.fileList && tempRes.fileList[0]
  if (!tempFile || !tempFile.tempFileURL) {
    throw new Error('获取图片临时链接失败')
  }
  const t1 = Date.now()
  const { text: ocrText, confs: ocrConfInfo } = await ocrRecognize(tempFile.tempFileURL)
  const t2 = Date.now()
  return { ocrText, ocrConfInfo, t0, t1, t2, fileId }
}

// ---- 拆分接口：AI 提取 + 构建（需错峰，有 429 风险） ----
async function aiPhase({ ocrText, ocrConfInfo, fileId, t0, t1, t2, cloud, db, buildExtractionPrompt, familyId, openid }) {
  if (!ocrText || ocrText.length === 0) {
    opLog(db, { action: 'ocr_recognize', openid, familyId, result: { status: 'fail', summary: 'OCR文字为空', errorCode: 'ocr_empty' } }).catch(() => {})
    return { success: false, fileId, policiesCount: 0, error: 'OCR识别结果为空', error_code: 'ocr_empty' }
  }

  // ---- Step 3: AI 提取（委托 ocr-extractor） ----
  // 架构审计 I：删除预构建 systemPrompt（原仅 retry 用，但 retry 已改为内部自行构建）
  const aiDeps = { cloud, db, openid, familyId, buildExtractionPrompt, AI_TIMEOUT,
    safeCallChat: require('./ai-gateway').safeCallChat,
    callChat: require('./ai-client').callChat
  }

  const extractResult = await aiExtract(ocrText, ocrConfInfo, aiDeps)
  if (!extractResult.success || !extractResult.extractRes) {
    const errorCode = extractResult.error_code || 'ai_exception'
    // 按 errorCode 区分用户可见文案，避免 429/超时/异常被误报为"格式错误"
    const errorText = (
      errorCode === 'ai_format' ? 'AI返回格式错误' :
      errorCode === '429' || errorCode === 'RATE_LIMIT' ? 'AI服务繁忙，请稍后重试' :
      errorCode === 'TIMEOUT' || errorCode === 'CHAT_TIMEOUT' ? 'AI服务超时，请重试' :
      'AI服务异常，请重试'
    )
    opLog(db, { action: 'ocr_recognize', openid, familyId, result: { status: 'fail', summary: errorText, errorCode } }).catch(() => {})
    return { success: false, policiesCount: 0, error: errorText, error_code: errorCode }
  }

  let { extractRes, tokens } = extractResult

  if (extractRes.result !== 'success') {
    // 移除 aiRetryIfFailed：原重试会再发一次 AI 请求，触发 TokenHub 排队放大耗时
    // 非保单/格式异常直接返回错误，由前端用户手动重试
    opLog(db, { action: 'ocr_recognize', openid, familyId, result: { status: 'fail', summary: extractRes.message || '非保单图片', errorCode: 'not_policy' } }).catch(() => {})
    return { success: false, policiesCount: 0, error: extractRes.message || '非保单图片', error_code: 'not_policy' }
  }
  const t3 = Date.now()

  // ---- Step 4: 置信度计算（委托 ocr-confidence） ----
  const data = extractRes.data || {}
  const contractBasic = data.contract_basic || {}
  const aiFieldConf = data.field_confidence || {}
  const aiOverall = typeof data.overall_confidence === 'number'
    ? data.overall_confidence
    : (Object.keys(aiFieldConf).length > 0
        ? Object.values(aiFieldConf).reduce((s, v) => s + v, 0) / Object.keys(aiFieldConf).length
        : 0.7)

  const { fieldConf, overallConf, ocrReliable, autoConfirmed } = calcConfidence(ocrConfInfo, aiFieldConf, aiOverall)

  // ---- 构建保单对象（委托 buildPolicyFromExtract） ----
  const products = data.products || []
  const docType = extractRes.document_type || 'policy'

  const durations = { getTempUrl: t1 - t0, ocrApi: t2 - t1, aiExtract: t3 - t2, total: t3 - t0 }

  const newPolicies = buildPolicyFromExtract(products, contractBasic, { overallConf, fieldConf, ocrReliable, autoConfirmed })

  // 现价表数据提取（document_type=cash_value 或 mixed）
  let cashValueData = null
  if ((docType === 'cash_value' || docType === 'mixed') && extractRes.cash_value_data) {
    const cvd = extractRes.cash_value_data
    const hi = cvd.header_info || {}
    const cvArr = (cvd.cash_values || []).map(cv => {
      const row = { y: cv.y, v: _toNum(cv.v) }
      if (cv.n) row.n = cv.n
      return row
    })
    cashValueData = {
      product_name: hi.product_name || (products.length > 0 ? products[0].product_name : '') || '',
      insured_name: hi.insured_name || contractBasic.insured_name || '',
      policy_number: hi.policy_number || contractBasic.policy_number || '',
      insurance_type: hi.insurance_type || '',
      cash_values: cvArr,
      overall_confidence: typeof cvd.overall_confidence === 'number' ? cvd.overall_confidence : overallConf
    }
  }

  opLog(db, {
    action: 'ocr_recognize', openid, familyId,
    result: { status: 'ok', summary: '识别' + newPolicies.length + '个产品，类型:' + docType },
    meta: { total: newPolicies.length, docType, hasCashValue: !!cashValueData, autoConfirmed, durations, tokens: tokens || {} }
  }).catch(() => {})

  return { success: true, policiesCount: newPolicies.length, policies: newPolicies, document_type: docType, cashValueData }
}

// 兼容旧调用：整体流程 = OCR 阶段 + AI 阶段
async function processOneImage({ cloud, db, buildExtractionPrompt, fileId, familyId, openid, source }) {
  const ocr = await ocrPhase({ cloud, fileId, openid, familyId })
  if (!ocr.ocrText) return { success: false, policiesCount: 0, error: 'OCR识别结果为空', error_code: 'ocr_empty' }
  return aiPhase({ ocrText: ocr.ocrText, ocrConfInfo: ocr.ocrConfInfo, fileId: ocr.fileId, t0: ocr.t0, t1: ocr.t1, t2: ocr.t2, cloud, db, buildExtractionPrompt, familyId, openid })
}

// ---- 批量 AI 提取（拼接 N 张图为 1 次调用，超限对半拆分） ----
const { parseAIJSON: _parseBatchJSON } = require('./parse-ai-json')

/**
 * 单次批量 AI 调用（不拆分）
 * @returns {{ aiResponse, tokens, aiCallCount }}
 */
async function _callBatchAI(ocrResults, deps) {
  const { buildBatchExtractionPrompt, safeCallChat, callChat, cloud, db, openid, familyId, AI_TIMEOUT } = deps
  const { AI } = require('./config')
  const { systemPrompt, userPrompt } = buildBatchExtractionPrompt(ocrResults)
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
  const sessionId = 'ocr_batch_' + Date.now().toString(36)
  let res
  try {
    res = await safeCallChat(
      messages, callChat,
      { cloud, db, openid, familyId, sessionId, model: AI.OCR_MODEL, action: 'ocr_extract_batch', skipInjection: true, skipOutputAudit: true, skipContentSafety: true },
      { maxTokens: AI.OCR_BATCH_MAX_TOKENS, temperature: AI.OCR_BATCH_TEMPERATURE, responseFormat: { type: 'json_object' }, timeoutMs: AI.OCR_BATCH_TIMEOUT, cacheKey: 'ocr-batch-v1' }
    )
  } catch (e) {
    const status = (e && e.response && (e.response.status || e.response.statusCode)) || null
    console.error('[ocr-core] _callBatchAI AI调用失败:', {
      message: e && e.message, code: e && e.code, status: status,
      responseData: e && e.response && e.response.data ? JSON.stringify(e.response.data).substring(0, 500) : null
    })
    if (status === 429 || (e && e.code === '429') || /429/.test(e && e.message)) {
      const err = new Error('AI服务繁忙(429)')
      err.code = '429'
      throw err
    }
    throw e
  }
  const parsed = _parseBatchJSON(res.text)
  // 兼容 AI 返回 {"results": [...]} / {"data": [...]} / {"policies": [...]} 包裹格式
  let arr = parsed
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    arr = parsed.results || parsed.data || parsed.policies || parsed.list || null
  }
  if (!Array.isArray(arr)) {
    console.error('[ocr-core] _callBatchAI ai_format: 原始返回前800字符=', (res.text || '').substring(0, 800))
    console.error('[ocr-core] _callBatchAI ai_format: parsed=', JSON.stringify(parsed).substring(0, 300))
    const err = new Error('ai_format')
    err.code = 'ai_format'
    throw err
  }
  return { aiResponse: arr, tokens: res.usage || {}, aiCallCount: 1 }
}

/**
 * 构建单图结果对象（从 AI 返回的单个元素）
 * ocrResult._batchIdx 由调用方注入（1-based）
 */
function _buildSingleResult(item, ocrResult) {
  const idx = ocrResult._batchIdx
  if (item.result !== 'success') {
    return { idx: idx, fileId: ocrResult.fileId, success: false, error: item.message || 'AI提取失败', errorCode: 'ai_extract_failed' }
  }
  const docType = item.document_type || 'policy'
  const data = item.data || {}
  const contractBasic = data.contract_basic || {}
  const aiFieldConf = data.field_confidence || {}
  const aiOverall = typeof data.overall_confidence === 'number'
    ? data.overall_confidence
    : (Object.keys(aiFieldConf).length > 0
        ? Object.values(aiFieldConf).reduce((s, v) => s + v, 0) / Object.keys(aiFieldConf).length
        : 0.7)
  const { fieldConf, overallConf, ocrReliable, autoConfirmed } = calcConfidence(ocrResult.ocrConfInfo, aiFieldConf, aiOverall)
  const products = data.products || []
  const newPolicies = buildPolicyFromExtract(products, contractBasic, { overallConf, fieldConf, ocrReliable, autoConfirmed })

  let cashValueData = null
  if ((docType === 'cash_value' || docType === 'mixed') && item.cash_value_data) {
    const cvd = item.cash_value_data
    const hi = cvd.header_info || {}
    const cvArr = (cvd.cash_values || []).map(cv => {
      const row = { y: cv.y, v: _toNum(cv.v) }
      if (cv.n) row.n = cv.n
      return row
    })
    cashValueData = {
      product_name: hi.product_name || (products.length > 0 ? products[0].product_name : '') || '',
      insured_name: hi.insured_name || contractBasic.insured_name || '',
      policy_number: hi.policy_number || contractBasic.policy_number || '',
      insurance_type: hi.insurance_type || '',
      cash_values: cvArr,
      overall_confidence: typeof cvd.overall_confidence === 'number' ? cvd.overall_confidence : overallConf
    }
  }
  return { idx: idx, fileId: ocrResult.fileId, success: true, policies: newPolicies, cashValueData: cashValueData, documentType: docType }
}

/**
 * 组装结果：AI 返回数组与输入 ocrResults 对齐，校验 idx/长度
 */
function _assembleResults(ocrResults, aiResponse) {
  var byIdx = {}
  for (var i = 0; i < aiResponse.length; i++) {
    var item = aiResponse[i]
    if (item && typeof item.idx === 'number') byIdx[item.idx] = item
  }
  var results = []
  for (var j = 0; j < ocrResults.length; j++) {
    var ocr = ocrResults[j]
    var expectedIdx = j + 1
    var item = byIdx[expectedIdx]
    if (!item) {
      results.push({ idx: expectedIdx, fileId: ocr.fileId, success: false, error: 'AI返回缺失该图', errorCode: 'ai_length_mismatch' })
    } else {
      results.push(_buildSingleResult(item, ocr))
    }
  }
  return results
}

function _summarizeBatch(results, tokens, aiCallCount, totalDurationMs, splitUsed) {
  var successCount = 0, failCount = 0
  for (var i = 0; i < results.length; i++) {
    if (results[i].success) successCount++
    else failCount++
  }
  return { results: results, totalDurationMs: totalDurationMs, splitUsed: splitUsed, aiCallCount: aiCallCount, tokens: tokens, successCount: successCount, failCount: failCount }
}

function _mergeTokens(t1, t2) {
  if (!t1 && !t2) return {}
  var a = t1 || {}, b = t2 || {}
  return {
    prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
    completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0),
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0)
  }
}

/**
 * 批量 AI 提取编排（含对半拆分降级）
 * @param {Array} ocrResults - [{ fileId, ocrText, ocrConfInfo, ... }]
 * @param {object} deps - { cloud, db, openid, familyId, buildBatchExtractionPrompt, safeCallChat, callChat, AI_TIMEOUT }
 * @returns {{ results, totalDurationMs, splitUsed, aiCallCount, tokens, successCount, failCount }}
 */
async function aiExtractBatchPhase(ocrResults, deps) {
  const t0 = Date.now()
  const { AI } = require('./config')
  const totalChars = ocrResults.reduce((s, r) => s + (r.ocrText || '').length, 0)

  // 标记每项的 1-based idx（用于 _buildSingleResult 读取）
  ocrResults = ocrResults.map((r, i) => Object.assign({}, r, { _batchIdx: i + 1 }))

  if (totalChars <= AI.OCR_BATCH_MAX_CHARS || ocrResults.length === 1) {
    // 未超限：1 次调用
    try {
      const { aiResponse, tokens, aiCallCount } = await _callBatchAI(ocrResults, deps)
      const results = _assembleResults(ocrResults, aiResponse)
      const t1 = Date.now()
      return _summarizeBatch(results, tokens, aiCallCount, t1 - t0, false)
    } catch (e) {
      const errorCode = e.code === 'ai_format' ? 'ai_format' : (e.code === '429' ? '429' : 'ai_batch_failed')
      const results = ocrResults.map(r => ({ idx: r._batchIdx, fileId: r.fileId, success: false, error: (e && e.message) || 'AI异常', errorCode: errorCode }))
      const t1 = Date.now()
      return _summarizeBatch(results, {}, 1, t1 - t0, false)
    }
  }

  // 超限：对半拆分
  const mid = Math.ceil(ocrResults.length / 2)
  const left = ocrResults.slice(0, mid)
  const right = ocrResults.slice(mid)

  const [leftRes, rightRes] = await Promise.all([
    aiExtractBatchPhase(left, deps),
    aiExtractBatchPhase(right, deps)
  ])

  // 重新编号 right 部分 idx 并合并（right 的 idx 是 1..N-mid，需偏移到 mid+1..N）
  const adjustedRight = rightRes.results.map(r => ({ ...r, idx: r.idx + mid }))
  const mergedResults = leftRes.results.concat(adjustedRight)
  const mergedTokens = _mergeTokens(leftRes.tokens, rightRes.tokens)
  const mergedAiCallCount = leftRes.aiCallCount + rightRes.aiCallCount
  const t1 = Date.now()
  return _summarizeBatch(mergedResults, mergedTokens, mergedAiCallCount, t1 - t0, true)
}

module.exports = { processOneImage, ocrPhase, aiPhase, aiExtractBatchPhase, matchPoliciesToMembers, buildPolicyFromExtract, _toNum }
