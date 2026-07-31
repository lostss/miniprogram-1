/**
 * ocrService handlers — OCR 识别与提取
 *
 * Action 路由表：
 *   ocrSingle   - 单图 OCR + AI 提取（首页 / 报告页通用入口）
 *
 * 设计要点（ponytail）：
 *   - 不重复造轮子：核心逻辑走 _shared/ocr-core.processOneImage
 *   - 错误码透传：ocr-core 返回的 error_code 直接透传给前端，便于 P3-3 分流
 *   - familyId 可选：匿名 OCR（首页首次识别）也支持
 */

const cloud = require('wx-server-sdk')
const { ocrPhase, aiPhase, aiExtractBatchPhase } = require('./_shared/ocr-core')
const { buildExtractionPrompt, buildBatchExtractionPrompt } = require('./prompts')
const { logOperation } = require('./_shared/logSeam')
const { wrapError } = require('./_shared/errorHandler')
const { matchPoliciesToMembers } = require('./_shared/member-matcher')
const { AI_TIMEOUT, AI } = require('./_shared/config')
// DeepSeek 直连模式：USE_DIRECT=true 时走 callChatDirect，绕过 TokenHub 限流（并发 2500）
const _aiClient = require('./_shared/ai-client')
const _callFn = AI.USE_DIRECT ? _aiClient.callChatDirect : _aiClient.callChat

/**
 * AI 错误分类 — 统一识别 429/超时/格式错误
 * 修复 SDK 429 错误被吞没为 'ai_exception' 的 bug：
 * SDK 抛出的 429 错误 e.code=undefined、e.statusCode=429，
 * 原逻辑只看 e.code 导致前端无法识别重试。
 */
function _classifyAIError(e) {
  if (!e) return 'ai_exception'
  if (e.statusCode === 429 || e.status === 429) return '429'
  if (e.code === '429' || e.code === 'RATE_LIMIT' || e.code === 'RequestLimitExceeded') return '429'
  var msg = String(e.message || '')
  if (msg.indexOf('429') >= 0) return '429'
  if (msg.indexOf('RequestLimitExceeded') >= 0 || msg.indexOf('RateLimit') >= 0) return '429'
  if (e.code === 'CHAT_TIMEOUT' || e.code === 'TIMEOUT' || msg.indexOf('CHAT_TIMEOUT') >= 0) return 'CHAT_TIMEOUT'
  if (e.code === 'ai_format') return 'ai_format'
  return e.code || 'ai_exception'
}

/** 并发限流：每次最多 n 个异步任务并行 */
async function _withConcurrency(tasks, n) {
  const results = new Array(tasks.length)
  let i = 0
  async function worker() {
    while (i < tasks.length) {
      const idx = i++
      results[idx] = await tasks[idx]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, () => worker()))
  return results
}

// ======================== ocrSingle ========================
/**
 * 单图 OCR + AI 提取
 * @param {object} event
 *   - fileIds: string[]  云存储文件 ID（必填，长度 1-N）
 *   - familyId?: string  关联家庭 ID（可选，匿名 OCR 时为空）
 */
