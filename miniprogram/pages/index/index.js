const api = require('../../utils/apiClient')
const { navigateToFamily, confirmDeleteFamily } = require('../../utils/family-actions')

/** 保小秘 首页 */
// 最近客户列表本地缓存（60s TTL + 静默刷新）：避免每次 onShow 查库导致骨架屏闪烁
// 冷启动直接渲染缓存；60s 内命中不请求；过期则后台静默更新；OCR 保存/删除等数据变更场景 force 绕过
const HOME_CACHE_KEY = 'homeRecentClients'
const HOME_CACHE_TTL = 60 * 1000

Page({
  data: {
    recentClients: [], loadingClients: false, removingId: '', ocrBusy: false
  },

  onUnload() { this._disposed = true },
  onShow() {
    this._fetchClients()
    const ocrFlow = this.selectComponent('#ocrFlow')
    if (ocrFlow) ocrFlow.checkResume()
  },
  onOcrBusy(e) {
    this.setData({ ocrBusy: !!((e && e.detail) && e.detail.busy) })
  },

  _readCache() {
    try { return wx.getStorageSync(HOME_CACHE_KEY) || null } catch (e) { return null }
  },
  _writeCache(data) {
    try { wx.setStorageSync(HOME_CACHE_KEY, { data: data, ts: Date.now() }) } catch (e) {}
  },

  async _fetchClients(force) {
    const cache = this._readCache()
    // TTL 内命中：直接渲染，不发请求
    if (!force && cache && (Date.now() - cache.ts) < HOME_CACHE_TTL) {
      if (cache.data && cache.data.length) this.setData({ recentClients: cache.data, loadingClients: false })
      return
    }
    // 静默刷新：有旧缓存先渲染，避免骨架屏闪白；无缓存才显示骨架
    if (!force && cache && cache.data && cache.data.length) {
      this.setData({ recentClients: cache.data, loadingClients: false })
    } else {
      this.setData({ loadingClients: true })
    }
    try {
      const res = await api('listFamilies', { limit: 3 })
      if (this._disposed) return
      if (res.ok) {
        const families = res.data.families || []
        this._writeCache(families)
        this.setData({ recentClients: families, loadingClients: false })
      } else {
        this.setData({ loadingClients: false })
      }
    } catch (e) { this.setData({ loadingClients: false }); console.error('获取客户列表失败:', e) }
  },

  // 上传入口：委托 ocr-flow 组件（chooseMedia + 全流程）
  onUploadTap() {
    const ocrFlow = this.selectComponent('#ocrFlow')
    if (ocrFlow) ocrFlow.chooseAndStart()
  },

  // 保存成功：设置活跃家庭 → 进入报告页
  onOcrSaved(e) {
    const d = (e && e.detail) || {}
    if (d.familyId) require('../../utils/session-store').setActiveFamily(d.familyId)
    this._fetchClients(true) // 数据已变更，绕过缓存强制刷新
    const url = '/pages/report/index?familyId=' + (d.familyId || '')
    wx.navigateTo({ url })
  },

  onOcrDiscarded() { this._fetchClients(true) },

  // 手动"返回首页"（保存成功弹窗）：只刷新列表，不跳报告页
  onOcrSavedHome(e) {
    const d = (e && e.detail) || {}
    if (d.familyId) require('../../utils/session-store').setActiveFamily(d.familyId)
    this._fetchClients(true)
  },

  onClientTap(e) {
    const { _id } = (e.detail && e.detail._id !== undefined) ? e.detail : e.currentTarget.dataset
    navigateToFamily(_id)
  },
  onClientLongPress(e) {
    const idx = e.currentTarget.dataset.idx
    const c = (this.data.recentClients || [])[idx]
    if (!c) return
    confirmDeleteFamily({
      familyId: c._id,
      name: c.name || c.family_name || '',
      onSuccess: () => {
        this.setData({ removingId: c._id })
        setTimeout(() => {
          this._fetchClients(true) // 删除后强制刷新
          this.setData({ removingId: '' })
        }, 250)
      }
    })
  },
  onViewAll() { wx.navigateTo({ url: '/pages/clients/index' }) }
})
