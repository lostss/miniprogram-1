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

【输入特征 — 必读】
你收到的是保单图片经 OCR 引擎识别的原始文本。保单中的表格已失去列结构，呈逐行文本：
- 表格列标题与单元格内容分离排列，需根据语义自行关联（如"险种名称"与具体产品名、"基本保险金额"与具体金额）
- 文本顺序不反映视觉布局顺序，请基于语义还原表格结构
- 可能存在 OCR 误识别、缺字、多余换行，请结合上下文判断

【提取重点】
以下字段为核心提取目标，其他信息（客服电话、地址、保单说明、页脚等）忽略：
保单号/保险合同号、保险公司、生效日期、投保人/被保人/受益人及生日、
产品名称、保险期间、交费方式/期间、保额、年保费、特别约定

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
      "contract_effective_date": 0.0,
      "policyholder_name": 0.0,
      "insured_name": 0.0,
      "beneficiary_name": 0.0,
      "product_name": 0.0,
      "insurance_period": 0.0,
      "sum_assured": 0.0,
      "payment_method": 0.0,
      "payment_period": 0.0,
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
4. field_confidence 取值 0.0-1.0，对 contract_basic 和 products 中实际输出的每个字段都必填，不可省略
5. overall_confidence = field_confidence 各字段平均值（必须填，不可空）
5.1 置信度语义：≥0.95 表示字段在 OCR 文本中明确、无歧义；0.8-0.95 表示基本可辨但有轻微噪音；<0.8 表示存在明显 OCR 错误或缺失。必须如实反映可信度，不得统一打高分
6. 多产品保单：products 数组承载所有子产品
7. result="fail" 仅当：OCR 文本既不是保单也不是现价表 / 完全无法识别
8. 日期格式：YYYY-MM-DD；金额：数字（单位元，不要带"元"字）
9. insurance_category 值必须是下列之一：寿险、重疾、医疗、意外、年金、养老、教育、投连、万能、其他
10. payment_method 值必须是下列之一：趸交、年交、半年交、季交、月交
11. 投保人=被保人：若保单未明确区分投保人和被保人，且文本中仅出现一个姓名（如仅"投保人李阳勇"），则该姓名同时填入 policyholder_name 和 insured_name
12. 特殊条款脱敏：special_agreement 中若含身份证号/银行卡号/手机号，直接用 *** 替换敏感数字段，不提取原文`

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
${ocrText || ''}

【OCR字符级置信度参考】
${confLines}

注意：
1. 低置信度字符处的字段，field_confidence 相应降低
2. 若 OCR 文本明显不是保单，返回 result="fail"，message 简要说明
3. 若无法识别任何核心字段，返回 result="fail"，message="无法识别保单信息"
4. overall_confidence 必须是 0.0-1.0 的数字`

  return { systemPrompt, userPrompt }
}

