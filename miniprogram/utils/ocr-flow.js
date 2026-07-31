/**
 * ocr-flow.js — OCR 上传流程状态机 + 编排辅助函数
 *
 * 去重缓存：5分钟内同 policy_number 跳过重复 AI 调用。
 * 页面 onUnload 时调用 forgetDedupCache() 清空。
 */

// ============================================================
// 方案切换开关：'merged' = 批量拼接（1次AI）| 'parallel' = DeepSeek并行（每张1次AI）| 'pipeline' = 云端OCR→AI流水线 | 'split' = 原方案分批
// 实测：parallel（6.6s 云函数）快于 pipeline（8s 同实例争抢），为默认
// ============================================================
var OCR_BATCH_MODE = 'parallel'

var _dedupCache = new Map()
var DEDUP_TTL_MS = 5 * 60 * 1000

function registerDedup(policies) {
  if (!policies || !policies.length) return
  var now = Date.now()
  for (var i = 0; i < policies.length; i++) {
    var p = policies[i]
    if (p.policy_number) _dedupCache.set(p.policy_number, now)
  }
}

function isDedup(policyNumber) {
  if (!policyNumber) return false
  var ts = _dedupCache.get(policyNumber)
  if (!ts) return false
  if (Date.now() - ts > DEDUP_TTL_MS) { _dedupCache.delete(policyNumber); return false }
  return true
}

function forgetDedupCache() { _dedupCache.clear() }

// ============================================================
// API 客户端
// ============================================================
const api = require('./apiClient')

// ============================================================
// 状态机：patch 工厂（返回 setData 参数对象，字段名匹配测试契约）
// ============================================================
function defaultState() {
  return {
    visible: false, phase: '', totalPolicies: 0, confirming: false, inProgress: false,
    _policies: [], _cashValues: null, matched: false,
    'ocrMask.visible': false, 'ocrMask.phase': '', 'ocrMask.total': 0, 'ocrMask.uploaded': 0, 'ocrMask.processed': 0,
    'ocrMask.phaseText': '', 'ocrMask.inProgress': false,
    'ocrMask.confirming': false, 'ocrMask._policies': [], 'ocrMask._cashValues': null,
    'ocrMask.matched': false, 'ocrMask.familyId': '',
    'ocrMask.streamSlots': [], 'ocrMask.streamFilled': 0
  }
}
function start(total) { return { 'ocrMask.visible': true, 'ocrMask.phase': 'upload', 'ocrMask.total': total, 'ocrMask.uploaded': 0 } }
function setUploaded(n) { return { 'ocrMask.uploaded': n } }
function setRecognize() { return { 'ocrMask.phase': 'recognize', 'ocrMask.processed': 0 } }
function setProcessed(n) { return { 'ocrMask.processed': n } }
function setSaving() { return { 'ocrMask.phase': 'saving', 'ocrMask.processed': 100 } }
// 流式回填：初始化 N 个槽位（null 占位）+ 切换到 streaming phase
function setStreamingSlots(total) {
  return {
    'ocrMask.phase': 'recognize-stream',
    'ocrMask.total': total,
    'ocrMask.processed': 0,
    'ocrMask.streamSlots': new Array(total).fill(null),
    'ocrMask.streamFilled': 0
  }
}
// 流式回填：填入第 idx 槽位（policy 卡片 or 错误对象），返回 patch 对象
// 注意：直接返回完整 streamSlots 数组，避免 setData 路径表达式构造复杂字符串
function setFillSlot(prevSlots, idx, item, filledCount) {
  var slots = (prevSlots || []).slice()
  slots[idx] = item
  return {
    'ocrMask.streamSlots': slots,
    'ocrMask.streamFilled': filledCount,
    'ocrMask.processed': filledCount
  }
}
function setDone(policies, cashValues, extra) {
  var p = { 'ocrMask.phase': 'done', 'ocrMask.totalPolicies': (policies && policies.length) || 0, 'ocrMask._policies': policies || [], 'ocrMask._cashValues': cashValues || null }
  if (extra) { for (var k in extra) p[k] = extra[k] }
  return p
}
function hide() { return { 'ocrMask.visible': false, 'ocrMask.phase': '' } }
function setConfirming(v) { return { 'ocrMask.confirming': !!v } }
function reset() { return defaultState() }