async function ocrSingle(db, openid, event) {
  const { fileIds, familyId } = event
  if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
    return { code: 400, msg: '缺少参数 fileIds' }
  }
  if (fileIds.length > 10) {
    return { code: 400, msg: '单次最多 10 张图片' }
  }
  for (const fid of fileIds) {
    if (typeof fid !== 'string' || !fid.startsWith('cloud://')) {
      return { code: 400, msg: 'fileId 格式非法，必须为 cloud:// 协议' }
    }
  }

  // ① OCR 阶段：全部并发（OCR API 20 QPS，无 429 风险）
  var ocrTasks = fileIds.map(function(fid) {
    return ocrPhase({ cloud, fileId: fid, openid, familyId: familyId || null }).catch(function(e) {
      return { fail: true, fileId: fid, error: (e && e.message) || 'OCR异常' }
    })
  })
  var ocrResults = await Promise.all(ocrTasks)
  // OCR 阶段日志
  var ocrOk = ocrResults.filter(function(r) { return !r.fail }).length
  var ocrFail = ocrResults.length - ocrOk
  var ocrMaxMs = 0
  ocrResults.forEach(function(r) { if (!r.fail && r.t2 && r.t0) { var d = r.t2 - r.t0; if (d > ocrMaxMs) ocrMaxMs = d } })
  logOperation(db, {
    openid, familyId: familyId || undefined, action: 'ocr_phase',
    result: { status: ocrFail > 0 ? 'partial' : 'ok', summary: 'OCR ' + fileIds.length + '张, 成功' + ocrOk + '/失败' + ocrFail },
    meta: { total: fileIds.length, ok: ocrOk, fail: ocrFail, maxMs: ocrMaxMs }
  }).catch(function() {})
  // ② AI 阶段：每张 OCR 完成即排队 AI，间隔 1s
  var policies = [], cashValues = [], failures = [], maxHandlerMs = 0
  var aiQueue = ocrResults.filter(function(r) { return !r.fail && r.ocrText })
  for (var i = 0; i < aiQueue.length; i++) {
    var ocr = aiQueue[i]
    if (i > 0) await new Promise(function(r) { setTimeout(r, 10000) })
    try {
      var t3 = Date.now()
      var aiRes = await aiPhase({
        ocrText: ocr.ocrText, ocrConfInfo: ocr.ocrConfInfo, fileId: ocr.fileId,
        t0: ocr.t0, t1: ocr.t1, t2: ocr.t2,
        cloud, db, buildExtractionPrompt, familyId: familyId || null, openid
      })
      aiRes._handlerMs = Date.now() - t3
      if (aiRes._handlerMs > maxHandlerMs) maxHandlerMs = aiRes._handlerMs
      if (aiRes.success) {
        policies = policies.concat(aiRes.policies || [])
        if (aiRes.cashValueData) cashValues.push(aiRes.cashValueData)
      } else {
        failures.push({ fileId: ocr.fileId, error: aiRes.error, error_code: aiRes.error_code })
      }
    } catch (e) {
      logOperation(db, {
        openid, familyId: familyId || undefined, action: 'ocr_single',
        result: { status: 'fail', summary: 'AI异常', errorCode: (e.statusCode || e.code || 'ocr_exception') },
        meta: { fileId: ocr.fileId, error: (e && e.message || '') }
      }).catch(function() {})
      failures.push({ fileId: ocr.fileId, error: (e && e.message) || 'AI异常', error_code: e.statusCode ? String(e.statusCode) : (e.code || 'ocr_exception') })
    }
  }
  // 回收 OCR 失败的
  for (var j = 0; j < ocrResults.length; j++) {
    var or = ocrResults[j]
    if (or.fail) failures.push({ fileId: or.fileId, error: or.error, error_code: 'ocr_failed' })
  }
  logOperation(db, {
    openid, familyId: familyId || undefined, action: 'ocr_single_batch',
    result: { status: failures.length > 0 ? 'partial' : 'ok', summary: 'OCR ' + fileIds.length + '张, ' + policies.length + '产品/' + failures.length + '失败' },
    meta: { fileCount: fileIds.length, policyCount: policies.length, failCount: failures.length, maxElapsedMs: maxHandlerMs }
  }).catch(function () {})

  // 全部失败 → 返回首项错误码便于前端分流
  if (policies.length === 0 && cashValues.length === 0 && failures.length > 0) {
    return {
      code: 200,
      data: {
        policies: [],
        cash_values: [],
        count: 0,
        failures,
        error_code: failures[0].error_code || 'ocr_failed'
      }
    }
  }

  return {
    code: 200,
    data: {
      policies,
      cash_values: cashValues.length > 0 ? cashValues : undefined,
      count: policies.length,
      failures: failures.length > 0 ? failures : undefined
    }
  }
}

