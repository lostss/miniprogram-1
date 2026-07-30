/**
 * session-store.js — 当前活跃家庭的全局会话状态
 *
 * 解决问题：原 globalData.lastFamilyId 被读取但从未赋值（静默 bug），
 * 导致 OCR 上传纯现价表时 familyId 永远是空字符串。
 *
 * 单一事实源：内部用 wx.setStorageSync 持久化，跨页面/跨启动可恢复。
 * Interface: setActiveFamily(id) / getActiveFamily() / clear()
 */

const STORAGE_KEY = 'last_family_id'

let _cache = null
let _initialized = false

function _ensureInit() {
  if (_initialized) return
  _initialized = true
  try { _cache = wx.getStorageSync(STORAGE_KEY) || null } catch (e) { _cache = null }
}

/** 设置当前活跃家庭 ID（进入报告页 / 点击客户卡时调用） */
function setActiveFamily(familyId) {
  if (!familyId || typeof familyId !== 'string') return
  _cache = familyId
  try { wx.setStorageSync(STORAGE_KEY, familyId) } catch (e) { /* 静默降级：内存仍可用 */ }
}

/** 读取当前活跃家庭 ID（无活跃家庭时返回空字符串，调用方兜底处理） */
function getActiveFamily() {
  _ensureInit()
  return _cache || ''
}

/** 清除活跃家庭（删除家庭 / 退出登录时调用） */
function clear() {
  _cache = null
  try { wx.removeStorageSync(STORAGE_KEY) } catch (e) { /* 静默 */ }
}

// ======================== 家庭匹配缓存（5分钟TTL） ========================
const MATCH_CACHE_KEY = 'match_cache'
var MATCH_TTL_MS = 5 * 60 * 1000

function cacheMatch(primaryHolder, familyId) {
  if (!primaryHolder || !familyId) return
  try {
    wx.setStorageSync(MATCH_CACHE_KEY, { h: primaryHolder, f: familyId, t: Date.now() })
  } catch (e) { /* 静默 */ }
}

function getMatchCache(primaryHolder) {
  if (!primaryHolder) return null
  try {
    var c = wx.getStorageSync(MATCH_CACHE_KEY)
    if (!c || c.h !== primaryHolder) return null
    if (Date.now() - c.t > MATCH_TTL_MS) { wx.removeStorageSync(MATCH_CACHE_KEY); return null }
    return c.f
  } catch (e) { return null }
}

module.exports = { setActiveFamily, getActiveFamily, clear, cacheMatch, getMatchCache }
