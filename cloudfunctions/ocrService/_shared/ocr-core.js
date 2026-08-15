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
 * 构建保单对象
 * 单一职责：AI 提取结果 → 保单记录数组，含 ID 生成/字段映射/置信度附注
 *
 * @param {array} products - AI 提取的产品数组
 * @param {object} contractBasic - 合同基本信息
 * @param {object} conf - { overallConf, fieldConf, ocrReliable, autoConfirmed }
 * @returns {array} 保单对象数组
 */
// 日期字段格式校验：防 AI 输出完整身份证号等非日期文本被误存为生日（审计 #2）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function _cleanDate(v) {
  const s = String(v || '').trim()
  return DATE_RE.test(s) ? s : ''
}

function buildPolicyFromExtract(products, contractBasic, conf) {
  const { overallConf, fieldConf, ocrReliable, autoConfirmed } = conf
  // 审计 #1：autoConfirmed 需 置信度达标 && 核心字段值完整（≥4/5），防 AI 漏提取 → 空值自动入库
  const { assessCoreCompleteness } = require('./ocr-confidence')
  const finalAuto = autoConfirmed && assessCoreCompleteness(contractBasic, products)
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
    auto_confirmed: finalAuto,
    insured_birth_date: _cleanDate(contractBasic.insured_birth_date),
    policyholder_birth_date: _cleanDate(contractBasic.policyholder_birth_date),
    beneficiary_birth_date: _cleanDate(contractBasic.beneficiary_birth_date)
  }))
}

/**
 * PolicyExtractor.extractOne — AI 原始响应 → Policy 对象（深模块，R2 候选 1）
 * 单图路径（aiPhase）与批量单图路径（aiExtractBatchPhase）共用同一转换，杜绝字段漂移。
 * 内部：aiOverall 兜底 → calcConfidence → buildPolicyFromExtract → cashValueData
 * @param {object} extractRes - AI 解析结果（{ result, document_type, data, cash_value_data, message }）
 * @param {array} ocrConfInfo - OCR 字符级置信度
 * @returns {{ success: boolean, policies?, cashValueData?, docType?, autoConfirmed?, overallConf?, error?, errorCode? }}
 */
function extractOne(extractRes, ocrConfInfo) {
  if (!extractRes || extractRes.result !== 'success') {
    return { success: false, error: (extractRes && extractRes.message) || 'AI提取失败', errorCode: 'ai_extract_failed' }
  }
  const data = extractRes.data || {}
  const contractBasic = data.contract_basic || {}
  const aiFieldConf = data.field_confidence || {}
  const aiOverall = typeof data.overall_confidence === 'number'
    ? data.overall_confidence
    : (Object.keys(aiFieldConf).length > 0
        ? Object.values(aiFieldConf).reduce((s, v) => s + v, 0) / Object.keys(aiFieldConf).length
        : 0.7)

  const { fieldConf, overallConf, ocrReliable, autoConfirmed } = calcConfidence(ocrConfInfo, aiFieldConf, aiOverall)
  const products = data.products || []
  const docType = extractRes.document_type || 'policy'
  const policies = buildPolicyFromExtract(products, contractBasic, { overallConf, fieldConf, ocrReliable, autoConfirmed })

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
  return { success: true, policies: policies, cashValueData: cashValueData, docType: docType, autoConfirmed: autoConfirmed, overallConf: overallConf }
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
  const { text: ocrText, confs: ocrConfInfo, error_code: ocrErrorCode } = await ocrRecognize(tempFile.tempFileURL)
  const t2 = Date.now()
  return { ocrText, ocrConfInfo, ocrErrorCode, t0, t1, t2, fileId }
}

