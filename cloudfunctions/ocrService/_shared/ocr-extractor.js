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
// PII 脱敏：OCR 返回后、发送给 AI 前实施，身份证/手机号/银行卡明文不出云
// 身份证脱敏保留出生日期（如 52212519811219435X → 5221251981-12-19-****），生日字段仍可提取
const { desensitize } = require('./pii-rules')

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

// PII 脱敏前保单号保护（OCR 审计 H3）：16-19 位纯数字保单号会被 pii-rules 银行卡规则
// `\b\d{16,19}\b` 误伤，且发生在 AI 提取前不可恢复。OCR 文本中保单号前常有
// 「保单号/合同号/保单编号」等标签——提取标签紧邻号码 → 占位符保护 → 脱敏 → 还原。
// 无标签的孤立 16-19 位数字串仍保守脱敏（宁可脱敏不可泄漏）。
const POLICY_NO_LABEL_RE = /(保单号|合同号|保险单号|保单编号|保单号码|合同编号|保单凭证号|PolicyNo|Policy No)[：:为是]?\s*([A-Za-z0-9\-]{6,})/gi

function _desensitizeWithPolicyProtect(text) {
  const held = []
  const t = String(text).replace(POLICY_NO_LABEL_RE, function(m, label, num) {
    held.push(num)
    return label + '：@@PN@' + (held.length - 1) + '@@'
  })
  return desensitize(t).replace(/@@PN@(\d+)@@/g, function(m, i) { return held[Number(i)] })
}

// ---- 版面重建（2026-09-09）----
// 保留 OCR 坐标 → 行块聚类 → 带坐标文本，让 AI 能按几何位置还原表格：
//   N 型（表头群 + 值群）按 x 区间配对；Z 型（标签-值就近）按 x 对齐配对；
//   区域占比 = 内容 y 跨度 / 页高，用于判定现价表残留片段。
// 实测（GeneralAccurateOCR，EnableDetectSplit 开关结果一致）：Polygon/ItemPolygon 为整图坐标、左上原点。
const ROW_MERGE_RATIO = 0.6 // 同一视觉行合并阈值：y 差 < 行高 × 比例
const ROW_MERGE_MIN = 4     // 合并阈值下限（防小字号行高过小导致误合并）

/**
 * 行块聚类：同一视觉行的多个 OCR item（y 邻近）合并为一行
 * @param {Array<{text:string,x:number,y:number,h:number}>} items
 * @returns {Array<{y:number,h:number,items:Array}>}
 */
function _groupByRow(items) {
  const sorted = items.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x })
  const rows = []
  for (const it of sorted) {
    const last = rows[rows.length - 1]
    const tol = Math.max(ROW_MERGE_MIN, Math.min(last ? last.h : it.h, it.h) * ROW_MERGE_RATIO)
    if (last && Math.abs(it.y - last.y) <= tol) {
      last.items.push(it)
      if (it.h > last.h) last.h = it.h
    } else {
      rows.push({ y: it.y, h: it.h, items: [it] })
    }
  }
  // 行块内统一按 x 升序（合并时按 y 顺序加入，可能乱序）
  rows.forEach(function (r) { r.items.sort(function (a, b) { return a.x - b.x }) })
  return rows
}

/** 行块 → 带坐标文本：`y387|77:险种名称|125:基本保险金额|...` */
function _buildLayoutText(rows) {
  return rows.map(function (r) {
    return 'y' + r.y + '|' + r.items.map(function (it) { return it.x + ':' + it.text }).join('|')
  }).join('\n')
}

async function ocrRecognize(tempFileURL) {
  const client = _getOcrClient()
  try {
    // 架构审计第 14 轮候选 #3：重试委托 withRetry（原内联 setTimeout 1000ms）
    return await withRetry(
      async () => {
        // P1+P2: GeneralAccurateOCR（高精度版，99%准确率，与高速版同价 0.50元/次）
        // 注意：LanguageType/WordsType 属 GeneralBasicOCR 参数，GeneralAccurateOCR 不支持（传了报
        // "The parameter `LanguageType` is not recognized."）→ 不传
        // EnableDetectSplit:true 整图大图中有小字表格时切图提升检测率（现价表等）
        const ocrRes = await client.GeneralAccurateOCR({
          ImageUrl: tempFileURL,
          EnableDetectSplit: true
        })
        if (ocrRes && ocrRes.TextDetections && ocrRes.TextDetections.length > 0) {
          // PII 脱敏（OCR 返回后即实施）：身份证/手机号/银行卡明文不进入 AI 调用
          // 保单号标签紧邻号码先保护再脱敏（见 _desensitizeWithPolicyProtect，防 16-19 位纯数字保单号误伤）
          const items = ocrRes.TextDetections.map(function (td) {
            const ip = td.ItemPolygon || {}
            return {
              text: _desensitizeWithPolicyProtect(td.DetectedText || ''),
              x: Math.round(ip.X || 0),
              y: Math.round(ip.Y || 0),
              h: Math.round(ip.Height || 10)
            }
          })
          const text = _buildLayoutText(_groupByRow(items)).trim()
          const confs = ocrRes.TextDetections.map(td => ({ text: _desensitizeWithPolicyProtect((td.DetectedText || '').substring(0, 30)), ocr_conf: td.Confidence || 0 }))
          return { text, confs }
        }
        return { text: '', confs: [] }
      },
      { maxAttempts: 2, delayMs: 1000, label: 'ocr-extractor recognize' }
    )
  } catch (e) {
    console.error('[ocr-extractor] OCR 重试后仍失败:', e.message)
    // 服务异常与"未识别到文字"区分：返回错误码由上层提示"服务异常请重试"，避免误导为"未识别"
    return { text: '', confs: [], error_code: 'ocr_service_error' }
  }
}

/**
 * @returns {{ success: boolean, extractRes?: object, tokens?: object, error_code?: string }}
 */
async function aiExtract(ocrText, ocrConfInfo, deps) {
  const { buildExtractionPrompt, safeCallChat, callChat, cloud, db, openid, familyId, AI_TIMEOUT, traceId } = deps

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
            { role: 'user', content: ocrText }
          ]
        const sessionId = (attempt === 0 ? 'ocr_' : 'ocr_retry_') + Date.now().toString(36)
        const res = await safeCallChat(
          messages,
          callChat,
          // 2026-09-10：model 归因修正——USE_DIRECT 时实际调用 DeepSeek 直连（AI.DIRECT_MODEL），
          // 原固定写 OCR_MODEL('hy3') 导致日志/成本按 TokenHub 计价（口径与真实模型不符）
          { cloud, db, openid, familyId, sessionId, traceId, model: AI.USE_DIRECT ? AI.DIRECT_MODEL : AI.OCR_MODEL, action: 'ocr_extract', skipInjection: true, skipOutputAudit: true, skipContentSafety: true },
          { maxTokens: AI.OCR_MAX_TOKENS, temperature: AI.OCR_TEMPERATURE, responseFormat: { type: 'json_object' }, timeoutMs: AI_TIMEOUT.OCR }
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

// _parseAIJSON re-export：注释声明的向后兼容（重构抽离到 parse-ai-json.js 时漏加导出）
// _desensitizeWithPolicyProtect 导出供单测（H3 保单号保护）
module.exports = { ocrRecognize, aiExtract, _parseAIJSON, _desensitizeWithPolicyProtect, _groupByRow, _buildLayoutText }