// ============================================================
// 压缩
// ============================================================
function compress(path) {
  return new Promise(function(resolve, reject) {
    wx.compressImage({ src: path, quality: 65, success: function(res) { resolve(res.tempFilePath) }, fail: reject })
  })
}

// ============================================================
// 并发压缩 + 上传（限流5并发，单张失败不休止）
// ============================================================
async function compressAndUpload(paths, setData, prefix) {
  prefix = prefix || 'temp'
  var uploaded = 0
  var failures = 0
  var batchSize = 5
  var fileIds = new Array(paths.length)

  for (var b = 0; b < paths.length; b += batchSize) {
    var batch = paths.slice(b, Math.min(b + batchSize, paths.length))
    var tasks = batch.map(function(path, bi) {
      var i = b + bi
      return compress(path).then(function(f) {
        return wx.cloud.uploadFile({
          cloudPath: prefix + '/' + Date.now() + '_' + i + '.jpg',
          filePath: f
        }).then(function(r) {
          uploaded++
          setData(setUploaded(uploaded))
          return { ok: true, fileId: r.fileID, idx: i }
        })
      })
    })
    var results = await Promise.allSettled(tasks)
    for (var j = 0; j < results.length; j++) {
      var r = results[j]
      if (r.status === 'fulfilled' && r.value && r.value.ok) {
        fileIds[r.value.idx] = r.value.fileId
      } else {
        failures++
        var idx = r.value ? r.value.idx : (b + j)
        fileIds[idx] = null
      }
    }
  }
  return { fileIds: fileIds, failures: failures }
}

// ============================================================
// 方案 B：两阶段 OCR 流程（流式回填版）
//   阶段1：ocrOnly 并发 OCR 全部图片（无 AI，无 429 风险，~1.7s）
//   阶段2：分批 aiExtract（5 并发 + 跨批 AI 串行 + 指数退避 30s/90s）
//           批1 完成 → setData 占位槽位，用户先看到部分结果
//           批2 完成 → 等待批1 AI 结束 → 发起批2 AI → 填充剩余槽位
// 对外契约：返回 { policies, cashValues, errors }
// opts.onBatchComplete(filledCount, total) — 批次完成回调（可选）
// ============================================================

// 单图 AI 提取 + 指数退避重试（429 专用）
// 退避序列：30s → 90s（跨越 TPM 分钟窗口）；其他错误不重试
function _callAiWithRetry(ocrItem, familyId) {
  var attempt = 0
  function _call() {
    return api('aiExtract', {
      fileId: ocrItem.fileId,
      ocrText: ocrItem.ocrText,
      ocrConfInfo: ocrItem.ocrConfInfo,
      t0: ocrItem.t0, t1: ocrItem.t1, t2: ocrItem.t2,
      familyId: familyId || ''
    }).then(function(res) {
      var data = (res.result && res.result.code === 200) ? res.result.data : null
      if (!data) {
        return { policies: [], cash_value_data: null, error: (res.result && res.result.msg) || 'aiExtract失败', error_code: 'ocr_api_error' }
      }
      // 429 / RATE_LIMIT → 指数退避重试（跨越 TPM 分钟窗口）
      var code = data.error_code || ''
      if ((code === '429' || code === 'RATE_LIMIT') && attempt < 2) {
        attempt++
        var delay = attempt === 1 ? 30000 : 90000
        return new Promise(function(resolve) { setTimeout(function() { resolve(_call()) }, delay) })
      }
      return data
    }).catch(function(e) {
      // 网络异常/云函数超时：不退避重试（避免与下一张叠加并发）
      // 直接返回错误，由前端标记失败卡片，用户可手动重试
      return { policies: [], cash_value_data: null, error: (e && e.message) || 'aiExtract异常', error_code: 'ocr_exception' }
    })
  }
  return _call()
}

// 批次内单图 AI 提取：返回 { idx, policyCard | errorCard | cashValueCard | null }
// idx 是该图在 ocrResults 中的全局下标，用于回填到正确槽位
function _aiExtractOne(ocr, idx, familyId) {
  return _callAiWithRetry(ocr, familyId).then(function(v) {
    if (v.policies && v.policies.length > 0) {
      return { idx: idx, type: 'policy', data: v.policies[0], allPolicies: v.policies, cashValue: v.cash_value_data }
    }
    if (v.cash_value_data) {
      return { idx: idx, type: 'cash', data: v.cash_value_data }
    }
    return { idx: idx, type: 'error', data: { fileId: ocr.fileId, error: v.error || 'AI提取失败', error_code: v.error_code || 'ai_exception' } }
  }).catch(function(e) {
    return { idx: idx, type: 'error', data: { fileId: ocr.fileId, error: (e && e.message) || 'AI异常', error_code: 'ocr_exception' } }
  })
}

