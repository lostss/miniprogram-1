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
const { ocrPhase, aiPhase } = require('./_shared/ocr-core')
const { buildExtractionPrompt } = require('./prompts')
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

// OCR 专用频控（OCR 审计 H1）：guard.checkRateLimit 有意排除 OCR action（Bug-17：OCR 批量操作
// 不应耗尽对话限流配额），但 GeneralAccurateOCR 按次计费（约 0.5 元/次，单批最多 9 张 ≈ 4.5 元），
// 无用户级频控可被高频调用刷出账单。独立计数：每用户 60s 内最多 OCR_RATE_LIMIT_PER_MIN 批。
// 计数源 operation_logs（ocrOnly 每次调用末尾 logOperation 写入，action='ocr_only_batch'，created_at 字段）。
const OCR_RATE_LIMIT_PER_MIN = 10

async function _checkOcrRateLimit(db, openid) {
  if (!openid || !db || typeof db.collection !== 'function') return { allowed: true }
  try {
    const windowStart = new Date(Date.now() - 60000)
    const count = await db.collection('operation_logs').where({ openid, created_at: db.command.gte(windowStart), action: 'ocr_only_batch' }).count()
    if (count.total >= OCR_RATE_LIMIT_PER_MIN) return { allowed: false }
  } catch (e) { console.error('[ocrService] OCR 频控查询失败:', e.message) }
  return { allowed: true }
}

async function ocrOnly(db, openid, event) {
  const { fileIds, familyId } = event
  if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
    return { code: 400, msg: '缺少参数 fileIds' }
  }
  // OCR 审计 H1：计费 OCR 入口限流（防成本滥用；与对话限流独立计数，互不影响）
  const rl = await _checkOcrRateLimit(db, openid)
  if (!rl.allowed) {
    return { code: 429, msg: 'OCR 操作过于频繁，请稍后再试' }
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

// ======================== aiExtractParallel ========================
// aiExtractBatch 已收敛删除（2026-08-30）：单图路径统一走 aiExtractParallel（aiPhase/DeepSeek 直连），
// 备份已随 docs 归档清理（2026-09-04）。_prepareOcrInput 为并行提取前置。

// 公共前置：入参校验 + 空 ocrText 过滤 + 全空短路（aiExtractParallel）
// 返回 { error } | { allEmpty } | { validResults, emptyFileIds }
// M1：ocrText 长度上限（OCR 审计 M1）——正常单张 OCR 文本 < 5000 字，超长视为异常，
// 拒绝进入 AI 调用防异常大文本浪费 token（gateway sanitize 16000 截断仅为最后兜底）
const OCR_TEXT_MAX_LEN = 30000

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
    } else if (item.ocrText.length > OCR_TEXT_MAX_LEN) {
      emptyFileIds.push({ idx: i + 1, fileId: item && item.fileId, error_code: 'ocr_text_too_long' })
    } else {
      validResults.push(item)
    }
  }
  if (validResults.length === 0) {
    var allEmpty = emptyFileIds.map(function(e) {
      return { idx: e.idx, fileId: e.fileId, success: false, error: e.error_code === 'ocr_text_too_long' ? 'OCR文本过长，请更换清晰保单' : 'OCR识别结果为空', errorCode: e.error_code || 'ocr_empty' }
    })
    return {
      allEmpty: {
        results: allEmpty,
        total_duration_ms: 0,
        ai_call_count: 0,
        tokens: {},
        success_count: 0,
        fail_count: allEmpty.length
      }
    }
  }
  return { validResults: validResults, emptyFileIds: emptyFileIds }
}

// ======================== aiExtractParallel ========================
/**
 * DeepSeek 并行提取（每张图独立 AI 调用，N 张并发；单图时即单次调用，全链路唯一 AI 提取入口）
 * 入参：{ ocr_results: [{fileId, ocrText, ocrConfInfo, t0, t1, t2}], familyId? }
 * 出参：{ code, data: { results, total_duration_ms, ai_call_count, tokens, success_count, fail_count } }
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
    emptyByFileId[emptyFileIds[i].fileId] = emptyFileIds[i]
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
      var emp = emptyByFileId[fid]
      // M1：超长文本与空文本区分错误码（前端可分别提示"文本过长/识别为空"）
      merged.push({ idx: k + 1, fileId: fid, success: false, error: emp.error_code === 'ocr_text_too_long' ? 'OCR文本过长，请更换清晰保单' : 'OCR识别结果为空', errorCode: emp.error_code || 'ocr_empty' })
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
      ai_call_count: p.aiCallCount,
      tokens: p.tokens || {},
      success_count: successCount,
      fail_count: failCount
    }
  }
}

// ======================== ocrExtract（合并两阶段，2026-09-09） ========================
/**
 * 单次调用完成「OCR + AI 提取」，替代前端 ocrOnly → aiExtractParallel 两次 RPC
 * 入参：{ fileIds: string[], familyId? }
 * 出参：{ code, data: { results, ocr_texts, total_duration_ms, ai_call_count, tokens, success_count, fail_count } }
 *
 * 设计要点：
 *   - 省一次云函数往返/冷启动；ocrText 由双程传输降为单程
 *   - getTempFileURL 批量一次（原逐张调用最多 9 次）
 *   - ocr_texts 回传前端 → 重试时只重跑 aiExtractParallel，不重复计费 OCR
 *   - 仍写 action='ocr_only_batch' 日志：_checkOcrRateLimit 计数源不变
 */