// ---- 拆分接口：AI 提取 + 构建（需错峰，有 429 风险） ----
async function aiPhase({ ocrText, ocrConfInfo, ocrErrorCode, fileId, t0, t1, t2, cloud, db, buildExtractionPrompt, familyId, openid, traceId }) {
  // OCR 服务异常（识别接口重试后仍失败）与"未识别到文字"区分：前者提示重试，后者提示换图
  if (ocrErrorCode === 'ocr_service_error') {
    opLog(db, { action: 'ocr_recognize', openid, familyId, result: { status: 'fail', summary: 'OCR服务异常', errorCode: 'ocr_service_error' } }).catch(() => {})
    return { success: false, fileId, policiesCount: 0, error: 'OCR 服务异常，请稍后重试', error_code: 'ocr_service_error' }
  }
  if (!ocrText || ocrText.length === 0) {
    opLog(db, { action: 'ocr_recognize', openid, familyId, result: { status: 'fail', summary: 'OCR文字为空', errorCode: 'ocr_empty' } }).catch(() => {})
    return { success: false, fileId, policiesCount: 0, error: 'OCR识别结果为空', error_code: 'ocr_empty' }
  }

  // ---- Step 3: AI 提取（委托 ocr-extractor） ----
  // 架构审计 I：删除预构建 systemPrompt（原仅 retry 用，但 retry 已改为内部自行构建）
  // DeepSeek 直连模式：USE_DIRECT=true 时走 callChatDirect，绕过 TokenHub 限流（并发 2500）
  const { USE_DIRECT } = require('./config').AI
  const aiClient = require('./ai-client')
  const callFn = USE_DIRECT ? aiClient.callChatDirect : aiClient.callChat
  const aiDeps = { cloud, db, openid, familyId, buildExtractionPrompt, AI_TIMEOUT, traceId,
    safeCallChat: require('./ai-gateway').safeCallChat,
    callChat: callFn
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

  // ---- Step 4: 置信度计算 + 保单构建（委托 PolicyExtractor.extractOne，R2 候选 1） ----
  const durations = { getTempUrl: t1 - t0, ocrApi: t2 - t1, aiExtract: t3 - t2, total: t3 - t0 }
  const ex = extractOne(extractRes, ocrConfInfo)
  const docType = ex.docType
  const newPolicies = ex.policies
  const cashValueData = ex.cashValueData
  const autoConfirmed = ex.autoConfirmed

  opLog(db, {
    action: 'ocr_recognize', openid, familyId,
    result: { status: 'ok', summary: '识别' + newPolicies.length + '个产品，类型:' + docType },
    meta: { total: newPolicies.length, docType, hasCashValue: !!cashValueData, autoConfirmed, durations, tokens: tokens || {} }
  }).catch(() => {})

  return { success: true, policiesCount: newPolicies.length, policies: newPolicies, document_type: docType, cashValueData, tokens: tokens || {} }
}

// ---- 批量 AI 提取（aiExtractBatch：batch prompt 单次调用，前端分流后仅服务单图） ----
const { parseAIJSON: _parseBatchJSON } = require('./parse-ai-json')
const { is429 } = require('./ai-error')

/**
 * 单次批量 AI 调用（不拆分）
 * @returns {{ aiResponse, tokens, aiCallCount }}
 */
async function _callBatchAI(ocrResults, deps) {
  const { buildBatchExtractionPrompt, safeCallChat, callChat, cloud, db, openid, familyId } = deps
  const { AI } = require('./config')
  // 用户决策（2026-08）：AI 识别失败重试无论张数均走 DeepSeek 直连
  // （DeepSeek 并发 2500 更稳，避免 TokenHub hy3 排队/限流下重试继续失败）
  // ——单图路径（aiExtractBatch）首次仍走 hy3，重试切 DeepSeek；多图路径本就全走 DeepSeek
  const { callChatDirect } = require('./ai-client')
  const { systemPrompt, userPrompt } = buildBatchExtractionPrompt(ocrResults)
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
  const sessionId = 'ocr_batch_' + Date.now().toString(36)

  // AI 返回空 content（已知问题）时启用 1 次重试；重试走 DeepSeek 直连
  const maxAttempts = 2
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res
    try {
      res = await safeCallChat(
        messages, attempt === 1 ? callChat : callChatDirect,
        { cloud, db, openid, familyId, sessionId, traceId: deps.traceId, model: AI.OCR_MODEL, action: 'ocr_extract_batch', skipInjection: true, skipOutputAudit: true, skipContentSafety: true },
        // 不使用 response_format: json_object（DeepSeek JSON 模式有概率返回空 content）
        // 改用普通模式 + prompt 严格约束 JSON 输出
        // 不传 prompt_cache_key：CloudBase SDK 路径不支持客户端缓存控制，固定键+内容多变反而反复写缓存
        { maxTokens: AI.OCR_BATCH_MAX_TOKENS, temperature: AI.OCR_BATCH_TEMPERATURE, timeoutMs: AI.OCR_BATCH_TIMEOUT }
      )
    } catch (e) {
      // 429 定位：兼容 SDK 错误多种结构（e.response / e.statusCode / e.data / e.headers），
      // 捕获 TokenHub 具体限流码（429001 并发 / 429002 RPM / 429003 TPM）与 Retry-After 头
      const status = (e && ((e.response && (e.response.status || e.response.statusCode)) || e.statusCode || e.status)) || null
      const body = (e && (e.data || (e.response && e.response.data))) || null
      const headers = (e && (e.headers || (e.response && e.response.headers))) || null
      console.error('[ocr-core] _callBatchAI AI调用失败:', {
        message: e && e.message,
        code: e && e.code,
        status: status,
        errorCode: (body && body.error && (body.error.code || body.error.upstream_code)) || null,
        retryAfter: (headers && headers['retry-after']) || null,
        responseData: body ? JSON.stringify(body).substring(0, 500) : null,
        requestId: (e && e.requestId) || null,
        reqChars: ocrResults.reduce((s, r) => s + (r.ocrText || '').length, 0)
      })
      if (is429(e)) {
        const err = new Error('AI服务繁忙(429)')
        err.code = '429'
        throw err
      }
      // ai_empty 重试（DeepSeek JSON 模式已知问题）
      if (e && e.code === 'ai_empty' && attempt < maxAttempts) {
        console.warn('[ocr-core] _callBatchAI ai_empty, 重试 attempt ' + (attempt + 1))
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      throw e
    }

    const parsed = _parseBatchJSON(res.text)
    // 兼容 AI 返回格式（R2 候选 2：前端分流后 aiExtractBatch 仅服务单图，object 包裹数组分支已删除）：
    //   1. [{...}] — 标准数组
    //   2. {"idx":1, "document_type":"policy", ...} — 单张图时 AI 直接返回单个对象，包装为单元素数组
    let arr = parsed
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      arr = (parsed.idx != null) && (parsed.document_type || parsed.result) ? [parsed] : null
    }
    if (!Array.isArray(arr)) {
      console.error('[ocr-core] _callBatchAI ai_format: 原始返回前800字符=', (res.text || '').substring(0, 800))
      console.error('[ocr-core] _callBatchAI ai_format: parsed=', JSON.stringify(parsed).substring(0, 300))
      const err = new Error('ai_format')
      err.code = 'ai_format'
      throw err
    }
    return { aiResponse: arr, tokens: res.usage || {}, aiCallCount: attempt }
  }
  // 安全兜底（正常流程不可达：循环内要么 return 要么 throw）
  throw new Error('ai_batch_failed')
}

