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
// P2-L3 修复（2026-09-05）：AI 回复标点统一全角——实时展示已转（chat-panel _fullWidthPunct），
// 历史回读此前原样透传导致同一回复"实时全角、刷新后半角"；此处对 assistant 消息统一转换
const { _toFullwidth } = require('./md-inline')

const TTL_MS = 3 * 60 * 1000
const CACHE_PREFIX = 'chat_history_'
const PAGE_SIZE = 15

function _readCache(familyId) {
  try {
    const c = wx.getStorageSync(CACHE_PREFIX + familyId)
    if (c && c.fetchedAt && Array.isArray(c.messages) && c.messages.length && (Date.now() - c.fetchedAt) < TTL_MS) {
      return c
    }
    // 2026-09-22 全面审计 P2-3：过期/破损缓存此前只 return null、**不清理**。
    // 每个 familyId 一个 key 长期驻留 storage（上限 10MB），key 只在删家庭或对话往返时
    // 才作废 → 用久了 storage 逼近上限，此后所有 setStorageSync 静默失败（本文件 :42 吞异常），
    // 直接受害者是 ocr-flow 的批次快照（_persistBatch）——OCR 中断恢复能力无声消失。
    // 读到即销毁：过期数据的唯一价值就是腾出空间。
    if (c) { try { wx.removeStorageSync(CACHE_PREFIX + familyId) } catch (e2) { /* 存储异常：忽略 */ } }
  } catch (e) { /* 非小程序环境（jest）/存储异常：静默跳过缓存 */ }
  return null
}

function _writeCache(familyId, ms, oldestCreatedAt) {
  // oldestCreatedAt 随缓存持久化：缓存命中路径据此恢复翻页游标（P1-8 修复），
  // 否则命中缓存的会话"加载更多"误报"没有更多了"
  try { wx.setStorageSync(CACHE_PREFIX + familyId, { messages: ms, fetchedAt: Date.now(), oldestCreatedAt: oldestCreatedAt || null }) } catch (e) { /* 存储满/隐私模式：静默降级为无缓存 */ }
}

/**
 * 让某家庭的本地缓存失效（2026-09-18 审计 P1-F4）。
 *
 * 为什么需要：缓存保存的是**上一次网络拉取的快照**。会话内新发消息后快照即陈旧，
 * 但 `onCollapse` 只 `reset()`（清内存态、不动 storage）→ 3 分钟内重展开会命中旧快照并
 * 整体 `replace`，刚发的 N 条从界面消失；SWR 后台刷新只写 storage 不回填 UI，本会话不自愈。
 * 故 `_postChat` 一次往返结束后（服务端已落库）主动作废缓存，让下次冷读重新拉取。
 * 只在"发生过对话往返"时作废——纯浏览会话仍享受秒开。
 */
function invalidate(familyId) {
  if (!familyId) return
  try { wx.removeStorageSync(CACHE_PREFIX + familyId) } catch (e) { /* 存储异常：静默降级为无缓存 */ }
}

