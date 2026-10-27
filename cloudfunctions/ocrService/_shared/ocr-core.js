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

// 原文片段白名单：只保留这些键（与 applyEvidenceCheck 的 EVIDENCE_FIELDS 一致）
function _pickEvidence(ev) {
  if (!ev || typeof ev !== 'object') return {}
  const out = {}
  EVIDENCE_FIELDS.forEach(function(k) {
    const v = ev[k]
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 200)
  })
  return out
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
    // 2026-10-27：三个"只有原文明确写出才提取"的字段（prompt 已按此约束）。
    // 越界一律归 0（= 未采集），**不夹到边界** —— 夹到 12 会把"13 号"变成"12 月"，是错值而非缺值。
    beneficiary_ratio: (function(v) {
      var n = Number(v)
      return n > 0 && n <= 100 ? Math.round(n) : 0
    })(contractBasic.beneficiary_ratio),
    payment_month: (function(v) {
      var n = Number(v)
      return n >= 1 && n <= 12 ? Math.round(n) : 0
    })(contractBasic.payment_month),
    special_agreement: contractBasic.special_agreement || '',
    product_name: product.product_name || '',
    insurance_category: canonCat(product.insurance_category || ''),
    insurance_type: product.insurance_type || '',
    insurance_period: product.insurance_period || '',
    sum_assured: _toNum(product.sum_assured),
    payment_method: product.payment_method || '',
    payment_period: product.payment_period || '',
    annual_premium: _toNum(product.annual_premium),
    // 年金年领（元）：只有储蓄型有意义；非年金/原文未写 → 0
    annuity_payout: _toNum(product.annuity_payout),
    confidence: overallConf,
    field_confidence: fieldConf,
    confidence_source: ocrReliable ? 'ocr' : 'ai',
    auto_confirmed: finalAuto,
    // 2026-10-18：保存 AI 摘录的原文片段（仅字符串、仅非空），供报告侧"数字从哪句话读来的"追溯。
    // 只留关键 4 键，其它键丢弃 —— 避免 prompt 漂移时把任意内容落库。
    field_evidence: _pickEvidence(contractBasic && conf && conf.fieldEvidence),
    insured_birth_date: _cleanDate(contractBasic.insured_birth_date),
    policyholder_birth_date: _cleanDate(contractBasic.policyholder_birth_date),
    beneficiary_birth_date: _cleanDate(contractBasic.beneficiary_birth_date)
  }))
}

/**
 * 数值可对齐校验（2026-10-17）
 *
 * 动机：`calcConfidence` 在 OCR 字符置信度 ≥0.95 时算出的字段分是 `0.7*ocr + 0.3*ai`，
 * 必然 ≥0.965 —— **必过 0.9 的待核对阈值**。也就是说：OCR 文本明明写着"保额 30 万"，
 * 而 AI 输出成 3000000 时，置信度体系**不会报警**，错值直接静默入库。
 * 金额错一位 → 缺口、保费占比、建议全部错，这是整条链路里最贵的错误类型。
 *
 * 做法：把 AI 给出的金额（元）换算成"原文可能出现的写法"（元 / 万 / 千），
 * 在 OCR 文本里按**数字边界**查找；一个都对不上 → 把该字段置信度压到 0.5，
 * 让既有机制把它送进「待核对」（`lowFields` 会显示具体字段名）。
 *
 * 为什么不用"AI 自评 + 权重"继续加固：自评是模型的主观分，这里校验的是**事实一致性**
 * （这个数字在原文里到底有没有）。前者救不了模型抄错，后者能。
 *
 * 误判取舍：宁可偶尔多标一条"待核对"，也不让错金额静默入库（错误不对称原则）。
 * 因此只在"确实找不到任何写法"时才降分，找不到文本 / 值非正数时直接放行。
 */
function _normNumText(s) {
  return String(s || '')
    .replace(/[０-９]/g, function(d) { return String.fromCharCode(d.charCodeAt(0) - 0xFEE0) }) // 全角数字
    .replace(/[，,、\s]/g, '') // 千分位与空白：300,000 / 30 万 都能对上
}

