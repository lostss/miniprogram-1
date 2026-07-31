/**
 * ocr-confidence — 置信度计算与判定（服务端与前端共用，经 sync-shared CONTRACT_FILES 同步）
 *
 * 阈值单一真相源：
 *   - CONF_THRESHOLD = 0.9        —— autoConfirmed / needsReview 判定阈值
 *   - OCR_RELIABLE_THRESHOLD = 0.95 —— OCR 识别可靠性判定（与 0.9 语义不同，勿混用）
 *
 * 对外接口:
 *   - calcConfidence(ocrConfInfo, aiFieldConf, aiOverall)
 *       → { fieldConf, overallConf, ocrReliable, autoConfirmed, ocrConfAvg }
 *   - assessPolicy(policy) → needsReview: boolean
 *       （收编前端 _isLow：auto_confirmed 权威优先，无则按 field_confidence/confidence 0.9 判定）
 */
const CONF_THRESHOLD = 0.9
const OCR_RELIABLE_THRESHOLD = 0.95

// 字段集覆盖所有影响 autoConfirmed 判定的关键字段。
// P0-1 修复：原列表缺 birth_date 系列，导致生日置信度低但其他字段高时仍 autoConfirmed=true，错误生日入库。
const CONF_FIELDS = ['product_name', 'insurance_category', 'insurance_type', 'insurance_period',
  'sum_assured', 'annual_premium', 'insured_name', 'policy_number', 'insurance_company',
  'effective_date', 'policyholder_name',
  'insured_birth_date', 'policyholder_birth_date', 'beneficiary_birth_date']

/**
 * @param {Array} ocrConfInfo — OCR 字符级置信度 [{ text, ocr_conf }]
 * @param {object} aiFieldConf — AI 字段级置信度 { fieldName: 0-1 }
 * @param {number} aiOverall — AI 整体置信度
 * @returns {{ fieldConf: object, overallConf: number, ocrReliable: boolean, autoConfirmed: boolean }}
 */
function calcConfidence(ocrConfInfo, aiFieldConf, aiOverall) {
  const ocrHasConf = ocrConfInfo.length > 0 && ocrConfInfo.some(c => c.ocr_conf > 0)
  const ocrConfAvg = ocrHasConf
    ? ocrConfInfo.reduce((s, c) => s + c.ocr_conf, 0) / ocrConfInfo.length / 100
    : 0
  const ocrReliable = ocrHasConf && ocrConfAvg >= OCR_RELIABLE_THRESHOLD

  const fieldConf = {}
  for (const k of CONF_FIELDS) {
    const aiV = aiFieldConf[k]
    if (ocrReliable) {
      fieldConf[k] = typeof aiV === 'number'
        ? Math.round((ocrConfAvg * 0.7 + aiV * 0.3) * 100) / 100
        : Math.round(ocrConfAvg * 100) / 100
    } else {
      fieldConf[k] = typeof aiV === 'number'
        ? Math.round(aiV * 100) / 100
        : Math.round(aiOverall * 100) / 100
    }
  }

  const overallConf = Math.round((ocrReliable ? ocrConfAvg : aiOverall) * 100) / 100
  // P0-1 修复：birth_date 系列字段仅在 AI 明确返回时参与 allFieldsHigh 判定。
  // 原因：保单可能本身就没有出生日期字段（OCR 未识别），此时 AI 不返回该字段置信度，
  // 若用 aiOverall 兜底会让 autoConfirmed=true 失去对错误生日的拦截作用。
  // 策略：AI 明确返回的 birth_date 字段置信度 < CONF_THRESHOLD 时，强制 autoConfirmed=false。
  const birthFields = ['insured_birth_date', 'policyholder_birth_date', 'beneficiary_birth_date']
  const lowBirthField = birthFields.find(f => typeof aiFieldConf[f] === 'number' && aiFieldConf[f] < CONF_THRESHOLD)
  // 仅 AI 明确返回的字段计入 allFieldsHigh：未在 CONF_FIELDS 中返回的字段用 aiOverall 兜底（0.70），
  // 若纳入则 allFieldsHigh 恒假，autoConfirmed 失效。
  const aiReturnedFields = CONF_FIELDS.filter(k => typeof aiFieldConf[k] === 'number')
  const allFieldsHigh = aiReturnedFields.length > 0 && aiReturnedFields.every(k => fieldConf[k] >= CONF_THRESHOLD)
  const autoConfirmed = ocrReliable ? !lowBirthField : (allFieldsHigh && !lowBirthField)

  return { fieldConf, overallConf, ocrReliable, autoConfirmed, ocrConfAvg }
}

/**
 * 保单复核判定（收编前端 _isLow，阈值与 calcConfidence 共用 CONF_THRESHOLD）：
 *   - auto_confirmed 为布尔（数据层判定结果）→ 权威优先，直接反推
 *   - 无 auto_confirmed → 逐字段 field_confidence 任一 < 0.9 即 needsReview
 *   - 无逐字段置信度 → 整体 confidence < 0.9 即 needsReview
 * @returns {boolean} needsReview
 */
function assessPolicy(p) {
  p = p || {}
  if (typeof p.auto_confirmed === 'boolean') return !p.auto_confirmed
  const fc = p.field_confidence || {}
  const keys = Object.keys(fc)
  if (keys.length > 0) {
    for (let i = 0; i < keys.length; i++) {
      if (fc[keys[i]] < CONF_THRESHOLD) return true
    }
    return false
  }
  return (p.confidence || 0) < CONF_THRESHOLD
}

// 核心字段：autoConfirmed 需值完整性（≥80% 非空）+ 置信度达标双条件
// 审计 #1：仅置信度检查会放行"AI 漏提取核心字段"→ 空值自动入库
const CORE_FIELDS = ['product_name', 'insurance_category', 'insured_name', 'sum_assured', 'effective_date']
const CORE_REQUIRED = Math.ceil(CORE_FIELDS.length * 0.8) // 5 × 0.8 = 4

/**
 * 核心字段值完整性判定（审计 #1 修正版）：
 * 每个产品需 CORE_FIELDS 中 ≥80%（≥4/5）字段提取到值，允许保单本身缺某字段/OCR 漏识 1 项
 * @param {object} contractBasic — 合同级字段（insured_name/effective_date）
 * @param {Array} products — 产品级字段（product_name/insurance_category/sum_assured）
 * @returns {boolean} 是否值完整
 */
function assessCoreCompleteness(contractBasic, products) {
  if (!products || products.length === 0) return false
  return products.every(function(product) {
    var filled = 0
    if (String(product.product_name || '').trim() !== '') filled++
    if (String(product.insurance_category || '').trim() !== '') filled++
    if (Number(product.sum_assured) > 0) filled++
    if (String(contractBasic.insured_name || '').trim() !== '') filled++
    if (String(contractBasic.effective_date || contractBasic.contract_effective_date || '').trim() !== '') filled++
    return filled >= CORE_REQUIRED
  })
}

module.exports = {
  calcConfidence,
  assessPolicy,
  assessCoreCompleteness,
  CONF_THRESHOLD,
  OCR_RELIABLE_THRESHOLD,
  CORE_FIELDS
}