// C2（2026-08-30 审计）：时间格式化抽为公共导出（原 chat-panel 与 history-store 两处重复实现）
// 当天 → 刚刚/X分钟前/HH:mm；跨天 → 昨天/M月D日 + HH:mm
function fmtTime(d) {
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

// 撤销倒计时格式化（mm:ss）
function fmtCountdown(sec) {
  if (sec <= 0) return '已过期'
  const m = Math.floor(sec / 60), s = sec % 60
  return m + ':' + ('0' + s).slice(-2)
}

// raw（desc 新→旧）→ 展示用 ms（time/_scrollId 格式化）；正序由调用侧决定
// 单通道 v10：pending_confirms 随消息恢复，历史消息上的确认卡可继续交互
// 历史显示 bug 兜底：旧版本落库的指令文本 {CONFIRM:xxx}/{KEEP:xxx}/{UNDO:xxx} 转中文
// 新版本后端已落库友好化（confirm-handler.js / undo-handler.js），此处仅处理历史数据
function _friendlyDisplay(content) {
  const c = String(content || '').trim()
  if (/^\{CONFIRM:[\w-]+\}$/.test(c)) return '确认'
  if (/^\{KEEP:[\w-]+\}$/.test(c)) return '取消'
  if (/^\{UNDO:[\w-]+\}$/.test(c)) return '撤销'
  return c
}
function _toMs(raw) {
  return raw.map(m => {
    const isAsst = (m.role || 'assistant') === 'assistant'
    const friendly = _friendlyDisplay(m.content)
    return {
    role: m.role || 'assistant',
    // P2-L3：仅 assistant 消息转全角（对齐实时路径；user 消息保留原文，防保单号/URL 标点被转）
    content: isAsst ? _toFullwidth(friendly) : friendly,
    time: m.created_at ? fmtTime(new Date(m.created_at)) : '',
    suggestions: m.suggestions || [],
    pendingConfirms: m.pending_confirms || [],
    // C3（2026-08-30 审计）：撤销入口随历史恢复——ttl 按消息 created_at 折算剩余秒数，
    // 过期按钮隐藏（后端 expires_at 校验兜底，无越权风险）
    undoOps: (m.undoOps || []).map(op => {
      const total = op.ttlSec || 300
      const elapsed = m.created_at ? Math.floor((Date.now() - new Date(m.created_at).getTime()) / 1000) : 0
      const ttl = Math.max(0, total - elapsed)
      return { opId: op.opId, summary: op.summary || '操作已执行', undoing: false, ttl, ttlText: fmtCountdown(ttl) }
    }),
    _scrollId: m.created_at ? 'msg_' + String(m.created_at).replace(/[^0-9]/g, '') : ''
    }
  })
}

async function _fetch(familyId, params) {
  const r = await api('queryMessages', params)
  return (r && r.ok) ? ((r.data && r.data.messages) || null) : null
}

function createHistoryStore() {
  let historyLoaded = false
  let loadingMore = false
  let oldestMsgTime = null
  // SWR 游标竞态防护：'more' 已把游标推进到更深层后，SWR 后台刷新不得回写游标
  // （否则游标被重置回浅层 → 下一次"加载更多"重复 prepend 已显示消息）
  let cursorAdvanced = false

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
          // P1-8 修复：命中缓存时恢复翻页游标（原仅网络路径设置 → 3min TTL 内打开会话无法"加载更多"）
          if (cached.oldestCreatedAt) oldestMsgTime = cached.oldestCreatedAt
          _fetch(familyId, { familyId, limit: PAGE_SIZE, mode: 'latest' })
            .then(raw => {
              if (raw && raw.length) {
                const ms = _toMs(raw)
                ms.reverse() // desc → 正序（与首次加载一致）
                // 刷新成功后同步前移游标 + 重写缓存（旧缓存无 oldestCreatedAt 字段时借此补齐）；
                // 仅当用户未在此期间下拉翻页时回写（游标已走深则保留深层游标，防重复 prepend）
                if (!cursorAdvanced) oldestMsgTime = raw[raw.length - 1].created_at
                _writeCache(familyId, ms, raw[raw.length - 1].created_at)
              }
            })
            .catch(() => {})
          return { replace: cached.messages, rawCount: cached.messages.length }
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
            // P1-1 修复：desc 数组须 reverse 转正序（旧→新）再插顶，否则头部出现局部倒序段
            ms.reverse()
            cursorAdvanced = true
            return { prepend: ms, rawCount: raw.length }
          }
          historyLoaded = true
          // 首次加载：desc 数组 reverse 转正序（旧→新）——原未 reverse 导致历史倒序展示、
          // 且倒序数组 slice(-15) 让 AI 上下文取到最旧 15 条消息
          ms.reverse()
          _writeCache(familyId, ms, oldestMsgTime)
          return { replace: ms, rawCount: raw.length }
        }
        // 服务端明确返回空数组：这就是"没有历史消息"，属已加载（与上方 null=业务失败 区分）
        if (!mode) historyLoaded = true
      }
    } catch (e) {
      console.error('[history-store] 加载消息失败:', (e && e.message) || e)
      // P1-1：失败返回 error 标记（与"无更多数据返回 0"区分，避免误导"没有更多了"）
      return { error: true }
    } finally {
      if (mode === 'more') loadingMore = false
    }
    // 2026-09-22 修（全面审计 · 前端 P2）：只有**真的拿到数据**（或服务端明确返回空）才算已加载。
    // _fetch 在业务失败（api 解析为 ok:false，如冷启动 401）时返回 null，原实现落到这里就
    // `historyLoaded = true` → 之后所有 load() 在上方 `(!mode && historyLoaded) return 0` 处短路，
    // 而 chat-panel 对"空结果"只渲染首启空态 → 用户看到"小秘可以帮你"，以为对话历史被清空了，
    // 且整个会话内不自愈（只有收起面板 reset() 才能恢复）。业务失败不置位 → 下次重试会重新拉取。
    return 0
  }

  function reset() {
    historyLoaded = false
    loadingMore = false
    oldestMsgTime = null
    cursorAdvanced = false
  }

  return { load, reset, invalidate }
}

module.exports = { createHistoryStore, invalidate, fmtTime, fmtCountdown }