// ======================== 批量提取系统提示词 ========================
const BATCH_SYSTEM_PROMPT = `你是保单信息批量提取 AI。输入包含多张图片的 OCR 文本，每张图以【图片_N】标记分隔。你需要为每张图独立提取保单信息，输出严格 JSON 数组。

【输入特征 — 必读】
你收到的是保单图片经 OCR 引擎识别的原始文本。保单中的表格已失去列结构，呈逐行文本：
- 表格列标题与单元格内容分离排列，需根据语义自行关联（如"险种名称"与具体产品名、"基本保险金额"与具体金额）
- 文本顺序不反映视觉布局顺序，请基于语义还原表格结构
- 可能存在 OCR 误识别、缺字、多余换行，请结合上下文判断

【提取重点】
以下字段为核心提取目标，其他信息（客服电话、地址、保单说明、页脚等）忽略：
保单号/保险合同号、保险公司、生效日期、投保人/被保人/受益人及生日、
产品名称、保险期间、交费方式/期间、保额、年保费、特别约定

【单图文档类型判断】
对每张图独立判断 document_type：
- "policy" → 保单，按保单格式输出
- "cash_value" → 纯现价表，按现价表格式输出
- "mixed" → 一张图同时含保单 + 现价表，两者都输出
- "unknown" → 无法识别，该图 result="fail"

【输出格式 — JSON 数组】
顶层必须是 JSON 数组，为每张输入图片输出一个元素。每个元素结构：
[
  {
    "idx": 1,
    "document_type": "policy" | "cash_value" | "mixed" | "unknown",
    "result": "success" | "fail",
    "message": "失败原因（fail 时必填）",
    "data": {
      "contract_basic": {
        "policy_number": "", "insurance_company": "", "contract_effective_date": "",
        "policyholder_name": "", "insured_name": "", "beneficiary_name": "",
        "special_agreement": "", "insured_birth_date": "",
        "policyholder_birth_date": "", "beneficiary_birth_date": ""
      },
      "products": [
        { "product_name": "", "insurance_category": "", "insurance_type": "",
          "insurance_period": "", "sum_assured": 0, "payment_method": "",
          "payment_period": "", "annual_premium": 0 }
      ],
      "field_confidence": {
        "policy_number": 0.0, "insurance_company": 0.0, "contract_effective_date": 0.0,
        "policyholder_name": 0.0, "insured_name": 0.0, "beneficiary_name": 0.0,
        "product_name": 0.0, "insurance_period": 0.0, "sum_assured": 0.0,
        "payment_method": 0.0, "payment_period": 0.0, "annual_premium": 0.0
      },
      "overall_confidence": 0.0
    },
    "cash_value_data": {
      "header_info": { "product_name": "", "insured_name": "", "policy_number": "", "insurance_type": "" },
      "cash_values": [ { "y": 1, "v": 0, "n": "可选标注" } ],
      "overall_confidence": 0.0
    }
  }
]

document_type 为 "policy" 时只输出 data；"cash_value" 时只输出 cash_value_data；"mixed" 时两者都输出；"unknown" 时 data 和 cash_value_data 都省略。

【不可变更的核心约束】
1. 顶层必须是 JSON 数组，为每张图片输出一个对象
2. 每个对象必须带 idx 声明对应的图片编号（如【图片_3】→ idx=3）；若某张图无法提取，该元素 result="fail" 且仍保留该 idx；idx 不得重复
3. 每张图独立判断 document_type 和 result，单张图失败不影响其他图
4. 仅输出 JSON，不输出任何解释、markdown、注释
5. 字段必须使用上述名称，禁止臆造字段名
6. 字段值缺失返回空字符串 ""，数字字段缺失返回 0
7. field_confidence 取值 0.0-1.0，对 contract_basic 和 products 中实际输出的每个字段都必填；overall_confidence = 各字段平均值
7.1 置信度语义：≥0.95 表示字段明确无歧义；0.8-0.95 基本可辨但有轻微噪音；<0.8 存在明显 OCR 错误或缺失，不得统一打高分
8. 日期格式 YYYY-MM-DD；金额数字（单位元，不带"元"字）
9. insurance_category 值必须是下列之一：寿险、重疾、医疗、意外、年金、养老、教育、投连、万能、其他
10. payment_method 值必须是下列之一：趸交、年交、半年交、季交、月交
11. 投保人=被保人：若保单未明确区分且仅出现一个姓名，同时填入 policyholder_name 和 insured_name
12. cash_values 中 y=保单年度（整数），v=现金价值（元，纯数字），n=可选特殊标注
13. special_agreement 含身份证号/银行卡号/手机号时用 *** 替换敏感数字段，不提取原文`

/**
 * 构建批量提取提示词
 * @param {Array<{fileId:string, ocrText:string, ocrConfInfo:Array, t0:number, t1:number, t2:number}>} ocrResults
 * @returns {{systemPrompt: string, userPrompt: string}}
 */
function buildBatchExtractionPrompt(ocrResults) {
  const systemPrompt = BATCH_SYSTEM_PROMPT

  const blocks = ocrResults.map(function(item, i) {
    var idx = i + 1
    var ocrText = item.ocrText || ''
    var confs = (item.ocrConfInfo || [])
      .filter(function(c) { return c && typeof c.ocr_conf === 'number' && c.ocr_conf < 80 })
      .slice(0, 10)
    var confLines = confs.length > 0
      ? confs.map(function(c) { return '  "' + c.text + '" ' + c.ocr_conf + '%' }).join('\n')
      : '  无字符级置信度信息'

    return '【图片_' + idx + '】\n' + ocrText + '\n\n[图片_' + idx + ' 字符级置信度参考]\n' + confLines
  })

  var userPrompt = '请从以下多张图片的 OCR 文本中独立提取每张图的保单信息，按系统提示词约定的 JSON 数组格式返回。每张图独立判断 document_type 和 result。\n\n' + blocks.join('\n\n')

  return { systemPrompt: systemPrompt, userPrompt: userPrompt }
}

module.exports = { buildExtractionPrompt, SYSTEM_PROMPT, buildBatchExtractionPrompt, BATCH_SYSTEM_PROMPT }
