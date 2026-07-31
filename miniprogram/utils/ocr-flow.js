/**
 * ocr-flow.js — OCR 上传流程状态机 + 编排辅助函数
 */

// ============================================================
// 模型分流（用户决策 2026-08）：1 张 → aiExtractBatch（hy3, 1次调用）
// >1 张 → aiExtractParallel（DeepSeek 直连, 每张1次并发）
// 拼接（多张 1 次 AI）已弃用；aiExtractBatch 仅服务单图
// ============================================================
// API 客户端
// ============================================================
const api = require('./apiClient')
// 置信度判定（单一真相源，与 ocr-confidence 同步）
const { assessPolicy } = require('./ocr-confidence')

// ============================================================
// 状态机：patch 工厂（返回 setData 参数对象，字段名匹配测试契约）
// ============================================================
function defaultState() {
  // 作为 data.ocrMask 初始对象赋值（非 setData patch），返回扁平字段（不带 ocrMask. 前缀）
  return {
    visible: false, phase: '', total: 0, uploaded: 0, processed: 0, totalPolicies: 0,
    phaseText: '',
    confirming: false, _policies: [], _cashValues: null,
    matched: false,
    streamSlots: [], streamFilled: 0, elapsed: 0
  }
}
function start(total) { return { 'ocrMask.visible': true, 'ocrMask.phase': 'upload', 'ocrMask.total': total, 'ocrMask.uploaded': 0, 'ocrMask.elapsed': 0 } }
function setUploaded(n) { return { 'ocrMask.uploaded': n } }
function setSaving() { return { 'ocrMask.phase': 'saving' } }
// OCR 子阶段（batchOCR 阶段1：纯文字识别，无 AI）
function setRecognizing() { return { 'ocrMask.phase': 'recognize', 'ocrMask.phaseText': '正在文字识别…', 'ocrMask.processed': 0, 'ocrMask.elapsed': 0 } }
// 流式回填：初始化 N 个槽位（null 占位）+ 切换到 streaming phase
// thumbs: 与 fileIds 对齐的本地缩略图路径数组（失败后可定位是哪张图）
function setStreamingSlots(total, thumbs) {
  var slots = new Array(total).fill(null)
  if (thumbs && thumbs.length > 0) {
    for (var i = 0; i < total; i++) {
      slots[i] = { kind: 'pending', thumb: thumbs[i] || '' }
    }
  }
  return {
    'ocrMask.phase': 'recognize-stream',
    'ocrMask.total': total,
    'ocrMask.processed': 0,
    'ocrMask.phaseText': 'AI 正在提取保单信息…',
    'ocrMask.streamSlots': slots,
    'ocrMask.streamFilled': 0,
    'ocrMask.elapsed': 0
  }
}
function setDone(policies, cashValues, extra) {
  var p = { 'ocrMask.visible': true, 'ocrMask.phase': 'done', 'ocrMask.totalPolicies': (policies && policies.length) || 0, 'ocrMask._policies': policies || [], 'ocrMask._cashValues': cashValues || null }
  if (extra) { for (var k in extra) p[k] = extra[k] }
  return p
}
function setFailed(msg) { return { 'ocrMask.visible': true, 'ocrMask.phase': 'failed', 'ocrMask.saveError': msg || '请检查网络后重试' } }
function hide() { return { 'ocrMask.visible': false, 'ocrMask.phase': '' } }
function setConfirming(v) { return { 'ocrMask.confirming': !!v } }
// 重置：defaultState 扁平字段 → setData patch（带 ocrMask. 前缀）
function reset() {
  var p = {}
  var st = defaultState()
  for (var k in st) p['ocrMask.' + k] = st[k]
  return p
}

// ============================================================
// 压缩
// ============================================================
function compress(path) {
  return new Promise(function(resolve, reject) {
    // <2MB 不压缩，避免密集小字保单二次压缩损失精度
    wx.getFileInfo({
      filePath: path,
      success: function(info) {
        if (info.size <= 2 * 1024 * 1024) { resolve(path); return }
        wx.compressImage({ src: path, quality: 80, success: function(res) { resolve(res.tempFilePath) }, fail: reject })
      },
      fail: reject
    })
  })
}