// ======================== matchPolicies ========================
async function matchPolicies(db, openid, event) {
  const { familyId, policies } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!policies || !Array.isArray(policies)) return { code: 400, msg: '缺少参数 policies' }
  try {
    await matchPoliciesToMembers({ db, familyId, openid, allPolicies: policies })
    return { code: 200, data: { matched: true } }
  } catch (e) { return wrapError('成员匹配', e) }
}

// ======================== ocrOnly ========================
/**
 * 方案 B 阶段 1：仅 OCR 并发，无 AI 调用（无 429 风险）
 * 入参：{ fileIds: string[], familyId?: string }
 * 出参：{ code, data: { ocr_results: [{fileId, ocrText, ocrConfInfo, t0, t1, t2}], failures: [{fileId, error, error_code}] } }
 *
 * 设计要点：
 *   - OCR API 20 QPS，9 张全并发安全
 *   - 单次云函数耗时 ≈ 1.7s（远低于超时）
 *   - 返回 ocrText 让前端持有，再分批调 aiExtract
 */
async function ocrOnly(db, openid, event) {
  const { fileIds, familyId } = event
  if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
    return { code: 400, msg: '缺少参数 fileIds' }
  }
  if (fileIds.length > 10) {
    return { code: 400, msg: '单次最多 10 张图片' }
  }
  for (const fid of fileIds) {
    if (typeof fid !== 'string' || !fid.startsWith('cloud://')) {
      return { code: 400, msg: 'fileId 格式非法，必须为 cloud:// 协议' }
    }
  }

  var tasks = fileIds.map(function(fid) {
    return ocrPhase({ cloud, fileId: fid, openid, familyId: familyId || null }).then(function(r) {
      return { ok: true, data: r }
    }).catch(function(e) {
      return { ok: false, fileId: fid, error: (e && e.message) || 'OCR异常', error_code: 'ocr_failed' }
    })
  })
  var results = await Promise.all(tasks)

  var ocrResults = [], failures = []
  for (var i = 0; i < results.length; i++) {
    var r = results[i]
    if (r.ok) {
      // OCR 识别为空文本：直接标记失败，避免前端传空 ocrText 给 aiExtract 被拒
      if (!r.data.ocrText || typeof r.data.ocrText !== 'string' || r.data.ocrText.length === 0) {
        failures.push({ fileId: r.data.fileId, error: 'OCR识别结果为空', error_code: 'ocr_empty' })
      } else {
        ocrResults.push({
          fileId: r.data.fileId,
          ocrText: r.data.ocrText,
          ocrConfInfo: r.data.ocrConfInfo,
          t0: r.data.t0, t1: r.data.t1, t2: r.data.t2
        })
      }
    } else {
      failures.push({ fileId: r.fileId, error: r.error, error_code: r.error_code })
    }
  }

  logOperation(db, {
    openid, familyId: familyId || undefined, action: 'ocr_only_batch',
    result: { status: failures.length > 0 ? 'partial' : 'ok', summary: 'OCR ' + fileIds.length + '张, 成功' + ocrResults.length + '/失败' + failures.length },
    meta: { fileCount: fileIds.length, okCount: ocrResults.length, failCount: failures.length }
  }).catch(function() {})

  return {
    code: 200,
    data: {
      ocr_results: ocrResults,
      failures: failures.length > 0 ? failures : undefined
    }
  }
}

// ======================== aiExtract ========================
/**
 * 方案 B 阶段 2：单图 AI 提取（前端分批 3 并发调用）
 * 入参：{ fileId, ocrText, ocrConfInfo, t0, t1, t2, familyId? }
 * 出参：{ code, data: { policies: [], cash_value_data?, error?, error_code? } }
 *
 * 设计要点：
 *   - 单图 AI 调用，单次云函数耗时 5-15s（远低于超时）
 *   - 429 由前端指数退避重试 10s/30s，云函数不重试
 *   - 错误码透传给前端便于分流
 */