// ============================================================
// 方案 C：批量拼接提取 — 1 次 AI 调用完成全部提取
//   阶段1：ocrOnly 并发 OCR（复用，不变）
//   阶段2：1 次 aiExtractBatch + 一次性填充所有槽位
// 对外契约：返回 { policies, cashValues, errors }
// opts.onBatchComplete(filledCount, total) — 完成回调（可选）
// ============================================================
async function batchOCR_merged(fileIds, setData, opts, aiAction) {
  aiAction = aiAction || 'aiExtractBatch'
  opts = opts || {}
  var all = [], cashValues = [], errors = []
  var batchIds = fileIds.filter(function(id) { return id !== null })
  if (!batchIds.length) return { policies: [], cashValues: [], errors: [] }

  // 云端流水线（ocrExtractParallel）：OCR+AI 在云函数内重叠，无需前端 ocrOnly
  var pipeline = aiAction === 'ocrExtractParallel'

  var ocrResults = null
  if (!pipeline) {
    // ===== 阶段 1：ocrOnly 并发 OCR（无 AI，无 429） =====
    var ocrRes
    try {
      var ocrRaw = await api('ocrOnly', { fileIds: batchIds, familyId: opts.familyId || '' })
      if (!ocrRaw.result || ocrRaw.result.code !== 200) {
        return {
          policies: [], cashValues: [],
          errors: [{ error: (ocrRaw.result && ocrRaw.result.msg) || 'OCR阶段失败', error_code: 'ocr_api_error' }]
        }
      }
      ocrRes = ocrRaw.result.data
    } catch (e) {
      return { policies: [], cashValues: [], errors: [{ error: (e && e.message) || 'OCR异常', error_code: 'ocr_exception' }] }
    }

    ocrResults = ocrRes.ocr_results || []
    if (ocrRes.failures) { for (var f = 0; f < ocrRes.failures.length; f++) { errors.push(ocrRes.failures[f]) } }
    if (ocrResults.length === 0) return { policies: [], cashValues: [], errors: errors }
  }

  // ===== 初始化流式槽位（骨架屏，批量 AI 期间显示） =====
  var totalSlots = pipeline ? batchIds.length : (ocrResults ? ocrResults.length : 0)
  if (setData) setData(setStreamingSlots(totalSlots))

  // ===== 阶段 2：1 次批量 AI 调用（'aiExtractBatch' 拼接 | 'aiExtractParallel' 并行 | 'ocrExtractParallel' 流水线） =====
  var aiRes
  try {
    aiRes = await api(aiAction, pipeline
      ? { fileIds: batchIds, familyId: opts.familyId || '' }
      : { ocr_results: ocrResults, familyId: opts.familyId || '' })
  } catch (e) {
    return { policies: [], cashValues: [], errors: [{ error: (e && e.message) || aiAction + '异常', error_code: 'ocr_exception' }] }
  }

  var data = (aiRes.result && aiRes.result.code === 200) ? aiRes.result.data : null
  if (!data) {
    return {
      policies: [], cashValues: [],
      errors: [{ error: (aiRes.result && aiRes.result.msg) || 'aiExtractBatch失败', error_code: 'ocr_api_error' }]
    }
  }

  // ===== 阶段 3：一次性填充所有槽位 =====
  var results = data.results || []
  var streamSlots = new Array(totalSlots).fill(null)
  var filledCount = 0

  for (var i = 0; i < results.length; i++) {
    var r = results[i]
    // idx 1-based，slotIdx 0-based；防御性容错：r.idx 越界时按 i 兜底
    var slotIdx = (r.idx && r.idx >= 1 && r.idx <= totalSlots) ? (r.idx - 1) : i
    if (r.success) {
      if (r.policies && r.policies.length > 0) {
        streamSlots[slotIdx] = {
          kind: 'policy',
          product_name: r.policies[0].product_name,
          insurance_category: r.policies[0].insurance_category,
          low: !((r.policies[0].auto_confirmed !== false) && r.policies[0].confidence >= 0.95)
        }
        for (var k = 0; k < r.policies.length; k++) all.push(r.policies[k])
      }
      if (r.cash_value_data) {
        if (!streamSlots[slotIdx]) {
          streamSlots[slotIdx] = { kind: 'cash', product_name: r.cash_value_data.product_name || '现价表', low: false }
        }
        cashValues.push(r.cash_value_data)
      }
      if (!streamSlots[slotIdx]) {
        // success 但既无 policies 也无 cash_value_data：标记为空（防御性）
        streamSlots[slotIdx] = { kind: 'error', product_name: '识别失败', error_code: 'ai_empty', low: false }
      }
    } else {
      streamSlots[slotIdx] = { kind: 'error', product_name: '识别失败', error_code: r.error_code || r.errorCode, low: false }
      errors.push({ fileId: r.fileId, error: r.error || 'AI提取失败', error_code: r.error_code || r.errorCode })
    }
    filledCount++
  }

  // 一次性 setData 所有槽位
  if (setData) {
    setData({
      'ocrMask.streamSlots': streamSlots,
      'ocrMask.streamFilled': filledCount,
      'ocrMask.processed': filledCount
    })
  }
  if (opts.onBatchComplete) {
    try { opts.onBatchComplete(filledCount, totalSlots) } catch (e) {}
  }

  // ===== 客户端去重 =====
  var deduped = []
  for (var d = 0; d < all.length; d++) {
    var policy = all[d]
    if (policy.policy_number && isDedup(policy.policy_number)) {
      errors.push({ fileId: '', error: 'skip_duplicate:' + policy.policy_number, error_code: 'dedup:skipped' })
      continue
    }
    deduped.push(policy)
  }
  registerDedup(all)
  return { policies: deduped, cashValues: cashValues, errors: errors }
}

