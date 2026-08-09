/**
 * history-store.test.js — 聊天历史分页加载
 * 覆盖消息链路审计 P0 修复：desc 游标取末尾（防重复加载）+ 首次加载 reverse 转正序（防倒序展示/AI 取最旧）
 */
jest.mock('../miniprogram/utils/apiClient', () => jest.fn())

const api = require('../miniprogram/utils/apiClient')
const { createHistoryStore } = require('../miniprogram/utils/history-store')

const descMsgs = [
  { role: 'assistant', content: '第20条(最新)', created_at: '2026-08-08T10:20:00.000Z' },
  { role: 'user', content: '第19条', created_at: '2026-08-08T10:19:00.000Z' },
  { role: 'assistant', content: '第18条', created_at: '2026-08-08T10:18:00.000Z' }
]

// 缓存命中用：模拟小程序 wx storage（jest 无 wx 全局，注入假实现验证 SWR 秒开路径）
function _mockWx(store) {
  const map = new Map()
  global.wx = {
    getStorageSync: (k) => map.get(k) || '',
    setStorageSync: (k, v) => map.set(k, v)
  }
  return map
}

describe('history-store 分页加载', () => {
  beforeEach(() => { api.mockReset(); delete global.wx })

  test('首次加载：desc 数组 reverse 为正序（旧→新），游标取数组末尾（时间最旧）', async () => {
    api.mockResolvedValue({ ok: true, data: { messages: descMsgs } })
    const store = createHistoryStore()
    const r = await store.load('fam_001')

    expect(r.replace.map(m => m.content)).toEqual(['第18条', '第19条', '第20条(最新)'])
    // 游标 = 数组末尾（最早消息时间），而非原 bug 的 raw[0]（最新）
    expect(store._oldest).toBeUndefined() // 闭包不暴露，用二次 more 验证
  })

  test('more 加载：before=最早消息时间，返回 prepend 不 reverse（新→旧插顶）', async () => {
    api.mockResolvedValue({ ok: true, data: { messages: descMsgs } })
    const store = createHistoryStore()
    await store.load('fam_001')

    api.mockClear()
    api.mockResolvedValue({ ok: true, data: { messages: descMsgs } })
    const r2 = await store.load('fam_001', 'more')
    expect(r2.prepend.map(m => m.content)).toEqual(['第20条(最新)', '第19条', '第18条'])
    // 关键断言：before 必须是 firstLoad 末尾（最早时间），不是最新时间
    expect(api).toHaveBeenCalledWith('queryMessages', { familyId: 'fam_001', limit: 15, before: '2026-08-08T10:18:00.000Z' })
  })

  test('reset 清空状态后可重新首次加载', async () => {
    api.mockResolvedValue({ ok: true, data: { messages: descMsgs } })
    const store = createHistoryStore()
    await store.load('fam_001')
    store.reset()
    api.mockClear()
    api.mockResolvedValue({ ok: true, data: { messages: descMsgs } })
    const r = await store.load('fam_002')
    expect(r.replace).toBeDefined()
    expect(api).toHaveBeenCalledWith('queryMessages', { familyId: 'fam_002', limit: 15, mode: 'latest' })
  })

  test('TTL 缓存命中：秒开返回缓存，后台静默刷新缓存（SWR）', async () => {
    _mockWx()
    api.mockResolvedValue({ ok: true, data: { messages: descMsgs } })
    // 预置有效缓存（正序 2 条）
    const store1 = createHistoryStore()
    await store1.load('fam_001') // 首次网络加载写缓存
    // 第二次打开：命中缓存 → 不阻塞，直接返回缓存
    api.mockClear()
    const store2 = createHistoryStore()
    const r = await store2.load('fam_001')
    expect(r.replace.map(m => m.content)).toEqual(['第18条', '第19条', '第20条(最新)'])
    // SWR 后台刷新：load 返回后缓存会被新数据覆盖（网络响应一致则内容不变，验证缓存写入）
    await new Promise(res => setTimeout(res, 20))
    const cached = wx.getStorageSync('chat_history_fam_001')
    expect(cached).toBeTruthy()
    expect(cached.messages.length).toBe(3)
    expect(cached.fetchedAt).toBeTruthy()
  })

  test('缓存过期：不走缓存，重新网络拉取', async () => {
    const map = _mockWx()
    // 预置过期缓存（fetchedAt 早于 TTL 3 分钟）
    map.set('chat_history_fam_001', {
      messages: [{ role: 'assistant', content: '旧缓存', time: '', _scrollId: '' }],
      fetchedAt: Date.now() - 4 * 60 * 1000
    })
    api.mockResolvedValue({ ok: true, data: { messages: descMsgs } })
    const store = createHistoryStore()
    const r = await store.load('fam_001')
    expect(r.replace.map(m => m.content)).toEqual(['第18条', '第19条', '第20条(最新)'])
    expect(api).toHaveBeenCalledWith('queryMessages', { familyId: 'fam_001', limit: 15, mode: 'latest' })
  })
})
