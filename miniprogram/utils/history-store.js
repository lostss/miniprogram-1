/**
 * history-store.js — 聊天历史分页加载 + TTL 本地缓存（秒开）
 *
 * 解决问题：chat-panel/index.js 的 _loadHistory 含 3 个实例字段
 * (_historyLoaded / _loadingMore / _oldestMsgTime)，状态分散难测。架构审计 C。
 *
 * 设计：工厂函数 + 闭包状态，对外显式 load/reset 接口
 *   - load(familyId, mode) → Promise<{replace|prepend, rawCount} | 0>
 *     - mode='latest'|undefined → 首次加载：返回 { replace: ms[], rawCount }
 *     - mode='more' → 下拉加载更多：返回 { prepend: ms[], rawCount }
 *     - 无数据返回 0
 *   - reset() → familyId 切换时清空状态
 * 调用方负责 setData（保持 UI 控制权在组件侧）
 *
 * TTL 缓存（stale-while-revalidate）：
 *   - 首次加载命中有效缓存 → 立即返回（本地秒开），后台静默重新拉取刷新缓存，不阻塞 UI
 *   - 缓存过期/未命中 → 走网络，成功后写缓存
 *   - TTL 3 分钟：单端高频使用场景（代理人个人设备），不要求跨端实时同步；SWR 后台刷新兜底新消息
 */
const api = require('./apiClient')

const TTL_MS = 3 * 60 * 1000
const CACHE_PREFIX = 'chat_history_'
const PAGE_SIZE = 15

function _readCache(familyId) {
  try {
    const c = wx.getStorageSync(CACHE_PREFIX + familyId)
    if (c && c.fetchedAt && Array.isArray(c.messages) && c.messages.length && (Date.now() - c.fetchedAt) < TTL_MS) {
      return c.messages
    }
  } catch (e) { /* 非小程序环境（jest）/存储异常：静默跳过缓存 */ }
  return null
}

function _writeCache(familyId, ms) {
  try { wx.setStorageSync(CACHE_PREFIX + familyId, { messages: ms, fetchedAt: Date.now() }) } catch (e) { /* 存储满/隐私模式：静默降级为无缓存 */ }
}

// 与 chat-panel _fmtTime 同逻辑：当天 → 刚刚/X分钟前/HH:mm；跨天 → 昨天/M月D日 + HH:mm
function _fmtTime(d) {
  const n = new Date(), mins = Math.floor((n - d) / 60000)
  const pad = v => ('0' + v).slice(-2)
  const hhmm = pad(d.getHours()) + ':' + pad(d.getMinutes())
  if (mins < 1) return '刚刚'
  if (n.toDateString() === d.toDateString()) {
    if (mins < 60) return mins + '分钟前'
    return hhmm
  }
  const y = new Date(n); y.setDate(y.getDate() - 1)
  if (y.toDateString() === d.toDateString()) return '昨天 ' + hhmm
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hhmm
}

// raw（desc 新→旧）→ 展示用 ms（time/_scrollId 格式化）；正序由调用侧决定
function _toMs(raw) {
  return raw.map(m => ({
    role: m.role || 'assistant',
    content: m.content || '',
    time: m.created_at ? _fmtTime(new Date(m.created_at)) : '',
    suggestions: m.suggestions || [],
    _scrollId: m.created_at ? 'msg_' + String(m.created_at).replace(/[^0-9]/g, '') : ''
  }))
}

async function _fetch(familyId, params) {
  const r = await api('queryMessages', params)
  return (r && r.ok) ? ((r.data && r.data.messages) || null) : null
}

function createHistoryStore() {
  let historyLoaded = false
  let loadingMore = false
  let oldestMsgTime = null

  async function load(familyId, mode) {
    if ((mode === 'more' && loadingMore) || (!mode && historyLoaded) || !familyId) return 0
    try {
      if (mode === 'more') loadingMore = true
      const params = { familyId, limit: PAGE_SIZE }
      if (mode === 'more') {
        if (!oldestMsgTime) return 0
        params.before = oldestMsgTime
      } else {
        params.mode = 'latest'
        // 秒开：TTL 缓存命中 → 立即返回；后台静默刷新缓存（SWR），刷新失败不影响本次展示
        const cached = _readCache(familyId)
        if (cached) {
          historyLoaded = true
          _fetch(familyId, { familyId, limit: PAGE_SIZE, mode: 'latest' })
            .then(raw => {
              if (raw && raw.length) {
                const ms = _toMs(raw)
                ms.reverse() // desc → 正序（与首次加载一致）
                _writeCache(familyId, ms)
              }
            })
            .catch(() => {})
          return { replace: cached, rawCount: cached.length }
        }
      }
      const raw = await _fetch(familyId, params)
      if (raw) {
        const ms = _toMs(raw)
        if (ms.length > 0) {
          // 消息链路审计 P0：queryMessages 按 created_at desc 返回（raw[0]=最新），
          // 游标必须取数组末尾=时间最旧（原取 raw[0]=最新 → 加载更多重复已显示 19 条+1 条新）
          oldestMsgTime = raw[raw.length - 1].created_at
          if (mode === 'more') {
            // prepend：desc 数组（新→旧）直接插顶（顶部较新）正确，不 reverse
            return { prepend: ms, rawCount: raw.length }
          }
          historyLoaded = true
          // 首次加载：desc 数组 reverse 转正序（旧→新）——原未 reverse 导致历史倒序展示、
          // 且倒序数组 slice(-15) 让 AI 上下文取到最旧 15 条消息
          ms.reverse()
          _writeCache(familyId, ms)
          return { replace: ms, rawCount: raw.length }
        }
      }
    } catch (e) {
      console.error('[history-store] 加载消息失败:', (e && e.message) || e)
      // P1-1：失败返回 error 标记（与"无更多数据返回 0"区分，避免误导"没有更多了"）
      return { error: true }
    } finally {
      if (mode === 'more') loadingMore = false
    }
    if (!mode) historyLoaded = true
    return 0
  }

  function reset() {
    historyLoaded = false
    loadingMore = false
    oldestMsgTime = null
  }

  return { load, reset }
}

module.exports = { createHistoryStore }