// ============================================================
// 方案 D：DeepSeek 并行提取 — N 张图每张独立 1 次 AI 调用（并发）
//   阶段1：ocrOnly 并发 OCR（复用）
//   阶段2：aiExtractParallel（云函数内并发调用 aiPhase）
//   填充逻辑与 batchOCR_merged 完全一致（results 格式对齐）
// ============================================================
async function batchOCR_parallel(fileIds, setData, opts) {
  return batchOCR_merged(fileIds, setData, opts, 'aiExtractParallel')
}

// ============================================================
// 方案 E：云端 OCR→AI 流水线并行（一次云函数调用，OCR 与 AI 时间重叠）
//   阶段1+2 合并：ocrExtractParallel（云函数内「OCR完成立即AI」并发）
//   填充逻辑与 batchOCR_merged 完全一致（results 格式对齐）
// ============================================================
async function batchOCR_pipeline(fileIds, setData, opts) {
  return batchOCR_merged(fileIds, setData, opts, 'ocrExtractParallel')
}

async function batchOCR(fileIds, setData, opts) {
  // 方案切换：'merged' = 批量拼接（1次AI）| 'parallel' = DeepSeek并行 | 'pipeline' = 云端OCR→AI流水线 | 'split' = 原方案分批
  if (OCR_BATCH_MODE === 'merged') {
    return batchOCR_merged(fileIds, setData, opts)
  }
  if (OCR_BATCH_MODE === 'parallel') {
    return batchOCR_parallel(fileIds, setData, opts)
  }
  if (OCR_BATCH_MODE === 'pipeline') {
    return batchOCR_pipeline(fileIds, setData, opts)
  }
  opts = opts || {}
  var all = []
  var cashValues = []
  var errors = []
  var batchIds = fileIds.filter(function(id) { return id !== null })
  if (!batchIds.length) return { policies: [], cashValues: [], errors: [] }

  // ===== 阶段 1：ocrOnly 并发 OCR（无 AI，无 429） =====
  var ocrRes
  try {
    var ocrRaw = await api('ocrOnly', { fileIds: batchIds, familyId: opts.familyId || '' })
    if (!ocrRaw.result || ocrRaw.result.code !== 200) {
      return {
        policies: [], cashValues: [],
        errors: [{ error: (ocrRaw.result && ocrRaw.result.msg) || 'OCR阶段失败', error_code: 'ocr_api_error' }]
      }
    }
    ocrRes = ocrRaw.result.data
  } catch (e) {
    return { policies: [], cashValues: [], errors: [{ error: (e && e.message) || 'OCR异常', error_code: 'ocr_exception' }] }
  }

  var ocrResults = ocrRes.ocr_results || []
  if (ocrRes.failures) { for (var f = 0; f < ocrRes.failures.length; f++) { errors.push(ocrRes.failures[f]) } }
  if (ocrResults.length === 0) return { policies: [], cashValues: [], errors: errors }

  // ===== 初始化流式槽位（null 占位，骨架屏） =====
  var totalSlots = ocrResults.length
  var streamSlots = new Array(totalSlots).fill(null)
  var filledCount = 0
  if (setData) setData(setStreamingSlots(totalSlots))

  // ===== 阶段 2：逐张串行 aiExtract（batchSize=1） =====
  // 实测验证：batchSize=5 时 5 张图 128s（排队），2 张图 126s（429 退避叠加）
  // TokenHub 实际行为是排队而非并发处理，batchSize 必须为 1
  // 保留流式回填：每张完成后立即 setData 填充槽位，用户逐张看到结果
  var batchSize = 1

  for (var b = 0; b < ocrResults.length; b += batchSize) {
    var batch = ocrResults.slice(b, Math.min(b + batchSize, ocrResults.length))
    var tasks = batch.map(function(ocr, i) {
      return _aiExtractOne(ocr, b + i, opts.familyId)
    })
    var results = await Promise.allSettled(tasks)
    // 处理本批结果：回填槽位
    for (var j = 0; j < results.length; j++) {
      var r = results[j]
      if (r.status === 'fulfilled' && r.value) {
        var v = r.value
        if (v.type === 'policy') {
          streamSlots[v.idx] = { kind: 'policy', product_name: v.data.product_name, insurance_category: v.data.insurance_category, low: !((v.data.auto_confirmed !== false) && v.data.confidence >= 0.95) }
          filledCount++
          // 收集所有保单（v.allPolicies 可能为多条，罕见但兼容）
          for (var k = 0; k < v.allPolicies.length; k++) all.push(v.allPolicies[k])
          if (v.cashValue) cashValues.push(v.cashValue)
        } else if (v.type === 'cash') {
          streamSlots[v.idx] = { kind: 'cash', product_name: v.data.product_name || '现价表', low: false }
          filledCount++
          cashValues.push(v.data)
        } else {
          streamSlots[v.idx] = { kind: 'error', product_name: '识别失败', error_code: v.data.error_code, low: false }
          filledCount++
          errors.push(v.data)
        }
      } else {
        var ocrItem = batch[j]
        streamSlots[b + j] = { kind: 'error', product_name: '识别异常', error_code: 'ocr_exception', low: false }
        filledCount++
        errors.push({ fileId: ocrItem.fileId, error: (r.reason && r.reason.message) || 'AI异常', error_code: 'ocr_exception' })
      }
      // 流式 setData：每填一个槽位就刷新（让用户看到逐张出现）
      if (setData) setData(setFillSlot(streamSlots, b + j, streamSlots[b + j], filledCount))
    }

    // 批次完成回调（让调用方知道当前进度）
    if (opts.onBatchComplete) {
      try { opts.onBatchComplete(filledCount, totalSlots) } catch (e) {}
    }
  }

  // ===== 客户端去重 =====
  var deduped = []
  for (var d = 0; d < all.length; d++) {
    var policy = all[d]
    if (policy.policy_number && isDedup(policy.policy_number)) {
      errors.push({ fileId: '', error: 'skip_duplicate:' + policy.policy_number, error_code: 'dedup:skipped' })
      continue
    }
    deduped.push(policy)
  }
  registerDedup(all)
  return { policies: deduped, cashValues: cashValues, errors: errors }
}