/**
 * 批量 AI 提取编排（单图收敛，R2 候选 2）
 * 前端分流后 aiExtractBatch 仅服务 1 张图（>1 张走 aiExtractParallel）：
 * 保留 batch prompt（JSON 数组契约）调用方式，结果经 PolicyExtractor.extractOne 转换。
 * @param {Array} ocrResults - [{ fileId, ocrText, ocrConfInfo, ... }]（长度恒为 1）
 * @param {object} deps - { cloud, db, openid, familyId, buildBatchExtractionPrompt, safeCallChat, callChat, AI_TIMEOUT }
 * @returns {{ results, totalDurationMs, splitUsed, aiCallCount, tokens, successCount, failCount }}
 */
async function aiExtractBatchPhase(ocrResults, deps) {
  const t0 = Date.now()
  const ocr = ocrResults[0]
  try {
    const { aiResponse, tokens, aiCallCount } = await _callBatchAI(ocrResults, deps)
    const item = aiResponse[0]
    if (!item) {
      const err = new Error('ai_format')
      err.code = 'ai_format'
      throw err
    }
    const ex = extractOne(item, ocr.ocrConfInfo)
    const t1 = Date.now()
    if (ex.success) {
      return {
        results: [{ idx: 1, fileId: ocr.fileId, success: true, policies: ex.policies, cashValueData: ex.cashValueData, documentType: ex.docType, tokens: tokens }],
        totalDurationMs: t1 - t0, splitUsed: false, aiCallCount: aiCallCount, tokens: tokens, successCount: 1, failCount: 0
      }
    }
    return {
      results: [{ idx: 1, fileId: ocr.fileId, success: false, error: ex.error, errorCode: ex.errorCode }],
      totalDurationMs: t1 - t0, splitUsed: false, aiCallCount: aiCallCount, tokens: tokens, successCount: 0, failCount: 1
    }
  } catch (e) {
    const { classifyAIError } = require('./ai-error')
    const cls = classifyAIError(e)
    // S3-1 修复：保留 CHAT_TIMEOUT / ai_empty 区分，与 aiPhase 错误码映射对称
    // 原实现把 CHAT_TIMEOUT 和 ai_empty 统统压成 ai_batch_failed，前端无法显示"AI服务超时"或"AI返回空"
    const errorCode = ['ai_format', 'ai_empty', 'CHAT_TIMEOUT', '429'].includes(cls) ? cls : 'ai_batch_failed'
    const t1 = Date.now()
    return {
      results: [{ idx: 1, fileId: ocr.fileId, success: false, error: (e && e.message) || 'AI异常', errorCode: errorCode }],
      totalDurationMs: t1 - t0, splitUsed: false, aiCallCount: 1, tokens: {}, successCount: 0, failCount: 1
    }
  }
}

module.exports = { ocrPhase, aiPhase, aiExtractBatchPhase, matchPoliciesToMembers, buildPolicyFromExtract, extractOne, _toNum }