// ============================================================
// 并发压缩 + 上传（限流9并发，单张失败不休止）
// ============================================================
async function compressAndUpload(paths, setData, prefix) {
  prefix = prefix || 'temp'
  var uploaded = 0
  var failures = 0
  var batchSize = 9
  var fileIds = new Array(paths.length)
  var localPaths = new Array(paths.length) // 压缩后的本地路径（缩略图/重试用，不依赖云存储）

  for (var b = 0; b < paths.length; b += batchSize) {
    var batch = paths.slice(b, Math.min(b + batchSize, paths.length))
    var tasks = batch.map(function(path, bi) {
      var i = b + bi
      return compress(path).then(function(f) {
        localPaths[i] = f
        return wx.cloud.uploadFile({
          // cloudPath 加随机段，避免多用户同时上传时 Date.now()+i 碰撞导致文件覆盖
          cloudPath: prefix + '/' + Date.now() + '_' + Math.random().toString(36).substr(2, 8) + '_' + i + '.jpg',
          filePath: f
        }).then(function(r) {
          uploaded++
          if (setData) setData(setUploaded(uploaded))
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
  return { fileIds: fileIds, localPaths: localPaths, failures: failures }
}

// ============================================================
// 方案 B（逐张串行 aiExtract）已移除：hy3 限流后串行退避耗时过长，
// 统一走方案 C（批量拼接，1 次 AI）或方案 D（DeepSeek 并行，N 次 AI）
// ============================================================

// ============================================================
// 方案 C/D 共用批量提取入口 — 1 次 AI 调用完成全部提取
//   阶段1：ocrOnly 并发 OCR（无 AI，无 429）
//   阶段2：1 次 AI 调用（aiAction='aiExtractBatch' 走 hy3 拼接 | 'aiExtractParallel' 走 DeepSeek 并行）
//           + 一次性填充所有槽位
// 对外契约：返回 { policies, cashValues, errors }
// ============================================================
async function batchOCR_merged(fileIds, setData, opts, aiAction) {
  aiAction = aiAction || 'aiExtractBatch'
  opts = opts || {}
  var all = [], cashValues = [], errors = []
  var batchIds = fileIds.filter(function(id) { return id !== null })
  if (!batchIds.length) return { policies: [], cashValues: [], errors: [] }

  // ===== 阶段 1：ocrOnly 并发 OCR（无 AI，无 429） =====
  // 阶段分离提示：OCR（文字识别）→ setStreamingSlots（AI 提取）→ 填充
  if (setData) setData(setRecognizing())
  var ocrRes
  try {
    var ocrRaw = await api('ocrOnly', { fileIds: batchIds, familyId: opts.familyId || '' })
    if (!ocrRaw.ok) {
      return {
        policies: [], cashValues: [],
        errors: batchIds.map(function(fid) { return { fileId: fid, error: ocrRaw.msg || 'OCR阶段失败', error_code: 'ocr_api_error' } })
      }
    }
    ocrRes = ocrRaw.data
  } catch (e) {
    return { policies: [], cashValues: [], errors: batchIds.map(function(fid) { return { fileId: fid, error: (e && e.message) || 'OCR异常', error_code: 'ocr_exception' } }) }
  }

  var ocrResults = ocrRes.ocr_results || []
  if (ocrRes.failures) { for (var f = 0; f < ocrRes.failures.length; f++) { errors.push(ocrRes.failures[f]) } }
  if (ocrResults.length === 0) return { policies: [], cashValues: [], errors: errors }

  // ===== 初始化流式槽位（骨架屏，批量 AI 期间显示） =====
  var totalSlots = ocrResults.length
  if (setData) setData(setStreamingSlots(totalSlots, opts.thumbs))

  // ===== 阶段 2：1 次批量 AI 调用（'aiExtractBatch' 拼接 | 'aiExtractParallel' 并行） =====
  // AI 批量提取可能遇到 hy3 限流退避（retry-after 等待），前端默认 30s 超时不够，单独设为 90s
  var aiRes
  try {
    aiRes = await api(aiAction, { ocr_results: ocrResults, familyId: opts.familyId || '' }, { timeout: 90000 })
  } catch (e) {
    // AI 阶段异常（超时/网络/云函数未捕获）：错误码用 ai_exception，避免误报为 OCR 异常
    return { policies: [], cashValues: [], errors: errors.concat(ocrResults.map(function(r) { return { fileId: r.fileId, error: (e && e.message) || aiAction + '异常', error_code: 'ai_exception' } })) }
  }

  var data = aiRes.ok ? aiRes.data : null
  if (!data) {
    return {
      policies: [], cashValues: [],
      errors: errors.concat(ocrResults.map(function(r) { return { fileId: r.fileId, error: aiRes.msg || 'aiExtractBatch失败', error_code: 'ai_exception' } }))
    }
  }

  // ===== 阶段 3：一次性填充所有槽位 =====
  var results = data.results || []
  var streamSlots = new Array(totalSlots).fill(null)
  var filledCount = 0
  // 缩略图：initThumbs 与 fileIds 对齐（setStreamingSlots 时暂存在局部）
  var thumbs = opts.thumbs || []

  for (var i = 0; i < results.length; i++) {
    var r = results[i]
    // idx 1-based，slotIdx 0-based；防御性容错：r.idx 越界时按 i 兜底
    var slotIdx = (r.idx && r.idx >= 1 && r.idx <= totalSlots) ? (r.idx - 1) : i
    var slotThumb = thumbs[slotIdx] || ''
    if (r.success) {
      if (r.policies && r.policies.length > 0) {
        streamSlots[slotIdx] = {
          kind: 'policy',
          thumb: slotThumb,
          product_name: r.policies[0].product_name,
          insurance_category: r.policies[0].insurance_category,
          low: !((r.policies[0].auto_confirmed !== false) && r.policies[0].confidence >= 0.95)
        }
        for (var k = 0; k < r.policies.length; k++) all.push(r.policies[k])
      }
      if (r.cashValueData) {
        if (!streamSlots[slotIdx]) {
          streamSlots[slotIdx] = { kind: 'cash', thumb: slotThumb, product_name: r.cashValueData.product_name || '现价表', low: false }
        }
        cashValues.push(r.cashValueData)
      }
      if (!streamSlots[slotIdx]) {
        // success 但既无 policies 也无 cashValueData：标记为空（防御性）
        streamSlots[slotIdx] = { kind: 'error', thumb: slotThumb, product_name: '识别失败', error_code: 'ai_empty', low: false }
        // S3-2 修复：同步推入 errors 数组，否则调用方依赖 errors 时 errorToUI 收到 null，ai_empty 分支无法触发
        errors.push({ fileId: r.fileId, error: 'AI返回内容为空', error_code: 'ai_empty' })
      }
    } else {
      streamSlots[slotIdx] = { kind: 'error', thumb: slotThumb, product_name: '识别失败', error_code: r.error_code || r.errorCode, low: false }
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
  return { policies: all, cashValues: cashValues, errors: errors }
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

async function batchOCR(fileIds, setData, opts) {
  // 按张数分流（拼接已弃用，模型绑定张数）：
  //   1 张 → hy3（aiExtractBatch，1 次调用）
  //   >1 张 → DeepSeek 并发（aiExtractParallel，每张 1 次）
  var batchIds = fileIds.filter(function(id) { return id !== null })
  if (batchIds.length > 1) {
    return batchOCR_parallel(fileIds, setData, opts)
  }
  return batchOCR_merged(fileIds, setData, opts)
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
      var result = res.data || {}
      if (result.matched) matchedAny = true
    }
    setData(hide())
    return { ok: true, matched: matchedAny }
  } catch (e) {
    setData(hide())
    // S5 修复：移除 30s 超时竞速 — wx.showModal 无编程式关闭 API，超时后 modal 会成为孤儿
    var choice = await new Promise(function(resolve) {
      wx.showModal({
        title: '现价表保存失败',
        content: (e.message || '').substring(0, 50),
        confirmText: '重试',
        cancelText: '取消',
        success: function(r) { resolve(r.confirm ? 'retry' : 'cancel') }
      })
    })
    if (choice !== 'retry') return { ok: false, matched: false }
    try {
      var matchedAny2 = false
      for (var j = 0; j < cashValues.length; j++) {
        var r2 = await api('writeCashValue', { familyId: familyId, cash_value: cashValues[j] })
        var result2 = r2.data || {}
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
    if (r.ok) {
      setData(hide())
      return { ok: true }
    }
    // S4 修复：失败路径不 hide，由调用方决定 UI（保留确认卡让用户重试）
    return { ok: false, error: r.msg || '写入失败' }
  } catch (e) {
    // S4 修复：异常路径不 hide，由调用方决定 UI
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
  } else if (code === 'ai_empty') {
    title = 'AI返回内容为空'
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
    title = '未识别到文字'
    content = '请确认图片清晰后重试'
  } else if (code === 'not_policy') {
    title = '非保单图片'
    content = '当前图片未识别到保单信息'
  }

  if (content.length > 80) content = content.substring(0, 77) + '...'
  return { title: title, content: content }
}

// errorLabel — 错误码 → 用户可见短文案（失败槽位用，不显示 ai_format/429 等技术码）
function errorLabel(code) {
  var ui = errorToUI(code)
  return ui.title
}

// ============================================================
// classifyBatchResults — 识别结果分流分组（收编 _procRefresh，纯函数可单测）
// 输入：policies（AI 提取结果）、cashValues（现价表）、errors（失败项）、thumbMap（fileId→缩略图）
// 输出：{ success, review, error } 三组确认卡
//   - success: 高置信保单 + 现价表（assessPolicy 判定 low=false）
//   - review:  需人工核对保单（low=true，逐字段/整体置信度 <0.9）
//   - error:   识别失败项（error_code → 文案 + 缩略图回退）
// ============================================================
function classifyBatchResults(policies, cashValues, errors, thumbMap) {
  var success = []
  var review = []
  ;(policies || []).forEach(function(p, pi) {
    var low = assessPolicy(p)
    var card = {
      kind: 'policy',
      policyIndex: pi,
      product_name: p.product_name || '未知保单',
      insurance_category: p.insurance_category || '',
      effective_date: p.effective_date || '',
      confidence: p.confidence || 0,
      low: low,
      thumb: ''
    }
    if (low) review.push(card); else success.push(card)
  })
  ;(cashValues || []).forEach(function(cv) {
    success.push({ kind: 'cash', policyIndex: -1, product_name: cv.product_name || '现价表', insurance_category: '现金价值表', effective_date: '', confidence: 0, low: false, thumb: '' })
  })
  var errorCards = (errors || []).map(function(e) {
    var ec = e.error_code || 'ocr_exception'
    return { fileId: e.fileId, thumb: e.thumb || (thumbMap && thumbMap[e.fileId]) || '', error: errorLabel(ec) || '识别失败', retrying: false }
  })
  return { success: success, review: review, error: errorCards }
}

// ============================================================
// 清理临时文件
// ============================================================
function cleanupTempFiles(fileIds) {
  var ids = fileIds || []
  if (!ids.length) return
  wx.cloud.deleteFile({ fileList: ids }).catch(function() {})
}

// 失败保留文件台账：记录 fileId + 时间戳（识别失败保留供重试）
const TEMP_RETENTION_KEY = 'ocrTempRetention'
const TEMP_RETENTION_MS = 7 * 24 * 3600 * 1000 // 7 天

function _readRetention() {
  try { return wx.getStorageSync(TEMP_RETENTION_KEY) || [] } catch (e) { return [] }
}
function _writeRetention(list) {
  try { wx.setStorageSync(TEMP_RETENTION_KEY, list.slice(-100)) } catch (e) {}
}

function rememberFailedFiles(fileIds) {
  var ids = (fileIds || []).filter(Boolean)
  if (!ids.length) return
  var now = Date.now()
  var list = _readRetention()
  var seen = {}
  list.forEach(function(x) { seen[x.fileId] = true })
  ids.forEach(function(id) {
    if (!seen[id]) { list.push({ fileId: id, ts: now }); seen[id] = true }
  })
  _writeRetention(list)
}

// 机会式过期清理：上传流程启动时调用，删除保留超 7 天的失败文件
function cleanupExpiredTemp() {
  var list = _readRetention()
  if (!list.length) return
  var now = Date.now()
  var expired = list.filter(function(x) { return now - (x.ts || 0) >= TEMP_RETENTION_MS })
  if (!expired.length) return
  _writeRetention(list.filter(function(x) { return now - (x.ts || 0) < TEMP_RETENTION_MS }))
  wx.cloud.deleteFile({ fileList: expired.map(function(x) { return x.fileId }) }).catch(function() {})
}

module.exports = {
  defaultState,
  start, setUploaded, setSaving, setDone, setFailed, setConfirming, hide, reset,
  setStreamingSlots,
  compress,
  compressAndUpload,
  batchOCR,
  batchOCR_parallel,
  saveCashValuesWithRetry,
  confirmWritePolicies,
  errorToUI, errorLabel,
  cleanupTempFiles,
  rememberFailedFiles,
  cleanupExpiredTemp,
  classifyBatchResults
}