async function ocrExtract(db, openid, event) {
  const { fileIds, familyId } = event
  if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
    return { code: 400, msg: '缺少参数 fileIds' }
  }
  const rl = await _checkOcrRateLimit(db, openid)
  if (!rl.allowed) {
    return { code: 429, msg: 'OCR 操作过于频繁，请稍后再试' }
  }
  if (fileIds.length > 9) {
    return { code: 400, msg: '单次最多 9 张图片' }
  }
  for (const fid of fileIds) {
    if (typeof fid !== 'string' || !fid.startsWith('cloud://')) {
      return { code: 400, msg: 'fileId 格式非法，必须为 cloud:// 协议' }
    }
    if (fid.indexOf('/temp/' + openid + '/') === -1) {
      return { code: 403, msg: '无权访问该文件' }
    }
  }

  const tStart = Date.now()

  // 批量临时链接（一次 API 调用）
  var urlMap = {}
  try {
    var tempRes = await cloud.getTempFileURL({ fileList: fileIds })
    // 优先用返回项 fileID，字段名不符时按入参顺序兜底（否则 urlMap 为空 → 退化为逐张换取）
    ;(tempRes.fileList || []).forEach(function(f, idx) {
      if (!f || !f.tempFileURL) return
      var key = f.fileID || fileIds[idx]
      if (key) urlMap[key] = f.tempFileURL
    })
  } catch (e) {
    console.error('[ocrService] getTempFileURL 批量失败:', e && e.message)
  }

  // OCR 并发
  var ocrOut = await Promise.all(fileIds.map(function(fid) {
    return ocrPhase({ cloud: cloud, fileId: fid, openid: openid, familyId: familyId || null, tempFileURL: urlMap[fid] })
      .then(function(r) { return { ok: true, data: r } })
      .catch(function(e) { return { ok: false, fileId: fid, error: (e && e.message) || 'OCR异常', error_code: 'ocr_failed' } })
  }))

  var ocrResults = [], ocrFailures = [], ocrTexts = {}
  for (var i = 0; i < ocrOut.length; i++) {
    var r = ocrOut[i]
    if (r.ok) {
      if (!r.data.ocrText || typeof r.data.ocrText !== 'string' || r.data.ocrText.length === 0) {
        ocrFailures.push(r.data.ocrErrorCode === 'ocr_service_error'
          ? { fileId: r.data.fileId, error: 'OCR 服务异常，请稍后重试', errorCode: 'ocr_service_error' }
          : { fileId: r.data.fileId, error: 'OCR识别结果为空', errorCode: 'ocr_empty' })
      } else {
        ocrResults.push(r.data)
        ocrTexts[r.data.fileId] = { ocrText: r.data.ocrText, ocrConfInfo: r.data.ocrConfInfo || [] }
      }
    } else {
      ocrFailures.push({ fileId: r.fileId, error: r.error, errorCode: r.error_code })
    }
  }

  // 限流计数源（_checkOcrRateLimit 查 action='ocr_only_batch'，不可改）
  logOperation(db, {
    openid, familyId: familyId || undefined, traceId: event._reqId || '', action: 'ocr_only_batch',
    result: { status: ocrFailures.length > 0 ? 'partial' : 'ok', summary: 'OCR ' + fileIds.length + '张, 成功' + ocrResults.length + '/失败' + ocrFailures.length },
    meta: { fileCount: fileIds.length, okCount: ocrResults.length, failCount: ocrFailures.length }
  })

  // AI 阶段：复用 aiExtractParallel（内部含 tokens 聚合 / 日志 / 错误码）
  var aiData = { results: [], tokens: {}, ai_call_count: 0 }
  if (ocrResults.length > 0) {
    var aiRes = await aiExtractParallel(db, openid, {
      ocr_results: ocrResults.map(function(x) {
        return { fileId: x.fileId, ocrText: x.ocrText, ocrConfInfo: x.ocrConfInfo, t0: x.t0, t1: x.t1, t2: x.t2 }
      }),
      familyId: familyId || '',
      _reqId: event._reqId || ''
    })
    if (aiRes && aiRes.code === 200 && aiRes.data) aiData = aiRes.data
  }

  // 按入参顺序合并（OCR 失败项 + AI 结果）
  var aiByFileId = {}, failByFileId = {}
  ;(aiData.results || []).forEach(function(x) { if (x && x.fileId) aiByFileId[x.fileId] = x })
  ocrFailures.forEach(function(f) { if (f.fileId) failByFileId[f.fileId] = f })

  var results = [], successCount = 0, failCount = 0
  for (var k = 0; k < fileIds.length; k++) {
    var fid2 = fileIds[k]
    var item
    if (failByFileId[fid2]) {
      item = { idx: k + 1, fileId: fid2, success: false, error: failByFileId[fid2].error, errorCode: failByFileId[fid2].errorCode }
    } else if (aiByFileId[fid2]) {
      item = Object.assign({}, aiByFileId[fid2], { idx: k + 1 })
    } else {
      item = { idx: k + 1, fileId: fid2, success: false, error: '结果缺失', errorCode: 'ai_batch_failed' }
    }
    if (item.success) successCount++
    else failCount++
    results.push(item)
  }

  return {
    code: 200,
    data: {
      results: results,
      ocr_texts: ocrTexts,
      total_duration_ms: Date.now() - tStart,
      ai_call_count: aiData.ai_call_count || 0,
      tokens: aiData.tokens || {},
      success_count: successCount,
      fail_count: failCount
    }
  }
}

module.exports = { ocrOnly, aiExtractParallel, ocrExtract }
