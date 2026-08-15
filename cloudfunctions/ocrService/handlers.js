/**
 * ocrService handlers — OCR 识别与提取
 *
 * Action 路由表（R2 后分流收敛）：
 *   ocrOnly           - 阶段1：仅 OCR 并发，无 AI 调用
 *   aiExtractBatch    - 单图提取（batch prompt 1 次 AI 调用，TokenHub hy3；前端分流：1 张）
 *   aiExtractParallel - 每张独立 AI 调用（DeepSeek 直连并发；前端分流：≥2 张）
 *
 * 设计要点（ponytail）：
 *   - 错误码透传：ocr-core 返回的 error_code 直接透传给前端
 *   - familyId 可选：匿名 OCR（首页首次识别）也支持
 */

const cloud = require('wx-server-sdk')
const { ocrPhase, aiPhase, aiExtractBatchPhase } = require('./_shared/ocr-core')
const { buildExtractionPrompt, buildBatchExtractionPrompt } = require('./prompts')
const { logOperation } = require('./_shared/logSeam')
const { wrapError } = require('./_shared/errorHandler')
const _aiClient = require('./_shared/ai-client')
const { AI } = require('./_shared/config')

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

// ======================== ocrOnly ========================
/**
 * 方案 B 阶段 1：仅 OCR 并发，无 AI 调用（无 429 风险）
 * 入参：{ fileIds: string[], familyId?: string }
 * 出参：{ code, data: { ocr_results: [{fileId, ocrText, ocrConfInfo, t0, t1, t2}], failures: [{fileId, error, error_code}] } }
 *
 * 设计要点：
 *   - OCR API 20 QPS，9 张全并发安全
 *   - 单次云函数耗时 ≈ 1.7s（远低于超时）
 *   - 返回 ocrText 让前端持有，再走前端分流（1 张 aiExtractBatch | ≥2 张 aiExtractParallel）
 */
async function ocrOnly(db, openid, event) {
  const { fileIds, familyId } = event
  if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
    return { code: 400, msg: '缺少参数 fileIds' }
  }
  if (fileIds.length > 9) {
    return { code: 400, msg: '单次最多 9 张图片' }
  }
  for (const fid of fileIds) {
    if (typeof fid !== 'string' || !fid.startsWith('cloud://')) {
      return { code: 400, msg: 'fileId 格式非法，必须为 cloud:// 协议' }
    }
    // R3v2 审计 #4：IDOR 防护——fileId 必须位于本人上传目录 temp/<openid>/
    // 前端上传路径 = temp/<openid>/<ts>_<rand>_<i>.jpg（ocr-flow.js compressAndUpload prefix），
    // 拿到他人 fileId 也无法 OCR 他人保单图
    if (fid.indexOf('/temp/' + openid + '/') === -1) {
      return { code: 403, msg: '无权访问该文件' }
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
      // OCR 识别为空文本：直接标记失败，避免前端传空 ocrText 给 AI 提取被拒。
      // 服务异常（ocrRecognize 重试后仍失败）与真空白区分：前者提示重试，后者提示换图
      if (!r.data.ocrText || typeof r.data.ocrText !== 'string' || r.data.ocrText.length === 0) {
        if (r.data.ocrErrorCode === 'ocr_service_error') {
          failures.push({ fileId: r.data.fileId, error: 'OCR 服务异常，请稍后重试', error_code: 'ocr_service_error' })
        } else {
          failures.push({ fileId: r.data.fileId, error: 'OCR识别结果为空', error_code: 'ocr_empty' })
        }
      } else {
        ocrResults.push({
          fileId: r.data.fileId,
          ocrText: r.data.ocrText,
          ocrConfInfo: r.data.ocrConfInfo,
          ocrErrorCode: r.data.ocrErrorCode,
          t0: r.data.t0, t1: r.data.t1, t2: r.data.t2
        })
      }
    } else {
      failures.push({ fileId: r.fileId, error: r.error, error_code: r.error_code })
    }
  }

  logOperation(db, {
    openid, familyId: familyId || undefined, traceId: event._reqId || '', action: 'ocr_only_batch',
    result: { status: failures.length > 0 ? 'partial' : 'ok', summary: 'OCR ' + fileIds.length + '张, 成功' + ocrResults.length + '/失败' + failures.length },
    meta: { fileCount: fileIds.length, okCount: ocrResults.length, failCount: failures.length }
  })

  return {
    code: 200,
    data: {
      ocr_results: ocrResults,
      failures: failures.length > 0 ? failures : undefined
    }
  }
}

