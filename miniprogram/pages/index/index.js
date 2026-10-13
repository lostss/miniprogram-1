const api = require('../../utils/apiClient')
const { navigateToFamily, confirmDeleteFamily, HOME_CACHE_KEY } = require('../../utils/family-actions')
const session = require('../../utils/session-store')

/** 保小秘 首页 */
// 最近客户列表本地缓存（SWR：60s TTL + 过期秒开后台静默刷新）
// 有缓存（含过期）先渲染秒开——冷启动不闪骨架屏；60s 内命中不请求，过期后台静默更新；
// OCR 保存/删除等数据变更场景 force 绕过缓存（删除场景本地已 filter，不回渲染旧缓存防已删家庭闪回）
const HOME_CACHE_TTL = 60 * 1000

Page({
  data: {
    recentClients: [], loadingClients: false, removingId: '', ocrBusy: false, loadError: false
  },

  onUnload() { this._disposed = true; if (this._timer) clearTimeout(this._timer) },
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
    // SWR 秒开：非 force 且有缓存（含过期）先渲染——冷启动立即出列表不闪骨架屏；
    // TTL 内命中则直接返回不发请求，过期则继续走下方后台静默刷新。
    // 空缓存不秒开（保持走网络，防无家庭用户的空缓存永不刷新）
    if (!force && cache && cache.data && cache.data.length) {
      this.setData({ recentClients: cache.data, loadingClients: false, loadError: false })
      if ((Date.now() - cache.ts) < HOME_CACHE_TTL) return
    }
    // force 场景（数据变更/重试）不渲染缓存，直接刷新；
    // 静默刷新：内存已有列表则不闪骨架屏，请求完成再更新；
    // 无内存数据才显示骨架。用内存而非 storage 缓存判断：删除场景已本地 filter，
    // 若渲染 storage 旧缓存会把已删家庭闪回
    if (this.data.recentClients && this.data.recentClients.length) {
      this.setData({ loadingClients: false, loadError: false })
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
    } catch (e) { if (this._disposed) return; this.setData({ loadingClients: false, loadError: true }); console.error('获取客户列表失败:', e) }
  },
  // UI 审计 R-M5：首页错误态重试（force 绕过 60s TTL 缓存）
  onRetryLoad() { this._fetchClients(true) },


  // 保存成功：设置活跃家庭 → 进入报告页
  onOcrSaved(e) {
    const d = (e && e.detail) || {}
    if (!d.familyId) { this._fetchClients(true); return } // 防御：无 familyId 不跳空 ID 报告页
    this._fetchClients(true) // 数据已变更，绕过缓存强制刷新
    navigateToFamily(d.familyId)
  },

  onOcrDiscarded() { this._fetchClients(true) },

  // 手动"返回首页"（保存成功弹窗）：只刷新列表，不跳报告页
  onOcrSavedHome(e) {
    const d = (e && e.detail) || {}
    if (d.familyId) session.setActiveFamily(d.familyId)
    this._fetchClients(true)
  },

  // 真机 404 修复：detail（组件 triggerEvent）优先，dataset 兜底；_id 为空时拦截提示而非跳 'familyId=undefined'
  onClientTap(e) {
    const detail = e.detail || {}
    const ds = e.currentTarget.dataset || {}
    const id = (detail._id !== undefined && detail._id !== '') ? detail._id : (ds.id || ds._id || '')
    if (!id) { wx.showToast({ title: '客户数据异常，请稍后重试', icon: 'none' }); return } // UX 审计：首页未开启下拉刷新，原文案指引无效
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
        // 先播 fadeOut 再移除：同帧 filter 会让 card-removing 匹配项直接消失，动画永不触发
        this.setData({ removingId: c._id })
        this._timer = setTimeout(() => {
          // 2026-09-22 全面审计（前端 P3）：原回调未查 _disposed，也未登记进 this._timer ——
          // 确认删除后 250ms 内离开首页 → 对已卸载页面 setData（告警 + 无谓的强制刷新）
          if (this._disposed) return
          // 动画播完本地移除（避免刷新失败时已删家庭残留或闪回），后台 force 刷新收尾
          this.setData({ removingId: '', recentClients: (this.data.recentClients || []).filter(x => x._id !== c._id) })
          this._fetchClients(true)
        }, 250)
      }
    })
  },
  onViewAll() { wx.navigateTo({ url: '/pages/clients/index' }) },
  // 2026-10-13 流程调整：首页入口＝"新建客户"（上传保单移入客户页，从而免去上游的家庭匹配）。
  // 建档表单只在客户列表页有一份实现 → 这里跳过去并带 action=create 触发它，不复制第二套。
  onCreateClient() { wx.navigateTo({ url: '/pages/clients/index?action=create' }) }
})