// ============================================================
// 纯现价表入库（带重试对话框，30s 超时）
// ============================================================
async function saveCashValuesWithRetry(familyId, cashValues, setData) {
  if (!cashValues || cashValues.length === 0) {
    setData(hide())
    return { ok: false, matched: false }
  }
  try {
    // A5 修复：循环入库全部现价表（原仅入库 cashValues[0]，多张现价表会丢失）
    var matchedAny = false
    for (var i = 0; i < cashValues.length; i++) {
      var res = await api('writeCashValue', { familyId: familyId, cash_value: cashValues[i] })
      var result = res.result || {}
      if (result.matched) matchedAny = true
    }
    setData(hide())
    return { ok: true, matched: matchedAny }
  } catch (e) {
    setData(hide())
    var timeoutId
    var choice = await Promise.race([
      new Promise(function(resolve) {
        wx.showModal({
          title: '现价表保存失败',
          content: (e.message || '').substring(0, 50),
          confirmText: '重试',
          cancelText: '取消',
          success: function(r) { resolve(r.confirm ? 'retry' : 'cancel') }
        })
      }),
      new Promise(function(resolve) { timeoutId = setTimeout(function() { resolve('timeout') }, 30000) })
    ])
    clearTimeout(timeoutId)
    if (choice !== 'retry') return { ok: false, matched: false }
    try {
      var matchedAny2 = false
      for (var j = 0; j < cashValues.length; j++) {
        var r2 = await api('writeCashValue', { familyId: familyId, cash_value: cashValues[j] })
        var result2 = r2.result || {}
        if (result2.matched) matchedAny2 = true
      }
      return { ok: true, matched: matchedAny2 }
    } catch (e2) {
      wx.showToast({ title: '现价表保存失败', icon: 'none' })
      return { ok: false, matched: false }
    }
  }
}