/** OCR 文本里是否能找到该金额（yuan）的任一写法 */
function _hasNumericEvidence(ocrText, yuan) {
  const t = _normNumText(ocrText)
  if (!t) return true // 空文本由 ocr_empty 统一拦截，这里不重复判
  const n = Number(yuan)
  if (!isFinite(n) || n <= 0) return true // 缺值/异常值不归这里管（completeness 负责）

  const cands = [String(n)]
  // 万元写法（含小数）：1.2 万 / 30 万 —— 保单原文普遍用"万"，只比"元"会大面积误判
  if (n >= 10000) cands.push((Math.round((n / 10000) * 100) / 100).toString())
  // 千元写法：30 千
  if (n % 1000 === 0) cands.push(String(n / 1000))
  for (let i = 0; i < cands.length; i++) {
    // 数字边界：避免 30 命中 300 / 3000
    const re = new RegExp('(^|[^0-9])' + cands[i].replace(/\./g, '\\.') + '($|[^0-9])')
    if (re.test(t)) return true
  }
  return false
}

/** 对产品的金额类字段做原文对齐；对不上的压分并返回字段名 */
function applyNumericEvidence(products, fieldConf, ocrText) {
  const NUMERIC_FIELDS = ['sum_assured', 'annual_premium']
  const out = Object.assign({}, fieldConf)
  const flagged = []
  ;(products || []).forEach(function(p) {
    NUMERIC_FIELDS.forEach(function(f) {
      const v = _toNum(p && p[f])
      if (!(v > 0)) return
      if (_hasNumericEvidence(ocrText, v)) return
      const cur = Number(out[f] == null ? 1 : out[f])
      out[f] = Math.min(isFinite(cur) ? cur : 1, 0.5)
      if (flagged.indexOf(f) === -1) flagged.push(f)
    })
  })
  return { fieldConf: out, flagged: flagged }
}

/**
 * 期间字段的"原文存在性"校验（2026-10-18）
 *
 * 为什么单独做：`insurance_period` / `payment_period` 是**文字型**字段，最容易出现
 * "20年交" 与 "保障20年" 混淆、"终身" 与 "至70岁" 误读。它们不像金额有数字边界可比，
 * 而一旦读错，甘特图的条长、缴费期斜纹段、时间线的「保障期满/交费期满」节点全错 ——
 * 但页面不报错，只是画错。
 *
 * 做法：字段值（归一后）必须能在 OCR 文本里找到；找不到时退化为
 * "数字+单位" 或 "终身" 这类 token 匹配（原文常有"缴费期间：20年（20次交）"的写法）。
 * 找不到 → 置信度压到 0.5 → 进待核对。
 *
 * 已知局限（可接受）：token 匹配是"全文任意位置出现"，无法确认它属于哪一栏。
 * 但它拦的是**彻底不存在**的期间（如把 30年 读成 50年），那种情况一定找不到。
 */
const PERIOD_FIELDS = ['insurance_period', 'payment_period']
function _textEvidenceOk(ocrText, value) {
  const hay = _normEvidence(ocrText)
  const v = _normEvidence(value)
  if (!hay || !v) return true
  if (hay.indexOf(v) !== -1) return true
  const tokens = String(value).match(/\d+\s*(?:年|岁|个月|月|日)|终身/g) || []
  if (!tokens.length) return false
  return tokens.every(function(t) { return hay.indexOf(_normEvidence(t)) !== -1 })
}

function applyPeriodEvidence(products, ocrText, fieldConf) {
  const out = Object.assign({}, fieldConf)
  const flagged = []
  ;(products || []).forEach(function(p) {
    PERIOD_FIELDS.forEach(function(f) {
      const v = p && p[f]
      if (typeof v !== 'string' || !v.trim()) return // 没值不判（缺失由 completeness 负责）
      if (_textEvidenceOk(ocrText, v)) return
      const cur = Number(out[f] == null ? 1 : out[f])
      out[f] = Math.min(isFinite(cur) ? cur : 1, 0.5)
      if (flagged.indexOf(f) === -1) flagged.push(f)
    })
  })
  return { fieldConf: out, flagged: flagged }
}

