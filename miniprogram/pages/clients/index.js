const api = require('../../utils/apiClient')
const { navigateToFamily, confirmDeleteFamily } = require('../../utils/family-actions')

Page({
  data: { families: [], keyword: '', loading: false, removingId: '', loadError: false },
  onShow() {
    this._fetch()
  },
  onUnload() {
    if (this._timer) clearTimeout(this._timer)
    // 网络审计：卸载后禁止 _fetch 回调 setData（原 .finally 仍会执行 → 已销毁页面 setData 告警）
    this._disposed = true
  },
  // UI 审计 F-S1：loading 守卫改为请求 ID 追踪——in-flight 时新搜索不再被静默丢弃
  // （原 if (loading) return 导致输入"ab"时仍显示"a"的结果；旧请求结果由 seq 校验丢弃）
  _fetch() {
    const seq = (this._reqSeq = (this._reqSeq || 0) + 1)
    this.setData({ loading: true })
    const action = this.data.keyword ? 'searchFamilies' : 'listFamilies'
    const params = this.data.keyword ? { keyword: this.data.keyword } : {}
    return api(action, params)
      .then(res => {
        if (this._disposed || seq !== this._reqSeq) return
        if (res.ok) this.setData({ families: (res.data && res.data.families) || [], loadError: false })
      })
      .catch(e => {
        if (this._disposed || seq !== this._reqSeq) return
        console.error(e)
        // UI 审计 R-M5：加载失败标记错误态（WXML 区分错误 vs 真空态，不再伪装"尚无客户档案"）
        this.setData({ loadError: true })
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none', duration: 2500 })
      })
      .finally(() => {
        if (this._disposed || seq !== this._reqSeq) return
        this.setData({ loading: false })
      })
  },
  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    clearTimeout(this._timer)
    this._timer = setTimeout(() => this._fetch(), 300)
  },
  onClearSearch() {
    this.setData({ keyword: '' })
    this._fetch()
  },
  // UI 审计 R-M5：错误态重试按钮
  onRetryLoad() { this._fetch() },
  // UI 审计 F-M6：页面开启 enablePullDownRefresh（index.json），下拉重试真实生效
  onPullDownRefresh() {
    const p = this._fetch()
    if (p && p.finally) p.finally(() => { if (!this._disposed) wx.stopPullDownRefresh() })
    else wx.stopPullDownRefresh()
  },
  onGoUpload() {
    wx.navigateBack()
  },
  // 真机 404 修复：与首页同构——detail 优先、dataset 兜底、空 _id 拦截
  onClientTap(e) {
    const detail = e.detail || {}
    const ds = e.currentTarget.dataset || {}
    const id = (detail._id !== undefined && detail._id !== '') ? detail._id : (ds.id || ds._id || '')
    if (!id) { wx.showToast({ title: '客户数据异常，请刷新重试', icon: 'none' }); return }
    navigateToFamily(id)
  },
  onClientLongPress(e) {
    const idx = e.currentTarget.dataset.idx
    const c = (this.data.families || [])[idx]
    if (!c) return
    confirmDeleteFamily({
      familyId: c._id,
      name: c.name || c.family_name || '',
      onSuccess: () => {
        this.setData({ removingId: c._id })
        setTimeout(() => {
          this._fetch()
          this.setData({ removingId: '' })
        }, 250)
      }
    })
  }
})