async function aiExtract(db, openid, event) {
  const { fileId, ocrText, ocrConfInfo, t0, t1, t2, familyId } = event
  if (!fileId || typeof fileId !== 'string') {
    return { code: 400, msg: '缺少参数 fileId' }
  }
  if (!ocrText || typeof ocrText !== 'string') {
    return { code: 400, msg: '缺少参数 ocrText' }
  }

  try {
    var aiRes = await aiPhase({
      ocrText: ocrText,
      ocrConfInfo: ocrConfInfo || [],
      fileId: fileId,
      t0: t0 || Date.now(),
      t1: t1 || Date.now(),
      t2: t2 || Date.now(),
      cloud: cloud,
      db: db,
      buildExtractionPrompt: buildExtractionPrompt,
      familyId: familyId || null,
      openid: openid
    })
    if (aiRes.success) {
      return {
        code: 200,
        data: {
          policies: aiRes.policies || [],
          cash_value_data: aiRes.cashValueData || null,
          document_type: aiRes.document_type || 'policy'
        }
      }
    }
    return {
      code: 200,
      data: {
        policies: [],
        cash_value_data: null,
        error: aiRes.error || 'AI提取失败',
        error_code: aiRes.error_code || 'ai_exception'
      }
    }
  } catch (e) {
    // 统一用 _classifyAIError 识别 429，避免外层 catch 误判
    var errorCode = _classifyAIError(e)
    logOperation(db, {
      openid, familyId: familyId || undefined, action: 'ocr_ai_extract',
      result: { status: 'fail', summary: 'AI异常', errorCode: errorCode },
      meta: { fileId: fileId, error: (e && e.message || ''), errStatusCode: e && e.statusCode, errCode: e && e.code }
    }).catch(function() {})
    return {
      code: 200,
      data: {
        policies: [],
        cash_value_data: null,
        error: (e && e.message) || 'AI异常',
        error_code: errorCode
      }
    }
  }
}

// ======================== aiExtractBatch ========================
/**
 * 方案 C：批量拼接提取（N 张图 OCR 文本拼接后 1 次 AI 调用）
 * 入参：{ ocr_results: [{fileId, ocrText, ocrConfInfo, t0, t1, t2}], familyId? }
 * 出参：{ code, data: { results: [...], total_duration_ms, split_used, ai_call_count, tokens?, success_count, fail_count } }
 *
 * 设计要点：
 *   - 空 ocrText 项在前端过滤标记 ocr_empty，不参与 AI 调用
 *   - AI 整体异常时所有有效项标记 ai_batch_failed，但仍然返回 200 + results
 *   - split_used=true 表示因超 OCR_BATCH_MAX_CHARS 触发对半拆分降级
 */
