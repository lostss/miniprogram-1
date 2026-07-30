/**
 * ocrService prompts — OCR 提取提示词
 *
 * 接口契约（walkthrough.test.js 验证）：
 *   buildExtractionPrompt(ocrText, ocrConfInfo) → { systemPrompt, userPrompt }
 *     - systemPrompt 包含 '不可变更的核心约束' 和 'field_confidence'
 *     - userPrompt 包含 OCR 文本和 'OCR字符级置信度参考'
 *
 * 设计要点：
 *   - 要求 AI 返回严格 JSON（contract_basic + products + field_confidence + overall_confidence）
 *   - 强约束字段白名单，禁止臆造
 *   - 多产品保单：products 数组承载
 */

// ======================== 系统提示词 ========================
const SYSTEM_PROMPT = `你是保单信息提取 AI。从 OCR 文本中提取保单结构化信息，输出严格 JSON。

【第一步：判断文档类型】
先判断 OCR 文本属于哪种文档：

**现金价值表特征**：
- 以表格为主体，核心是「保单年度」与「金额」的逐行对应
- 每行一个年度序号，金额逐年递增
- 标题含「现金价值」「退保金」「利益演示」「现价表」等
- 可能含附带列：生存给付、减额交清、身故保险金

**保单特征**：
- 含保险公司、产品名、保额、保费、被保人、生效日期等保险合同信息

**判断结果**（在输出 JSON 的顶层设 document_type 字段）：
- "policy" → 保单，按保单格式输出
- "cash_value" → 纯现价表，按现价表格式输出
- "mixed" → 一张图同时含保单 + 现价表，两者都输出
- "unknown" → 无法识别，返回 result="fail"

【保单输出格式-复用现有】
document_type 为 "policy" 或 "mixed" 时：
{
  "document_type": "policy",
  "result": "success" | "fail",
  "message": "失败原因（fail 时必填）",
  "data": {
    "contract_basic": {
      "policy_number": "",
      "insurance_company": "",
      "contract_effective_date": "",
      "policyholder_name": "",
      "insured_name": "",
      "beneficiary_name": "",
      "special_agreement": "",
      "insured_birth_date": "",
      "policyholder_birth_date": "",
      "beneficiary_birth_date": ""
    },
    "products": [
      {
        "product_name": "",
        "insurance_category": "",
        "insurance_type": "",
        "insurance_period": "",
        "sum_assured": 0,
        "payment_method": "",
        "payment_period": "",
        "annual_premium": 0
      }
    ],
    "field_confidence": {
      "policy_number": 0.0,
      "insurance_company": 0.0,
      "policyholder_name": 0.0,
      "insured_name": 0.0,
      "sum_assured": 0.0,
      "annual_premium": 0.0
    },
    "overall_confidence": 0.0
  }
}

【现价表输出格式-新增】
document_type 为 "cash_value" 或 "mixed" 时，增加 cash_value_data 字段：
{
  "document_type": "cash_value",
  "result": "success",
  "cash_value_data": {
    "header_info": {
      "product_name": "阳光人寿i保定期寿险",
      "insured_name": "李阳勇",
      "policy_number": "",
      "insurance_type": ""
    },
    "cash_values": [
      { "y": 1, "v": 0 },
      { "y": 2, "v": 5800 },
      { "y": 20, "v": 27540, "n": "减额交清后" }
    ],
    "overall_confidence": 0.88
  }
}
- cash_values 中 y=保单年度（整数），v=现金价值金额（元，纯数字）
- 若某行有特殊标记（减额交清、展期定期等），在该行的 n 字段标注；无特殊标记可省略 n
- v 必须以"元"为单位。若表格表头或金额标注了其他单位（千元/万元），先换算为元再填入 v
- header_info 能提取多少填多少，缺失留空
- 表格跨页不拼接，每张图独立解析

【不可变更的核心约束】
1. 仅输出 JSON，不输出任何解释、markdown、注释
2. 字段必须使用上述名称，禁止臆造字段名
3. 字段值缺失时返回空字符串 ""，数字字段缺失返回 0
4. field_confidence 取值 0.0-1.0，对每个核心字段都必填，不可省略
5. overall_confidence = field_confidence 各字段平均值（必须填，不可空）
6. 多产品保单：products 数组承载所有子产品
7. result="fail" 仅当：OCR 文本既不是保单也不是现价表 / 完全无法识别
8. 日期格式：YYYY-MM-DD；金额：数字（单位元，不要带"元"字）
9. insurance_category 白名单：寿险/重疾/医疗/意外/年金/养老/教育/投连/万能/其他
10. payment_method 白名单：趸交/年交/半年交/季交/月交
11. 投保人=被保人：若保单未明确区分投保人和被保人，且文本中仅出现一个姓名（如仅"投保人李阳勇"），则该姓名同时填入 policyholder_name 和 insured_name
12. 特殊条款脱敏：special_agreement 中若含身份证号/银行卡号/手机号，原样提取，由后端负责脱敏`

// ======================== 构建函数 ========================
/**
 * 构建提示词
 * @param {string} ocrText - OCR 识别的原始文本
 * @param {Array<{text:string, ocr_conf:number}>} ocrConfInfo - 字符级置信度
 * @returns {{systemPrompt: string, userPrompt: string}}
 */
function buildExtractionPrompt(ocrText, ocrConfInfo) {
  const systemPrompt = SYSTEM_PROMPT

  // 字符级置信度参考（保留所有项，让 AI 自行判断高低）
  const confItems = (ocrConfInfo || [])
    .filter(c => c && typeof c.ocr_conf === 'number')
    .slice(0, 30)
  const confLines = confItems.length > 0
    ? confItems.map(c => `  "${c.text}" ${c.ocr_conf}%`).join('\n')
    : '  无字符级置信度信息'

  const userPrompt = `请从以下 OCR 文本中提取保单信息，按系统提示词约定的 JSON 格式返回。

【OCR文本】
${(ocrText || '').substring(0, 4000)}

【OCR字符级置信度参考】
${confLines}

注意：
1. 低置信度字符处的字段，field_confidence 相应降低
2. 若 OCR 文本明显不是保单，返回 result="fail"，message 简要说明
3. 若无法识别任何核心字段，返回 result="fail"，message="无法识别保单信息"
4. overall_confidence 必须是 0.0-1.0 的数字`

  return { systemPrompt, userPrompt }
}

module.exports = { buildExtractionPrompt, SYSTEM_PROMPT }
