/**
 * ctx-cache 单元测试 — CtxCache 类的 TTL / LRU / invalidate 行为
 *
 * 被测对象：cloudfunctions/conversationAI/ctx-cache.js
 * 设计契约（来自源文件注释）：
 *   - get(key) 命中且未过期才返回，过期自动删
 *   - set(key, value) 写入并触 LRU
 *   - invalidate(key) 显式失效
 *   - size 当前条目数
 */
const { CtxCache } = require('../cloudfunctions/conversationAI/ctx-cache')

describe('CtxCache', () => {
  describe('basic get/set', () => {
    test('set 后 get 返回 value', () => {
      const c = new CtxCache({ ttlMs: 1000, maxSize: 10 })
      c.set('k1', { markdown: 'hello' })
      expect(c.get('k1')).toEqual({ markdown: 'hello' })
      expect(c.size).toBe(1)
    })

    test('未 set 的 key 返回 undefined', () => {
      const c = new CtxCache({ ttlMs: 1000, maxSize: 10 })
      expect(c.get('missing')).toBeUndefined()
    })

    test('同一 key 重复 set 更新 value 不增长 size', () => {
      const c = new CtxCache({ ttlMs: 1000, maxSize: 10 })
      c.set('k', 'v1')
      c.set('k', 'v2')
      expect(c.size).toBe(1)
      expect(c.get('k')).toBe('v2')
    })
  })

  describe('TTL 过期', () => {
    test('过期后 get 返回 undefined 且自动删除', async () => {
      const c = new CtxCache({ ttlMs: 30, maxSize: 10 })
      c.set('k', 'v')
      expect(c.get('k')).toBe('v')
      await new Promise(r => setTimeout(r, 40))
      expect(c.get('k')).toBeUndefined()
      expect(c.size).toBe(0)
    })

    test('TTL 边界：未过期命中，过期未命中', async () => {
      // Windows 定时器精度差，TTL/等待都放大避免 flaky
      const c = new CtxCache({ ttlMs: 200, maxSize: 10 })
      c.set('k', 'v')
      await new Promise(r => setTimeout(r, 50))
      expect(c.get('k')).toBe('v') // 50ms < 200ms 命中
      await new Promise(r => setTimeout(r, 250))
      expect(c.get('k')).toBeUndefined() // 300ms > 200ms 过期
    })

    test('默认 ttlMs=5000, maxSize=20', () => {
      const c = new CtxCache()
      c.set('k', 'v')
      expect(c.get('k')).toBe('v')
      expect(c.size).toBe(1)
    })
  })

  describe('LRU 淘汰', () => {
    test('超 maxSize 时淘汰最老条目', () => {
      const c = new CtxCache({ ttlMs: 10000, maxSize: 3 })
      c.set('a', 1)
      c.set('b', 2)
      c.set('c', 3)
      expect(c.size).toBe(3)
      c.set('d', 4) // 触发 LRU，淘汰 a
      expect(c.size).toBe(3)
      expect(c.get('a')).toBeUndefined()
      expect(c.get('b')).toBe(2)
      expect(c.get('c')).toBe(3)
      expect(c.get('d')).toBe(4)
    })

    test('LRU 顺序按插入序，重写不重排', () => {
      const c = new CtxCache({ ttlMs: 10000, maxSize: 3 })
      c.set('a', 1)
      c.set('b', 2)
      c.set('a', 99) // 重写 a，不改变 LRU 顺序（a 仍是最老）
      c.set('c', 3)
      c.set('d', 4) // 触发 LRU，淘汰 a（仍是最老）
      expect(c.get('a')).toBeUndefined()
      expect(c.get('b')).toBe(2)
    })
  })

  describe('invalidate', () => {
    test('显式失效后 get 返回 undefined', () => {
      const c = new CtxCache({ ttlMs: 10000, maxSize: 10 })
      c.set('k', 'v')
      expect(c.size).toBe(1)
      c.invalidate('k')
      expect(c.get('k')).toBeUndefined()
      expect(c.size).toBe(0)
    })

    test('invalidate 不存在的 key 无副作用', () => {
      const c = new CtxCache({ ttlMs: 10000, maxSize: 10 })
      expect(() => c.invalidate('nope')).not.toThrow()
      expect(c.size).toBe(0)
    })

    test('invalidate 后可重新 set', () => {
      const c = new CtxCache({ ttlMs: 10000, maxSize: 10 })
      c.set('k', 'v1')
      c.invalidate('k')
      c.set('k', 'v2')
      expect(c.get('k')).toBe('v2')
      expect(c.size).toBe(1)
    })
  })
})
