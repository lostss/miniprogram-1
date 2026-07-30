/**
 * retry.js — 重试策略统一接缝
 *
 * 架构审计第 14 轮候选 #3：消除散落在 cross-fn-call / tool-orchestration / ocr-extractor
 * 的三套重试 Implementation。这些重试 for 循环骨架一致，只是 backoff/delay/maxAttempts
 * 各自硬编码，无统一 Seam。
 *
 * 接口契约：
 *   withRetry(fn, opts) → Promise<any>
 *     - fn: 异步函数，接收 attempt 索引（从 0 开始），返回值或抛错
 *     - opts.maxAttempts: 总调用次数（含首次，默认 1 = 不重试）
 *     - opts.backoff: 'fixed' | 'exponential'（默认 'fixed'）
 *     - opts.delayMs: 单次延迟基数（默认 600ms；exponential 时实际等待 = delayMs * attempt）
 *     - opts.retryOn: (err, attempt) => bool（默认所有错误都重试）
 *     - opts.label: 日志标签（默认 'withRetry'）
 *
 * 行为：
 *   - 首次调用不等待
 *   - 失败后按 backoff 策略等待，再重试
 *   - retryOn 返回 false 或重试耗尽 → 抛出最后一次错误
 *
 * 不处理"业务级重试"（如 JSON 解析失败后用不同 prompt 重新调用）——那是调用方职责。
 */
async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 1,
    backoff = 'fixed',
    delayMs = 600,
    retryOn = () => true,
    label = 'withRetry'
  } = opts

  let lastErr = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      lastErr = e
      const isLast = attempt >= maxAttempts - 1
      if (isLast || !retryOn(e, attempt)) break

      const wait = backoff === 'exponential' ? delayMs * (attempt + 1) : delayMs
      console.warn(`[${label}] 第${attempt + 1}次失败，${wait}ms后重试:`, e.message)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw lastErr
}

module.exports = { withRetry }