// ======================== aiExtractBatch ========================
/**
 * 单图提取（batch prompt 1 次 AI 调用；前端分流后仅服务 1 张图，≥2 张走 aiExtractParallel）
 * 模型：TokenHub hy3（固定走 callChat；aiExtractParallel 才走 DeepSeek 直连）
 * 入参：{ ocr_results: [{fileId, ocrText, ocrConfInfo, t0, t1, t2}], familyId? }
 * 出参：{ code, data: { results: [...], total_duration_ms, split_used, ai_call_count, tokens?, success_count, fail_count } }
 *
 * 设计要点：
 *   - 空 ocrText 项在前端过滤标记 ocr_empty，不参与 AI 调用
 *   - AI 整体异常时所有有效项标记 ai_batch_failed，但仍然返回 200 + results
 */

// 公共前置：入参校验 + 空 ocrText 过滤 + 全空短路（aiExtractBatch/aiExtractParallel 共用）
// 返回 { error } | { allEmpty } | { validResults, emptyFileIds }
function _prepareOcrInput(ocr_results) {
  if (!ocr_results || !Array.isArray(ocr_results) || ocr_results.length === 0) {
    return { error: { code: 400, msg: '缺少参数 ocr_results' } }
  }
  if (ocr_results.length > 9) {
    return { error: { code: 400, msg: '单次最多 9 张图片' } }
  }
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
  if (validResults.length === 0) {
    var allEmpty = emptyFileIds.map(function(e) {
      return { idx: e.idx, fileId: e.fileId, success: false, error: 'OCR识别结果为空', errorCode: 'ocr_empty' }
    })
    return {
      allEmpty: {
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
  return { validResults: validResults, emptyFileIds: emptyFileIds }
}

async function aiExtractBatch(db, openid, event) {
  var prep = _prepareOcrInput(event.ocr_results)
  if (prep.error) return prep.error
  if (prep.allEmpty) return { code: 200, data: prep.allEmpty }
  const { ocr_results, familyId } = event
  const traceId = event._reqId || ''
  var validResults = prep.validResults
  var emptyFileIds = prep.emptyFileIds

  var deps = {
    cloud: cloud,
    db: db,
    openid: openid,
    familyId: familyId || null,
    traceId: traceId,
    buildBatchExtractionPrompt: buildBatchExtractionPrompt,
    safeCallChat: require('./_shared/ai-gateway').safeCallChat,
    // 用户决策（2026-08）：单图走 TokenHub hy3，批量才走 DeepSeek 并发
    // aiExtractBatch 仅服务单图（前端分流：>1 张走 aiExtractParallel），首次走 hy3，
    // AI 提取失败重试（_callBatchAI 内 attempt≥2）切 DeepSeek 直连，与张数无关
    // 批量路径 aiExtractParallel 内部经 aiPhase 按 USE_DIRECT=true 走 DeepSeek 直连
    callChat: _aiClient.callChat
  }

  var batchRes
  try {
    batchRes = await aiExtractBatchPhase(validResults, deps)
  } catch (e) {
    // 整体异常：所有有效项标记 ai_batch_failed（_finalizeBatch 统一后处理）
    var failedResults = validResults.map(function(r, i) {
      return { idx: i + 1, fileId: r.fileId, success: false, error: (e && e.message) || 'AI批量提取异常', errorCode: 'ai_batch_failed' }
    })
    return _finalizeBatch({ db, openid, familyId, traceId, ocrResults: ocr_results, emptyFileIds, batchResults: failedResults, tokens: {}, totalDurationMs: 0, aiCallCount: 0, action: 'ai_extract_batch' })
  }

  return _finalizeBatch({ db, openid, familyId, traceId, ocrResults: ocr_results, emptyFileIds, batchResults: batchRes.results, tokens: batchRes.tokens, totalDurationMs: batchRes.totalDurationMs, aiCallCount: batchRes.aiCallCount, action: 'ai_extract_batch' })
}

// ======================== aiExtractParallel ========================
/**
 * 方案 D：DeepSeek 并行提取（每张图独立 AI 调用，N 张并发）
 * 入参：{ ocr_results: [{fileId, ocrText, ocrConfInfo, t0, t1, t2}], familyId? }
 * 出参：与 aiExtractBatch 对齐（{ code, data: { results, total_duration_ms, ai_call_count, tokens, success_count, fail_count } }），前端可复用同一填充逻辑
 *
 * 设计要点：
 *   - 复用单图 aiPhase（直连 DeepSeek），每张图独立 prompt，无跨图依赖
 *   - DeepSeek 直连并发上限 2500，N 张全并发安全（_withConcurrency 控并发数）
 *   - 单张失败不影响其他张（各自独立 error_code）
 */
async function aiExtractParallel(db, openid, event) {
  var prep = _prepareOcrInput(event.ocr_results)
  if (prep.error) return prep.error
  if (prep.allEmpty) return { code: 200, data: prep.allEmpty }
  const { ocr_results, familyId } = event
  const traceId = event._reqId || ''
  var validResults = prep.validResults
  var emptyFileIds = prep.emptyFileIds

  var t0 = Date.now()
  // 每张图独立并发调用 aiPhase；DeepSeek 直连并发上限 2500，全并发安全
  var tasks = validResults.map(function(item, i) {
    return function() {
      return aiPhase({
        ocrText: item.ocrText,
        ocrConfInfo: item.ocrConfInfo || [],
        ocrErrorCode: item.ocrErrorCode,
        fileId: item.fileId,
        t0: item.t0 || t0,
        t1: item.t1 || t0,
        t2: item.t2 || t0,
        cloud: cloud,
        db: db,
        buildExtractionPrompt: buildExtractionPrompt,
        familyId: familyId || null,
        openid: openid,
        traceId: traceId
      }).then(function(aiRes) {
        if (aiRes.success) {
          return {
            idx: i + 1, fileId: item.fileId, success: true,
            policies: aiRes.policies || [],
            cashValueData: aiRes.cashValueData || null,
            documentType: aiRes.document_type || 'policy',
            tokens: aiRes.tokens || {}
          }
        }
        return {
          idx: i + 1, fileId: item.fileId, success: false,
          error: aiRes.error || 'AI提取失败', errorCode: aiRes.error_code || 'ai_exception'
        }
      }).catch(function(e) {
        // S2 修复：单张 aiPhase 抛异常时隔离失败，不影响其他张
        return {
          idx: i + 1, fileId: item.fileId, success: false,
          error: (e && e.message) || 'AI服务异常', errorCode: (e && e.code) || 'ai_exception'
        }
      })
    }
  })
  var results = await _withConcurrency(tasks, validResults.length)

  // 聚合 tokens（每张独立 AI 调用的 usage；ocr_empty 项无 tokens，仅统计有效项等价于遍历合并结果）
  var tokens = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  for (var k = 0; k < results.length; k++) {
    var t = results[k].tokens
    if (t) {
      tokens.prompt_tokens += t.prompt_tokens || 0
      tokens.completion_tokens += t.completion_tokens || 0
      tokens.total_tokens += t.total_tokens || 0
    }
  }

  return _finalizeBatch({ db, openid, familyId, traceId, ocrResults: ocr_results, emptyFileIds, batchResults: results, tokens: tokens, totalDurationMs: Date.now() - t0, aiCallCount: validResults.length, action: 'ai_extract_parallel' })
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
      // M1 修复：覆盖 idx 为原始位置 k+1，避免空项在前时 idx 错位
      merged.push(Object.assign({}, batchByFileId[fid], { idx: k + 1 }))
    } else {
      merged.push({ idx: k + 1, fileId: fid, success: false, error: '结果缺失', errorCode: 'ai_batch_failed' })
    }
  }
  return merged
}

/**
 * 公共后处理（R2 候选 2）：合并 → 统计 → logOperation → 返回（aiExtractBatch / aiExtractParallel 共用）
 * @param {object} p - { db, openid, familyId, ocrResults, emptyFileIds, batchResults, tokens, totalDurationMs, aiCallCount, action }
 */
function _finalizeBatch(p) {
  var mergedResults = _mergeBatchResults(p.ocrResults, p.batchResults, p.emptyFileIds)
  var successCount = 0, failCount = 0
  for (var k = 0; k < mergedResults.length; k++) {
    if (mergedResults[k].success) successCount++
    else failCount++
  }
  logOperation(p.db, {
    openid: p.openid, familyId: p.familyId || undefined, traceId: p.traceId || '', action: p.action,
    result: { status: failCount > 0 ? 'partial' : 'ok', summary: '提取 ' + p.ocrResults.length + '张, 成功' + successCount + '/失败' + failCount },
    meta: {
      total: p.ocrResults.length, validCount: mergedResults.length - p.emptyFileIds.length, emptyCount: p.emptyFileIds.length,
      successCount: successCount, failCount: failCount,
      aiCallCount: p.aiCallCount, totalDurationMs: p.totalDurationMs,
      tokens: p.tokens || {}
    }
  })
  return {
    code: 200,
    data: {
      results: mergedResults,
      total_duration_ms: p.totalDurationMs,
      split_used: false,
      ai_call_count: p.aiCallCount,
      tokens: p.tokens || {},
      success_count: successCount,
      fail_count: failCount
    }
  }
}

module.exports = { ocrOnly, aiExtractBatch, aiExtractParallel }
