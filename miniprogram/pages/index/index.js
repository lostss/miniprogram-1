const api = require('../../utils/apiClient')
const { navigateToFamily, confirmDeleteFamily } = require('../../utils/family-actions')

/** 保小秘 首页 */
// 最近客户列表本地缓存（60s TTL + 静默刷新）：避免每次 onShow 查库导致骨架屏闪烁
// 冷启动直接渲染缓存；60s 内命中不请求；过期则后台静默更新；OCR 保存/删除等数据变更场景 force 绕过
const HOME_CACHE_KEY = 'homeRecentClients'
const HOME_CACHE_TTL = 60 * 1000

Page({
  data: {
    recentClients: [], loadingClients: false, removingId: '', ocrBusy: false, loadError: false, needLogin: false
  },

  onUnload() { this._disposed = true },
  onShow() {
    this.setData({ needLogin: !!(getApp().globalData.needLogin) })
    this._fetchClients()
    const ocrFlow = this.selectComponent('#ocrFlow')
    if (ocrFlow) ocrFlow.checkResume()
  },
  // 手机号登录（正式环境；open-type=getPhoneNumber → e.detail.code → login({code})）
  onPhoneLogin(e) {
    var code = e.detail && e.detail.code
    if (!code) { wx.showToast({ title: '未获取到授权，请重试', icon: 'none' }); return }
    api('login', { code: code }).then(res => {
      if (res.ok) {
        getApp().completePhoneLogin(res.data || {})
        this.setData({ needLogin: false })
        this._fetchClients(true)
      } else {
        wx.showToast({ title: res.msg || '登录失败', icon: 'none' })
      }
    }).catch(err => {
      console.error('[index] 手机号登录失败:', err)
      wx.showToast({ title: '登录失败，请重试', icon: 'none' })
    })
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
      if (cache.data && cache.data.length) this.setData({ recentClients: cache.data, loadingClients: false, loadError: false })
      return
    }
    // 静默刷新：有旧缓存先渲染，避免骨架屏闪白；无缓存才显示骨架
    if (!force && cache && cache.data && cache.data.length) {
      this.setData({ recentClients: cache.data, loadingClients: false, loadError: false })
    } else {
      this.setData({ loadingClients: true })
    }
    try {
      const res = await api('listFamilies', { limit: 3 })
      if (this._disposed) return
      if (res.ok) {
        const families = res.data.families || []
        this._writeCache(families)
        this.setData({ recentClients: families, loadingClients: false, loadError: false })
      } else {
        // UI 审计 R-M5：加载失败标记错误态（首页不显示 onboarding 引导伪装空数据）
        this.setData({ loadingClients: false, loadError: true })
      }
    } catch (e) { this.setData({ loadingClients: false, loadError: true }); console.error('获取客户列表失败:', e) }
  },
  // UI 审计 R-M5：首页错误态重试（force 绕过 60s TTL 缓存）
  onRetryLoad() { this._fetchClients(true) },

  // UI 审计 交互 S1：OCR 弹窗/进行中拦截返回键，防误按退页丢进度
  onBackPress() {
    const ocr = this.selectComponent('#ocrFlow')
    if (ocr && ocr.onBackPressed && ocr.onBackPressed()) return true
    return false
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

  // 真机 404 修复：detail（组件 triggerEvent）优先，dataset 兜底；_id 为空时拦截提示而非跳 'familyId=undefined'
  onClientTap(e) {
    const detail = e.detail || {}
    const ds = e.currentTarget.dataset || {}
    const id = (detail._id !== undefined && detail._id !== '') ? detail._id : (ds.id || ds._id || '')
    if (!id) { wx.showToast({ title: '客户数据异常，请下拉刷新', icon: 'none' }); return }
    navigateToFamily(id)
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
