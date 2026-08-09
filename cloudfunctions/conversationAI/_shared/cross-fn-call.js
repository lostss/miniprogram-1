/**
 * cross-fn-call — 跨云函数调用的统一 seam
 *
 * 解决问题：原 conversationAI/index.js 顶部 _callWrite / _callQuery / _runReport
 * 三处重复 cloud.callFunction + .catch + 硬编码错误字符串模板，重试/节流逻辑内联在编排文件。
 *
 * 设计：单一 deep seam
 *   callSibling(cloud, fnName, payload, openid, opts)
 *     - opts.label: 错误日志标签（默认 fnName）
 *     - opts.retry: 重试次数（默认 0）
 *     - opts.retryDelayMs: 重试间隔（默认 2000）
 *     - opts.throttleMs: 节流窗口（默认 0，不节流）
 *     - opts.throttleState: 节流状态查询函数 (familyId) => lastMs（与 opts.throttleMs 配合）
 *     - opts.onSuccess: 成功后回调 (result, ctx) => void，ctx = { familyId, openid, now }
 *     - opts.extraPayload: 额外注入到 data 的字段（如 _authOpenid 已默认注入）
 *
 * 返回值：{ code, msg, data?, ...rest } — 已归一化，失败时 code:500
 *
 * 依赖：cloud（wx-server-sdk 实例），从外部注入以便测试替换。
 */
const { withRetry } = require('./retry')
const DEFAULT_LABEL = 'cross-fn-call'

/**
 * 调用同环境云函数，统一错误归一化、可选重试/节流。
 *
 * 架构审计第 14 轮候选 #3：重试循环委托 withRetry，本模块只保留节流/onSuccess/错误归一化。
 *
 * @param {object} cloud - wx-server-sdk 实例（已 init）
 * @param {string} fnName - 目标云函数名
 * @param {object} payload - 调用 data（不含 _authOpenid，本函数自动注入）
 * @param {string} openid - 调用方 openid
 * @param {object} [opts] - 选项
 * @returns {Promise<object>} 归一化结果 { code, msg, data?, ...rest }
 */
async function callSibling(cloud, fnName, payload, openid, opts = {}) {
  const {
    label = fnName,
    retry = 0,
    retryDelayMs = 2000,
    throttleMs = 0,
    throttleState = null,
    onSuccess = null,
    extraPayload = {},
    // R3v2 #2：fire-and-forget 模式——节流检查后不 await 调用，立即返回 triggered（后台异步执行）
    fireAndForget = false,
    // R3v2 审计 #9：traceId 透传（跨函数日志串联，与 ocrService 读 event._reqId 一致）
    traceId = ''
  } = opts

  // 节流检查（需配合 throttleState 回调查询上次成功时间；支持 async 回调，R3v2 #2）
  if (throttleMs > 0 && typeof throttleState === 'function') {
    const familyId = payload.familyId
    const lastAt = await throttleState(familyId)
    const now = Date.now()
    if (lastAt && (now - lastAt < throttleMs)) {
      return { code: 200, data: { skipped: true, reason: 'throttled' } }
    }
  }

  const data = { _authOpenid: openid, ...payload, ...extraPayload }
  if (traceId) data._reqId = traceId

  if (fireAndForget) {
    // 不 await：命中节流已在上方返回 skipped；此处直接后台触发，错误仅记录日志
    withRetry(
      () => cloud.callFunction({ name: fnName, data }),
      { maxAttempts: retry + 1, delayMs: retryDelayMs, label }
    ).then(res => {
      const result = (res && res.result) || { code: 500, msg: fnName + ' 返回空结果' }
      if (typeof onSuccess === 'function') {
        try {
          onSuccess(result, { familyId: payload.familyId, openid, now: Date.now() })
        } catch (e) {
          console.error(`[cross-fn-call] ${label} onSuccess 回调失败:`, e.message)
        }
      }
    }).catch(e => console.error(`[cross-fn-call] ${label} 重试${retry}次均失败:`, e && e.message))
    return { code: 200, data: { triggered: true } }
  }

  try {
    const res = await withRetry(
      () => cloud.callFunction({ name: fnName, data }),
      { maxAttempts: retry + 1, delayMs: retryDelayMs, label }
    )
    const result = (res && res.result) || { code: 500, msg: fnName + ' 返回空结果' }

    // 成功后回调（用于时间戳回写等）
    if (typeof onSuccess === 'function') {
      try {
        onSuccess(result, { familyId: payload.familyId, openid, now: Date.now() })
      } catch (e) {
        console.error(`[cross-fn-call] ${label} onSuccess 回调失败:`, e.message)
      }
    }
    return result
  } catch (e) {
    console.error(`[cross-fn-call] ${label} 重试${retry}次均失败:`, e && e.message)
    return { code: 500, msg: label + ' 调用失败' }
  }
}

module.exports = { callSibling }
