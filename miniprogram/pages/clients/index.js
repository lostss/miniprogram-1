const api = require('../../utils/apiClient')
const { navigateToFamily, confirmDeleteFamily } = require('../../utils/family-actions')

Page({
  data: { families: [], keyword: '', loading: false, removingId: '' },
  onShow() {
    this._fetch()
  },
  onUnload() {
    if (this._timer) clearTimeout(this._timer)
  },
  _fetch() {
    if (this.data.loading) return
    this.setData({ loading: true })
    const action = this.data.keyword ? 'searchFamilies' : 'listFamilies'
    const params = this.data.keyword ? { keyword: this.data.keyword } : {}
    api(action, params)
      .then(res => {
        if (res.ok) this.setData({ families: (res.data && res.data.families) || [] })
      })
      .catch(e => {
        console.error(e)
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none', duration: 2500 })
      })
      .finally(() => this.setData({ loading: false }))
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
  onGoUpload() {
    wx.navigateBack()
  },
  onClientTap(e) {
    const { _id } = e.detail
    navigateToFamily(_id)
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