async function aiExtractBatch(db, openid, event) {
  const { ocr_results, familyId } = event
  if (!ocr_results || !Array.isArray(ocr_results) || ocr_results.length === 0) {
    return { code: 400, msg: '缺少参数 ocr_results' }
  }
  if (ocr_results.length > 10) {
    return { code: 400, msg: '单次最多 10 张图片' }
  }

  // 过滤空 ocrText 项（标记 ocr_empty），保留原始位置
  var validResults = []
  var emptyFileIds = []
  for (var i = 0; i < ocr_results.length; i++) {
    var item = ocr_results[i]
    if (!item || !item.ocrText || typeof item.ocrText !== 'string' || item.ocrText.length === 0) {
      emptyFileIds.push({ idx: i + 1, fileId: item && item.fileId })
    } else {
      validResults.push(item)
    }
  }

  // 全部为空：直接返回，不调用 AI
  if (validResults.length === 0) {
    var allEmpty = emptyFileIds.map(function(e) {
      return { idx: e.idx, fileId: e.fileId, success: false, error: 'OCR识别结果为空', errorCode: 'ocr_empty' }
    })
    return {
      code: 200,
      data: {
        results: allEmpty,
        total_duration_ms: 0,
        split_used: false,
        ai_call_count: 0,
        tokens: {},
        success_count: 0,
        fail_count: allEmpty.length
      }
    }
  }

  var deps = {
    cloud: cloud,
    db: db,
    openid: openid,
    familyId: familyId || null,
    buildBatchExtractionPrompt: buildBatchExtractionPrompt,
    safeCallChat: require('./_shared/ai-gateway').safeCallChat,
    callChat: _callFn,
    AI_TIMEOUT: AI_TIMEOUT
  }

  var batchRes
  try {
    batchRes = await aiExtractBatchPhase(validResults, deps)
  } catch (e) {
    // 整体异常：所有有效项标记 ai_batch_failed
    logOperation(db, {
      openid, familyId: familyId || undefined, action: 'ai_extract_batch',
      result: { status: 'fail', summary: 'AI批量提取异常', errorCode: 'ai_batch_failed' },
      meta: { validCount: validResults.length, error: (e && e.message) || '' }
    }).catch(function() {})
    var failedResults = validResults.map(function(r, i) {
      return { idx: i + 1, fileId: r.fileId, success: false, error: (e && e.message) || 'AI批量提取异常', errorCode: 'ai_batch_failed' }
    })
    return {
      code: 200,
      data: {
        results: _mergeBatchResults(ocr_results, failedResults, emptyFileIds),
        total_duration_ms: 0,
        split_used: false,
        ai_call_count: 0,
        tokens: {},
        success_count: 0,
        fail_count: ocr_results.length
      }
    }
  }

  // 合并结果：保留原始位置顺序
  var mergedResults = _mergeBatchResults(ocr_results, batchRes.results, emptyFileIds)
  var successCount = 0, failCount = 0
  for (var k = 0; k < mergedResults.length; k++) {
    if (mergedResults[k].success) successCount++
    else failCount++
  }

  logOperation(db, {
    openid, familyId: familyId || undefined, action: 'ai_extract_batch',
    result: { status: failCount > 0 ? 'partial' : 'ok', summary: '批量提取 ' + ocr_results.length + '张, 成功' + successCount + '/失败' + failCount },
    meta: {
      total: ocr_results.length, validCount: validResults.length, emptyCount: emptyFileIds.length,
      successCount: successCount, failCount: failCount,
      aiCallCount: batchRes.aiCallCount, splitUsed: batchRes.splitUsed, totalDurationMs: batchRes.totalDurationMs,
      tokens: batchRes.tokens || {}
    }
  }).catch(function() {})

  return {
    code: 200,
    data: {
      results: mergedResults,
      total_duration_ms: batchRes.totalDurationMs,
      split_used: batchRes.splitUsed,
      ai_call_count: batchRes.aiCallCount,
      tokens: batchRes.tokens || {},
      success_count: successCount,
      fail_count: failCount
    }
  }
}

/**
 * 合并批量结果：按原始 ocr_results 顺序，空 ocrText 项标记 ocr_empty，有效项从 batchResults 按 fileId 匹配
 */
function _mergeBatchResults(originalOcrResults, batchResults, emptyFileIds) {
  var emptyByFileId = {}
  for (var i = 0; i < emptyFileIds.length; i++) {
    emptyByFileId[emptyFileIds[i].fileId] = true
  }
  var batchByFileId = {}
  for (var j = 0; j < batchResults.length; j++) {
    if (batchResults[j] && batchResults[j].fileId) {
      batchByFileId[batchResults[j].fileId] = batchResults[j]
    }
  }
  var merged = []
  for (var k = 0; k < originalOcrResults.length; k++) {
    var item = originalOcrResults[k]
    var fid = item && item.fileId
    if (emptyByFileId[fid]) {
      merged.push({ idx: k + 1, fileId: fid, success: false, error: 'OCR识别结果为空', errorCode: 'ocr_empty' })
    } else if (batchByFileId[fid]) {
      merged.push(batchByFileId[fid])
    } else {
      merged.push({ idx: k + 1, fileId: fid, success: false, error: '结果缺失', errorCode: 'ai_batch_failed' })
    }
  }
  return merged
}

module.exports = { ocrSingle, ocrOnly, aiExtract, aiExtractBatch, matchPolicies }
