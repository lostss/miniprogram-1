/**
 * ocr-confidence — 置信度计算（ocr-core 内部子模块）
 * 对外接口: calcConfidence(ocrConfInfo, aiFieldConf, aiOverall)
 */
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
  const ocrReliable = ocrHasConf && ocrConfAvg >= 0.95

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
  // 策略：AI 明确返回的 birth_date 字段置信度 < 0.9 时，强制 autoConfirmed=false。
  const birthFields = ['insured_birth_date', 'policyholder_birth_date', 'beneficiary_birth_date']
  const lowBirthField = birthFields.find(f => typeof aiFieldConf[f] === 'number' && aiFieldConf[f] < 0.9)
  // 仅 AI 明确返回的字段计入 allFieldsHigh：未在 CONF_FIELDS 中返回的字段用 aiOverall 兜底（0.70），
  // 若纳入则 allFieldsHigh 恒假，autoConfirmed 失效。
  const aiReturnedFields = CONF_FIELDS.filter(k => typeof aiFieldConf[k] === 'number')
  const allFieldsHigh = aiReturnedFields.length > 0 && aiReturnedFields.every(k => fieldConf[k] >= 0.9)
  const autoConfirmed = ocrReliable ? !lowBirthField : (allFieldsHigh && !lowBirthField)

  return { fieldConf, overallConf, ocrReliable, autoConfirmed, ocrConfAvg }
}

module.exports = { calcConfidence }
