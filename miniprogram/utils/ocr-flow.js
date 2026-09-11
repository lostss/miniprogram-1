/**
 * ocr-flow.js — OCR 上传流程状态机 + 编排辅助函数
 */

// ============================================================
// 模型分流（2026-08-30 收敛）：1 张与 N 张统一 aiExtractParallel（DeepSeek 直连）
// ============================================================
// API 客户端
// ============================================================
const api = require('./apiClient')
// 领域写薄层（候选 5）：批量保单写参数形状收口（cashValues → cash_values）
const { writePoliciesBatch } = require('./domain-writes')
// 置信度判定（单一真相源，与 ocr-confidence 同步）
const { assessPolicy } = require('./ocr-confidence')

// 日志审计 #1：OCR 会话 traceId（随各 API 透传 _reqId，云函数写入日志 trace_id 串联全链路）
var _lastReqId = ''
function _genReqId() { return 'ocr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) }

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
// 审计修复：每批 OCR 开始即重置 confirming——failed 相"放弃本次"未复位 confirming 时，新批次"全部确认"会永久灰死
function start(total) { return { 'ocrMask.visible': true, 'ocrMask.phase': 'upload', 'ocrMask.confirming': false, 'ocrMask.total': total, 'ocrMask.uploaded': 0, 'ocrMask.elapsed': 0 } }
function setUploaded(n) { return { 'ocrMask.uploaded': n } }
function setSaving() { return { 'ocrMask.phase': 'saving' } }
// OCR 子阶段（batchOCR 阶段1：纯文字识别，无 AI）
function setRecognizing(total) { return { 'ocrMask.phase': 'recognize', 'ocrMask.phaseText': total ? '正在识别 ' + total + ' 张图片…' : '正在文字识别…', 'ocrMask.processed': 0, 'ocrMask.elapsed': 0 } }
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
    'ocrMask.phaseText': '正在提取 ' + total + ' 张图片的保单信息…',
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
// ============================================================
// OCR 文本缓存（重试复用，2026-09-09）
// 目的：AI 阶段失败重试时只重跑 aiExtractParallel，不重复 OCR 计费（约 0.5 元/张）
// 仅内存持有（不落 storage，避免 PII 明文持久化）；跨会话恢复无缓存时回退完整链路
// ============================================================
var _ocrTextCache = {}
var OCR_TEXT_CACHE_MAX = 18 // 两批上限，防内存膨胀
function _cacheOcrTexts(map) {
  if (!map || typeof map !== 'object') return
  Object.keys(map).forEach(function(fid) { _ocrTextCache[fid] = map[fid] })
  var keys = Object.keys(_ocrTextCache)
  if (keys.length > OCR_TEXT_CACHE_MAX) {
    keys.slice(0, keys.length - OCR_TEXT_CACHE_MAX).forEach(function(k) { delete _ocrTextCache[k] })
  }
}
function getCachedOcrText(fileId) { return (fileId && _ocrTextCache[fileId]) || null }
function clearCachedOcrText(fileId) { if (fileId) delete _ocrTextCache[fileId] }

// 批量提取入口（单通道，2026-09-09 合并两阶段）：1 张与 N 张统一走 ocrExtract
//   云端一次调用内完成：批量临时链接 → OCR 并发 → AI 提取并发 → 一次性填充所有槽位
// 对外契约：返回 { policies, cashValues, errors }
// ============================================================
async function batchOCR(fileIds, setData, opts) {
  opts = opts || {}
  // 日志审计 #1：本次 OCR 会话生成 traceId（OCR→提取→保存全链串联）
  _lastReqId = _genReqId()
  var reqId = _lastReqId
  var all = [], cashValues = [], errors = []
  var batchIds = fileIds.filter(function(id) { return id !== null })
  if (!batchIds.length) return { policies: [], cashValues: [], errors: [] }

  // ===== 单次调用：OCR + AI 提取（2026-09-09 合并两阶段） =====
  // 原 ocrOnly + aiExtractParallel 两次 RPC 合并为 ocrExtract：省一次云函数往返/冷启动，
  // ocrText 由双程传输降为单程；getTempFileURL 在云端批量一次（原逐张最多 9 次）。
  if (setData) setData(setRecognizing(batchIds.length))
  var raw
  try {
    // 网络审计：ocrService 平台超时上限 60s，前端 70s 略大于平台（原 100s 永不触发是无效配置；
    // 也不宜改为 60s 相等——前端 timer 与平台同时超时，race 可能先拿到 timeout 丢真实错误码）
    // 2026-09-10 traceId 修复：原实现生成 reqId 却只挂在写入调用上，OCR/AI 这两次主调用缺 trace_id，
    // 云端日志无法与前端的识别会话串联（reqId 变量此前是死变量）
    raw = await api('ocrExtract', { fileIds: batchIds, familyId: opts.familyId || '' }, { timeout: 70000, requestId: reqId })
  } catch (e) {
    return { policies: [], cashValues: [], errors: batchIds.map(function(fid) { return { fileId: fid, error: (e && e.message) || 'OCR异常', error_code: 'ocr_exception' } }) }
  }
  if (!raw || !raw.ok) {
    return { policies: [], cashValues: [], errors: batchIds.map(function(fid) { return { fileId: fid, error: (raw && raw.msg) || 'OCR阶段失败', error_code: 'ocr_api_error' } }) }
  }

  var data = raw.data || {}
  // OCR 文本缓存：AI 阶段失败重试时只重跑 aiExtractParallel，不重复计费 OCR
  _cacheOcrTexts(data.ocr_texts)

  // ===== 初始化流式槽位（骨架屏） =====
  // 槽位按入参张数（含失败项），与 fileIds/thumbs 对齐
  var totalSlots = batchIds.length
  if (setData) setData(setStreamingSlots(totalSlots, opts.thumbs))

  // ===== 一次性填充所有槽位 =====
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
          // P2-12 修复：统一走 assessPolicy（ocr-confidence 单一真相源），原内联 0.95 双条件与确认卡分组判定漂移
          low: assessPolicy(r.policies[0])
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

// 仅重跑 AI 阶段（重试复用已缓存的 OCR 文本，省一次 OCR 计费）
// 入参 ocrItems: [{ fileId, ocrText, ocrConfInfo }]；出参与 batchOCR 一致
// 按 ocrItems 逐文件生成错误项（2026-09-10）：批量失败时保证每个 fileId 都有对应错误项，
// 调用方按 fileId 回填槽位不再出现"只有第一张被标记失败、其余悬空"
function _allFileErrors(ocrItems, msg, code) {
  var list = Array.isArray(ocrItems) ? ocrItems : []
  if (!list.length) return [{ fileId: '', error: msg, error_code: code }]
  return list.map(function(it) { return { fileId: (it && it.fileId) || '', error: msg, error_code: code } })
}

async function retryAiOnly(ocrItems, opts) {
  opts = opts || {}
  _lastReqId = _genReqId()
  var raw
  try {
    // 2026-09-10 traceId 修复：同 batchOCR——AI 提取是排查成本最高的调用，必须带 _reqId
    raw = await api('aiExtractParallel', { ocr_results: ocrItems, familyId: opts.familyId || '' }, { timeout: 70000, requestId: _lastReqId })
  } catch (e) {
    // 2026-09-10 错误粒度修复：原只回报首个 fileId，调用方按 fileId 回填槽位时其余图片悬空
    return { policies: [], cashValues: [], errors: _allFileErrors(ocrItems, (e && e.message) || 'AI提取异常', 'ai_exception') }
  }
  if (!raw || !raw.ok || !raw.data) {
    return { policies: [], cashValues: [], errors: _allFileErrors(ocrItems, (raw && raw.msg) || 'AI提取失败', 'ai_exception') }
  }
  var results = raw.data.results || []
  var all = [], cashValues = [], errors = []
  for (var i = 0; i < results.length; i++) {
    var r = results[i]
    if (r.success) {
      if (r.policies && r.policies.length) { for (var k = 0; k < r.policies.length; k++) all.push(r.policies[k]) }
      if (r.cashValueData) cashValues.push(r.cashValueData)
      if ((!r.policies || !r.policies.length) && !r.cashValueData) {
        errors.push({ fileId: r.fileId, error: 'AI返回内容为空', error_code: 'ai_empty' })
      }
    } else {
      errors.push({ fileId: r.fileId, error: r.error || 'AI提取失败', error_code: r.error_code || r.errorCode })
    }
  }
  return { policies: all, cashValues: cashValues, errors: errors }
}

// ============================================================
// 纯现价表入库（带重试对话框，30s 超时）
// ============================================================
// 单张现价表写入（并行单元；单项失败独立捕获返回 err，不中断其它表）
function _writeCashValueOne(familyId, cv, withReqId) {
  const opts = { timeout: 60000, retries: 0 }
  if (withReqId) opts.requestId = _lastReqId
  return api('writeCashValue', { familyId: familyId, cash_value: cv }, opts)
    .then(function (r) { return { matched: !!(r && r.data && r.data.matched), err: null } })
    .catch(function (e) { return { matched: false, err: e } })
}

async function saveCashValuesWithRetry(familyId, cashValues, setData) {
  if (!cashValues || cashValues.length === 0) {
    setData(hide())
    return { ok: false, matched: false }
  }
  // P2-8（性能 2026-09-05）：并行入库全部现价表（原 for 串行，多张叠加到分钟级）；
  // 失败仅记录索引供重放，成功项不再重复写（writeCashValue 幂等覆盖，原重试从 0 全量重放）
  const firstRound = await Promise.all(cashValues.map(function (cv) { return _writeCashValueOne(familyId, cv, true) }))
  const failedIdx = []
  let matchedAny = false
  firstRound.forEach(function (r, i) { if (r.err) failedIdx.push(i); else if (r.matched) matchedAny = true })
  if (failedIdx.length === 0) {
    setData(hide())
    return { ok: true, matched: matchedAny }
  }
  setData(hide())
  const firstErr = firstRound.find(function (r) { return r.err })
  // S5 修复：移除 30s 超时竞速 — wx.showModal 无编程式关闭 API，超时后 modal 会成为孤儿
  const choice = await new Promise(function(resolve) {
    wx.showModal({
      title: '现价表保存失败',
      content: ((firstErr && firstErr.err && firstErr.err.message) || '未知错误').substring(0, 50),
      confirmText: '重试',
      cancelText: '取消',
      success: function(r) { resolve(r.confirm ? 'retry' : 'cancel') }
    })
  })
  if (choice !== 'retry') return { ok: false, matched: matchedAny }
  // 仅重放失败的表（成功项已入库不重复写）
  const retried = await Promise.all(failedIdx.map(function (i) { return _writeCashValueOne(familyId, cashValues[i], false) }))
  const stillFailed = retried.some(function (r) { return r.err })
  retried.forEach(function (r) { if (r.matched) matchedAny = true })
  if (stillFailed) {
    wx.showToast({ title: '部分现价表保存失败', icon: 'none' })
    return { ok: false, matched: matchedAny }
  }
  return { ok: true, matched: matchedAny }
}

// ============================================================
// 确认写入保单
// ============================================================
async function confirmWritePolicies(familyId, policies, cashValues, setData) {
  setData(setSaving())
  try {
    // R2 参数审计 #3：写超时对齐 dataWrite 60s + 写操作关自动重试（防超时后重复写入）
    var r = await writePoliciesBatch({ familyId: familyId, policies: policies, cashValues: cashValues }, { timeout: 60000, retries: 0, requestId: _lastReqId })
    if (r.ok) {
      setData(hide())
      // Bug-B（2026-09-09）：ingestPolicies 对校验失败项仍返回 200 → 透传 written/total 供上层对账，
      // 防"written=0 却显示保存成功"
      var d = r.data || {}
      return { ok: true, written: d.written, total: d.total, dedupSkipped: d.dedupSkipped || 0 }
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
// UI 审计 R-M11：errorToUI 的恢复引导文案（content）不再丢弃，拼接进失败槽位
function errorLabel(code) {
  var ui = errorToUI(code)
  return ui.content && ui.content !== '请重试' ? ui.title + '：' + ui.content : ui.title
}

// ============================================================
// classifyBatchResults — 识别结果分流分组（收编 _procRefresh，纯函数可单测）
// 输入：policies（AI 提取结果）、cashValues（现价表）、errors（失败项）、thumbMap（fileId→缩略图）
// 输出：{ success, review, error } 三组确认卡
//   - success: 高置信保单 + 现价表（assessPolicy 判定 low=false）
//   - review:  需人工核对保单（low=true，逐字段/整体置信度 <0.9）
//   - error:   识别失败项（error_code → 文案 + 缩略图回退）
// ============================================================
// 低置信字段 → 用户可读标签（待核对卡片提示"保额待确认"，让用户知道要核对什么）
var LOW_FIELD_LABELS = {
  product_name: '产品名', insurance_category: '险种', insurance_type: '险种类型',
  insurance_period: '保障期间', sum_assured: '保额', annual_premium: '保费',
  payment_method: '缴费方式', payment_period: '缴费期限',
  insured_name: '被保人', policyholder_name: '投保人', beneficiary_name: '受益人',
  policy_number: '保单号', insurance_company: '保险公司', insurer: '保险公司',
  effective_date: '生效日', insured_birth_date: '被保人生日',
  policyholder_birth_date: '投保人生日', beneficiary_birth_date: '受益人生日'
}
function _lowFieldText(p) {
  var fc = (p && p.field_confidence) || {}
  var names = []
  Object.keys(fc).forEach(function(k) {
    if (fc[k] < 0.9) {
      var label = LOW_FIELD_LABELS[k]
      if (label && names.indexOf(label) === -1) names.push(label)
    }
  })
  if (!names.length) return ''
  return names.slice(0, 2).join('、') + '待确认' + (names.length > 2 ? '等' : '')
}

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
      lowFields: low ? _lowFieldText(p) : '',
      thumb: ''
    }
    if (low) review.push(card); else success.push(card)
  })
  ;(cashValues || []).forEach(function(cv) {
    success.push({ kind: 'cash', policyIndex: -1, product_name: cv.product_name || '现价表', insurance_category: '现金价值表', effective_date: '', confidence: 0, low: false, thumb: '' })
  })
  var errorCards = (errors || []).map(function(e) {
    var ec = e.error_code || 'ocr_exception'
    // 保留 retrying 标记：重试中经 _procRefresh 重渲染时按钮应保持"重试中"状态
    return { fileId: e.fileId, thumb: e.thumb || (thumbMap && thumbMap[e.fileId]) || '', error: errorLabel(ec) || '识别失败', retrying: !!e.retrying }
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
  retryAiOnly,
  getCachedOcrText,
  clearCachedOcrText,
  saveCashValuesWithRetry,
  confirmWritePolicies,
  errorToUI, errorLabel,
  cleanupTempFiles,
  rememberFailedFiles,
  cleanupExpiredTemp,
  classifyBatchResults
}
