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

// 现价表片段拦截（2026-09-09）：单独上传的现价表需年度自 1 起连续且行数达标，
// 否则视为截图残留片段不提取（提示词第零步的确定性兜底）
const CASH_VALUE_MIN_ROWS = 5
function _isCashValueComplete(cvArr) {
  if (!Array.isArray(cvArr) || cvArr.length < CASH_VALUE_MIN_ROWS) return false
  for (let i = 0; i < cvArr.length; i++) {
    if (Number(cvArr[i].y) !== i + 1) return false
  }
  return true
}

/**
 * PolicyExtractor.extractOne — AI 原始响应 → Policy 对象（深模块，R2 候选 1）
 * 单图路径（aiPhase）唯一转换入口，杜绝字段漂移。
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
  // 保留 AI 原始判定：mixed 需同时走"保单构建"与"现价表提取"两条路，
  // 而 docType 最终要降级为 policy（同图以保单主体为主），故先存原始值
  const rawDocType = extractRes.document_type || 'policy'
  const policies = buildPolicyFromExtract(products, contractBasic, { overallConf, fieldConf, ocrReliable, autoConfirmed })

  // 现价表数据提取（document_type = cash_value 或 mixed）
  // 2026-09-11 调整：mixed 不再"无条件丢弃现价表"。原策略（2026-09-09 片段拦截）为防
  // 保单页脚的残留现价表被当成有效表入库，采取了"宁可丢也不错收"的一刀切——代价是真表被误杀：
  // 保单正页与完整现价表同屏（PDF 连续截图很常见）时 AI 会判 mixed → 现价表被丢弃 →
  // 报告「现价/回本」列永久显示 '-'、回本节点不生成，且没有二次补偿路径。
  // 现改为 cash_value 与 mixed 走同一标准：AI 判"完整现价表" + 代码完整性阈值（年度自 1 起
  // 连续、行数 ≥ CASH_VALUE_MIN_ROWS）双满足才收。残留片段仍会被该阈值拦下，原有防线未放松。
  let cashValueData = null
  if ((rawDocType === 'cash_value' || rawDocType === 'mixed') && extractRes.cash_value_data) {
    const cvd = extractRes.cash_value_data
    const hi = cvd.header_info || {}
    const cvArr = (cvd.cash_values || []).map(cv => {
      const row = { y: cv.y, v: _toNum(cv.v) }
      if (cv.n) row.n = cv.n
      return row
    })
    if (_isCashValueComplete(cvArr)) {
      cashValueData = {
        product_name: hi.product_name || (products.length > 0 ? products[0].product_name : '') || '',
        insured_name: hi.insured_name || contractBasic.insured_name || '',
        policy_number: hi.policy_number || contractBasic.policy_number || '',
        insurance_type: hi.insurance_type || '',
        cash_values: cvArr,
        overall_confidence: typeof cvd.overall_confidence === 'number' ? cvd.overall_confidence : overallConf
      }
    }
  }
  // mixed：同图以保单主体为主 → docType 降级为 policy（影响下游分组与展示，保持历史行为）
  const docType = rawDocType === 'mixed' ? 'policy' : rawDocType
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
// tempFileURL 可选：调用方已批量换取临时链接时传入，跳过单张 getTempFileURL（省 N-1 次 API 往返）
async function ocrPhase({ cloud, fileId, openid, familyId, tempFileURL }) {
  const t0 = Date.now()
  let url = tempFileURL
  if (!url) {
    const tempRes = await cloud.getTempFileURL({ fileList: [fileId] })
    const tempFile = tempRes.fileList && tempRes.fileList[0]
    if (!tempFile || !tempFile.tempFileURL) {
      throw new Error('获取图片临时链接失败')
    }
    url = tempFile.tempFileURL
  }
  const t1 = Date.now()
  const { text: ocrText, confs: ocrConfInfo, error_code: ocrErrorCode } = await ocrRecognize(url)
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

// ---- 批量 AI 提取已收敛（2026-08-30）----
// aiExtractBatch 单图路径统一走 aiPhase（DeepSeek 直连），批量拼接编排（_callBatchAI/aiExtractBatchPhase）已删除。
// 备份文件已随 docs 归档清理（2026-09-04）；原实现见 git 历史。

module.exports = { ocrPhase, aiPhase, matchPoliciesToMembers, buildPolicyFromExtract, extractOne, _toNum }
