/**
 * history-store.js — 聊天历史分页加载
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
 */
const api = require('./apiClient')

function _fmtTime(d) {
  const n = new Date(), diff = n - d, mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return mins + '分钟前'
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
}

function createHistoryStore() {
  let historyLoaded = false
  let loadingMore = false
  let oldestMsgTime = null

  async function load(familyId, mode) {
    if ((mode === 'more' && loadingMore) || (!mode && historyLoaded) || !familyId) return 0
    try {
      if (mode === 'more') loadingMore = true
      const params = { familyId, limit: 20 }
      if (mode === 'more') {
        if (!oldestMsgTime) return 0
        params.before = oldestMsgTime
      } else {
        params.mode = 'latest'
      }
      const r = await api('queryMessages', params)
      if (r.ok) {
        const raw = (r.data && r.data.messages) || []
        const ms = raw.map(m => ({
          role: m.role || 'assistant',
          content: m.content || '',
          time: m.created_at ? _fmtTime(new Date(m.created_at)) : '',
          suggestions: m.suggestions || []
        }))
        if (ms.length > 0) {
          oldestMsgTime = raw[0].created_at
          if (mode === 'more') {
            return { prepend: ms, rawCount: raw.length }
          }
          historyLoaded = true
          return { replace: ms, rawCount: raw.length }
        }
      }
    } catch (e) {
      console.error('[history-store] 加载消息失败:', (e && e.message) || e)
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