/**
 * field_evidence 校验（2026-10-18）
 *
 * 上一层的置信度仍含"AI 自评"成分 —— 主观分救不了"模型抄错但很自信"。
 * 真正可靠的判据是：**这句话在原文里到底有没有**。
 * 因此让 AI 对 4 个关键字段（保额 / 保费 / 生效日 / 保单号）摘录原文片段，
 * 由程序逐字回查，两条基本规则：
 *   ① 片段在 OCR 文本里找不到 → 编造引用 → 该字段降级为待核对
 *   ② 片段找到了，但字段值不在片段内 → 值与引用不匹配 → 同样降级
 *   ③ 没给片段 → 本层不判（金额另有 `applyNumericEvidence` 做"值在不在原文"的独立校验）
 *
 * 为什么不强制"每个字段都必须有片段"：prompt 遵从度不是 100%，强硬制会把
 * 正常识别大面积打成待核对，用户会直接忽略这个标记 —— 那等于防线失效。
 */
const EVIDENCE_FIELDS = ['sum_assured', 'annual_premium', 'effective_date', 'policy_number']
function _normEvidence(s) {
  return String(s || '')
    .replace(/[０-９]/g, function(d) { return String.fromCharCode(d.charCodeAt(0) - 0xFEE0) })
    // 空白/千分位 + **中英文标点**一律去掉：AI 摘录时经常把全角"："写成半角，
    // 若按原样比会把真引用误判成编造（测试已覆盖这个 case）。
    .replace(/[，,、\s：:]/g, '')
}
function _digits(s) { return String(s || '').replace(/[^0-9]/g, '') }

function applyEvidenceCheck(products, contractBasic, fieldEvidence, ocrText, fieldConf) {
  const out = Object.assign({}, fieldConf)
  const flagged = []
  const ev = (fieldEvidence && typeof fieldEvidence === 'object') ? fieldEvidence : null
  if (!ev) return { fieldConf: out, flagged: flagged }
  const hay = _normEvidence(ocrText)

  const valueFor = function(f) {
    if (f === 'effective_date') return String((contractBasic && contractBasic.contract_effective_date) || '')
    if (f === 'policy_number') return String((contractBasic && contractBasic.policy_number) || '')
    const p0 = (products && products[0]) || {}
    return f === 'sum_assured' ? (p0.sum_assured || 0) : (p0.annual_premium || 0)
  }

  EVIDENCE_FIELDS.forEach(function(f) {
    const raw = ev[f]
    if (typeof raw !== 'string') return
    const quote = _normEvidence(raw)
    if (quote.length < 2) return // 空串/过于碎片：当作没给
    const v = valueFor(f)
    if (v === undefined || v === null || v === '' || v === 0) return // 没值不归这里管

    let bad = false
    if (hay.indexOf(quote) === -1) {
      bad = true // ① 编造引用：这段文字原文里根本没有
    } else if (f === 'sum_assured' || f === 'annual_premium') {
      bad = !_hasNumericEvidence(raw, Number(v)) // ② 值不在它自己引用的那段里
    } else if (f === 'effective_date') {
      const dv = _digits(v)
      bad = !!dv && _digits(raw).indexOf(dv) === -1 // 日期按数字串比（2024-01-15 ↔ 2024年01月15日）
    } else {
      bad = _normEvidence(v) !== '' && quote.indexOf(_normEvidence(v)) === -1
    }

    if (!bad) return
    const cur = Number(out[f] == null ? 1 : out[f])
    out[f] = Math.min(isFinite(cur) ? cur : 1, 0.5)
    flagged.push(f)
  })
  return { fieldConf: out, flagged: flagged }
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
 * 页脚残表判据（2026-09-12，确定性复核）
 *
 * 存在的问题：AI 的"完整现价表"判定（年度自 1 起连续 ≥5 行）对"保单正页页脚恰好印出前几年度现价"失效——
 * 页脚表也可能年度连续且 ≥5 行，于是被当成独立现价表入库。
 *
 * 判据来源：ocr-extractor._buildLayoutText 输出的每行形如 `y<坐标>|x:文本|…`（整图坐标、左上原点），
 * 据此可算「现价表标题在页面中的纵向位置占比」，无需额外坐标管线。
 *
 * 阈值取 0.75 而非 0.5：PDF 连续截图（保单正页 + 完整现价表各占半页）时标题常落在中下部，
 * 用 0.5 会误杀真表——恰是 2026-09-11 修复要救的场景。且仅「标题落入页脚区 **且** 表行数偏少」才判残留，
 * 后半页的大表（≥ CASH_VALUE_FOOTER_MAX_ROWS 行）不受影响。
 */
const CASH_VALUE_FOOTER_TITLE_RATIO = 0.75
const CASH_VALUE_FOOTER_MAX_ROWS = 12
const CASH_TITLE_RE = /现金价值|退保金|利益演示|现价表/

/** @returns {number|null} 标题纵向位置占比（0-1）；无坐标或缺标题行时返回 null（表示无从判断，不否决） */
function _cashValueTitleRatio(ocrText) {
  const lines = String(ocrText || '').split('\n')
  let pageH = 0
  let titleY = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^y(\d+)\|/)
    if (!m) continue
    const y = Number(m[1])
    if (y > pageH) pageH = y
    if (titleY < 0 && CASH_TITLE_RE.test(lines[i])) titleY = y
  }
  if (pageH <= 0 || titleY < 0) return null
  return titleY / pageH
}

