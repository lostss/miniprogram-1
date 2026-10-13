/**
 * pages/checkup — 保单整理报告（探索版 · MVP 内测）
 *
 * 只做一件事：读一个家庭 → `buildCheckupReport` → 渲染成能逐条核对的清单。
 * 视图组装全在 `utils/checkup/organize.js`（纯函数、有单测），本页只负责取数与渲染。
 * 取数复用 `getFamily`（owner 读路径，已带 _openid 与 deleted 过滤）——**零云函数改动**。
 */
const api = require('../../utils/apiClient')
const { handle } = require('../../utils/errorHandler')
const { buildCheckupReport } = require('../../utils/checkup/organize')

Page({
  data: {
    loading: true,
    loadingList: false,
    error: '',
    view: null,
    families: [],
    familyId: ''
  },

  onLoad(query) {
    const raw = (query && query.familyId) || ''
    // 真机兜底：跳转传参异常时 familyId 会是字面量 'undefined'/'null'
    const familyId = raw && raw !== 'undefined' && raw !== 'null' ? raw : ''
    if (familyId) this._load(familyId)
    else this._pickFirst()
  },

  // 无 familyId（从客户列表页入口进入）→ 拉列表选第一个，并把其余家庭渲染成可切换的 chip
  _pickFirst() {
    this.setData({ loadingList: true })
    return api('listFamilies', { limit: 20 }).then((r) => {
      if (!r.ok) return this._fail(new Error(r.msg))
      const list = (r.data && r.data.families) || []
      if (!list.length) {
        return this.setData({ loading: false, loadingList: false, error: '还没有客户档案，先到客户列表建档' })
      }
      this.setData({
        loadingList: false,
        families: list.map((f) => ({ id: f._id, name: f.name || f.family_name || '未命名客户' }))
      })
      return this._load(list[0]._id)
    }).catch((e) => this._fail(e))
  },

  _load(familyId) {
    this.setData({ loading: true, error: '' })
    return api('getFamily', { familyId }).then((r) => {
      if (!r.ok) return this._fail(new Error(r.msg))
      const fam = r.data || {}
      const view = buildCheckupReport({
        family: fam,
        members: fam.members || [],
        policies: fam.policies || []
      })
      this.setData({ loading: false, familyId, view })
    }).catch((e) => this._fail(e))
  },

  _fail(e) {
    handle(e, { context: 'checkup.load' })
    this.setData({ loading: false, loadingList: false, error: (e && e.message) || '加载失败，请重试' })
  },

  onSwitchFamily(e) {
    const id = e.currentTarget.dataset.id
    if (id && id !== this.data.familyId) this._load(id)
  },

  onRetry() {
    if (this.data.familyId) this._load(this.data.familyId)
    else this._pickFirst()
  },

  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    const p = this.data.familyId ? this._load(this.data.familyId) : this._pickFirst()
    Promise.resolve(p).then(done, done)
  }
})
