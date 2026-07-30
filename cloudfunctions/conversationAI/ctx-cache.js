/**
 * ctx-cache.js — 工具上下文缓存（TTL + LRU）
 *
 * 解决问题：原 _ctxCache 是模块级 Map，5s TTL + 20 条 LRU 全在 conversationAI/index.js
 * 模块状态，无法测缓存命中/失效。架构审计 A3。
 *
 * 设计：类化 + 依赖注入
 *   - 实例可注入测试，状态隔离
 *   - get/set/invalidate 显式接口
 *   - LRU 按 insertion order（Map 自带），超 size 删最老
 *
 * 接口契约：
 *   const cache = new CtxCache({ ttlMs: 5000, maxSize: 20 })
 *   cache.get(key) → value | undefined  // 命中且未过期才返回，过期自动删
 *   cache.set(key, value)               // 写入并触 LRU
 *   cache.invalidate(key)               // 显式失效
 *   cache.size                          // 当前条目数
 */
class CtxCache {
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs || 5000
    this.maxSize = opts.maxSize || 20
    this._store = new Map()
  }

  get(key) {
    const entry = this._store.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.ts >= this.ttlMs) {
      this._store.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key, value) {
    this._store.set(key, { value, ts: Date.now() })
    if (this._store.size > this.maxSize) {
      const [[oldestKey]] = this._store
      this._store.delete(oldestKey)
    }
  }

  invalidate(key) {
    this._store.delete(key)
  }

  get size() {
    return this._store.size
  }
}

module.exports = { CtxCache }