// ============================================================
// 确认写入保单
// ============================================================
async function confirmWritePolicies(familyId, policies, cashValues, setData) {
  setData(setSaving())
  try {
    var r = await api('writePoliciesBatch', { familyId: familyId, policies: policies, cash_values: cashValues })
    if (r.result && r.result.code === 200) {
      setData(hide())
      return { ok: true }
    }
    setData(hide())
    return { ok: false, error: (r.result && r.result.msg) || '写入失败' }
  } catch (e) {
    setData(hide())
    return { ok: false, error: e.message || '写入异常' }
  }
}

// ============================================================
// UI 错误提示
// ============================================================
// errorToUI — 把 error_code / 错误对象映射为用户可见文案
// 返回 { title, content }，由调用方决定 toast/modal 展示方式
function errorToUI(e) {
  var code = ''
  var msg = ''
  if (typeof e === 'string') {
    code = e
  } else if (e && e.error_code) {
    code = e.error_code
    msg = e.error || ''
  } else if (e && e.message) {
    msg = e.message
  }

  var title = '识别失败'
  var content = msg || '请重试'

  if (code === '429' || code === 'RATE_LIMIT') {
    title = 'AI服务繁忙'
    content = '请稍后重试'
  } else if (code === 'TIMEOUT' || code === 'CHAT_TIMEOUT') {
    title = 'AI服务超时'
    content = '请重试'
  } else if (code === 'ai_format') {
    title = 'AI返回格式错误'
    content = '请重试'
  } else if (code === 'ai_batch_failed') {
    title = 'AI批量提取失败'
    content = msg || 'AI 服务异常，请重试'
  } else if (code === 'ai_extract_failed') {
    title = 'AI提取失败'
    content = msg || '该图 AI 提取失败，可重试'
  } else if (code === 'ai_length_mismatch') {
    title = 'AI返回结果不完整'
    content = '请重试'
  } else if (code === 'ai_exception') {
    title = 'AI服务异常'
    content = '请重试'
  } else if (code === 'ocr_api_error') {
    title = '云函数调用失败'
    content = msg || '请确认云函数已部署后重试'
  } else if (code === 'ocr_exception' || code === 'ocr_failed') {
    title = 'OCR识别异常'
    content = msg || '请重试'
  } else if (code === 'ocr_empty') {
    title = 'OCR识别结果为空'
    content = '请确认图片清晰后重试'
  } else if (code === 'not_policy') {
    title = '非保单图片'
    content = '当前图片未识别到保单信息'
  } else if (code && code.indexOf('dedup:') === 0) {
    title = '重复保单'
    content = '该保单已识别过'
  }

  if (content.length > 80) content = content.substring(0, 77) + '...'
  return { title: title, content: content }
}

// ============================================================
// 清理临时文件
// ============================================================
function cleanupTempFiles(fileIds) {
  var ids = fileIds || []
  if (!ids.length) return
  wx.cloud.deleteFile({ fileList: ids }).catch(function() {})
}

module.exports = {
  defaultState,
  start, setUploaded, setRecognize, setProcessed, setSaving, setDone, setConfirming, hide, reset,
  setStreamingSlots, setFillSlot,
  compress,
  compressAndUpload,
  batchOCR,
  batchOCR_merged,
  batchOCR_parallel,
  batchOCR_pipeline,
  OCR_BATCH_MODE,
  saveCashValuesWithRetry,
  confirmWritePolicies,
  errorToUI,
  cleanupTempFiles,
  registerDedup,
  isDedup,
  forgetDedupCache
}