/** 是否判为保单页脚残留片段（须同时满足：标题在页脚区 + 表行数偏少） */
function _isCashValueFooterResidue(ocrText, rowCount) {
  const ratio = _cashValueTitleRatio(ocrText)
  if (ratio == null) return false
  if (ratio <= CASH_VALUE_FOOTER_TITLE_RATIO) return false
  return rowCount < CASH_VALUE_FOOTER_MAX_ROWS
}

/**
 * PolicyExtractor.extractOne — AI 原始响应 → Policy 对象（深模块，R2 候选 1）
 * 单图路径（aiPhase）唯一转换入口，杜绝字段漂移。
 * 内部：aiOverall 兜底 → calcConfidence → buildPolicyFromExtract → cashValueData
 * @param {object} extractRes - AI 解析结果（{ result, document_type, data, cash_value_data, message }）
 * @param {array} ocrConfInfo - OCR 字符级置信度
 * @returns {{ success: boolean, policies?, cashValueData?, docType?, autoConfirmed?, overallConf?, error?, errorCode? }}
 */
function extractOne(extractRes, ocrConfInfo, ocrText) {
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

  const base = calcConfidence(ocrConfInfo, aiFieldConf, aiOverall)
  const products = data.products || []
  // 2026-10-17：金额类字段做"原文可对齐"校验，对不上的压分 → 进待核对。
  // 同时取消 auto_confirmed（不能一边说"字段不可信"一边自动入库）。
  const evNum = applyNumericEvidence(products, base.fieldConf, ocrText)
  // 2026-10-18：AI 提供的"原文出处"逐字回查（编造引用 / 值与引用不符 → 降级）
  const evQuote = applyEvidenceCheck(products, contractBasic, data.field_evidence, ocrText, evNum.fieldConf)
  // 2026-10-18：期间字段（保障期间 / 缴费期间）的文字型校验 —— 读错会让甘特图与时间线画错
  const evPeriod = applyPeriodEvidence(products, ocrText, evQuote.fieldConf)
  const ev = {
    fieldConf: evPeriod.fieldConf,
    flagged: evNum.flagged
      .concat(evQuote.flagged.filter(function(f) { return evNum.flagged.indexOf(f) === -1 }))
      .concat(evPeriod.flagged.filter(function(f) {
        return evNum.flagged.indexOf(f) === -1 && evQuote.flagged.indexOf(f) === -1
      }))
  }
  const fieldConf = ev.fieldConf
  const overallConf = base.overallConf
  const ocrReliable = base.ocrReliable
  const autoConfirmed = base.autoConfirmed && ev.flagged.length === 0
  // 保留 AI 原始判定：mixed 需同时走"保单构建"与"现价表提取"两条路，
  // 而 docType 最终要降级为 policy（同图以保单主体为主），故先存原始值
  const rawDocType = extractRes.document_type || 'policy'
  const policies = buildPolicyFromExtract(products, contractBasic, { overallConf, fieldConf, ocrReliable, autoConfirmed, fieldEvidence: data.field_evidence })

  // 现价表数据提取（document_type = cash_value 或 mixed）
  // 2026-09-11 调整：mixed 不再"无条件丢弃现价表"。原策略（2026-09-09 片段拦截）为防
  // 保单页脚的残留现价表被当成有效表入库，采取了"宁可丢也不错收"的一刀切——代价是真表被误杀：
  // 保单正页与完整现价表同屏（PDF 连续截图很常见）时 AI 会判 mixed → 现价表被丢弃 →
  // 报告「现价/回本」列永久显示 '-'、回本节点不生成，且没有二次补偿路径。
  // 现改为 cash_value 与 mixed 走同一标准：AI 判"完整现价表" + 代码完整性阈值（年度自 1 起
  // 连续、行数 ≥ CASH_VALUE_MIN_ROWS）双满足才收。残留片段仍会被该阈值拦下，原有防线未放松。
  let cashValueData = null
  let cashValueRejected = null
  if ((rawDocType === 'cash_value' || rawDocType === 'mixed') && extractRes.cash_value_data) {
    const cvd = extractRes.cash_value_data
    const hi = cvd.header_info || {}
    const cvArr = (cvd.cash_values || []).map(cv => {
      const row = { y: cv.y, v: _toNum(cv.v) }
      if (cv.n) row.n = cv.n
      return row
    })
    if (!_isCashValueComplete(cvArr)) {
      cashValueRejected = 'incomplete'
    } else if (_isCashValueFooterResidue(ocrText, cvArr.length)) {
      // 2026-09-12 确定性复核：页脚残表（标题落入页面底部 + 表行数偏少）→ 否决 AI 的"完整"判定
      cashValueRejected = 'footer_residue'
    } else {
      cashValueData = {
        product_name: hi.product_name || (products.length > 0 ? products[0].product_name : '') || '',
        insured_name: hi.insured_name || contractBasic.insured_name || '',
        policy_number: hi.policy_number || contractBasic.policy_number || '',
        insurance_type: hi.insurance_type || '',
        cash_values: cvArr,
        overall_confidence: typeof cvd.overall_confidence === 'number' ? cvd.overall_confidence : overallConf,
        // 2026-09-12 同图绑定：mixed 图（保单正页 + 现价表同屏）的现价表携带来源保单键，
        // 写库时由 cash-value-matcher 优先直连该保单（同图是比"产品名模糊"更强的信号）。
        // 仅作匹配提示，不落库（writeCashValue 显式白名单构造 cashDoc）。
        from_policy: rawDocType === 'mixed' ? {
          policy_number: contractBasic.policy_number || '',
          product_name: (products[0] && products[0].product_name) || '',
          insured_name: contractBasic.insured_name || ''
        } : null
      }
    }
  }
  // mixed：同图以保单主体为主 → docType 降级为 policy（影响下游分组与展示，保持历史行为）
  const docType = rawDocType === 'mixed' ? 'policy' : rawDocType
  // evidenceFlagged：金额字段在原文里找不到对应数字的字段名（供 opLog 观测，不落库）
  return { success: true, policies: policies, cashValueData: cashValueData, cashValueRejected: cashValueRejected, docType: docType, autoConfirmed: autoConfirmed, overallConf: overallConf, evidenceFlagged: ev.flagged }
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
  const ex = extractOne(extractRes, ocrConfInfo, ocrText)
  const docType = ex.docType
  const newPolicies = ex.policies
  const cashValueData = ex.cashValueData
  const autoConfirmed = ex.autoConfirmed

  opLog(db, {
    action: 'ocr_recognize', openid, familyId,
    result: { status: 'ok', summary: '识别' + newPolicies.length + '个产品，类型:' + docType },
    meta: { total: newPolicies.length, docType, hasCashValue: !!cashValueData, cashValueRejected: ex.cashValueRejected || null, autoConfirmed, evidenceFlagged: ex.evidenceFlagged || [], durations, tokens: tokens || {} }
  }).catch(() => {})

  return { success: true, policiesCount: newPolicies.length, policies: newPolicies, document_type: docType, cashValueData, tokens: tokens || {} }
}

// ---- 批量 AI 提取已收敛（2026-08-30）----
// aiExtractBatch 单图路径统一走 aiPhase（DeepSeek 直连），批量拼接编排（_callBatchAI/aiExtractBatchPhase）已删除。
// 备份文件已随 docs 归档清理（2026-09-04）；原实现见 git 历史。

module.exports = { ocrPhase, aiPhase, matchPoliciesToMembers, buildPolicyFromExtract, extractOne, applyNumericEvidence, applyEvidenceCheck, applyPeriodEvidence, _textEvidenceOk, _hasNumericEvidence, _toNum, _isCashValueFooterResidue, _cashValueTitleRatio }
