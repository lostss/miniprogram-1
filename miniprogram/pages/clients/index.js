const api = require('../../utils/apiClient')
const { navigateToFamily, confirmDeleteFamily, CLIENTS_CACHE_KEY, HOME_CACHE_KEY } = require('../../utils/family-actions')

Page({
  data: { families: [], keyword: '', loading: false, removingId: '', loadError: false, truncated: false },
  // ?action=create：首页「新建客户」入口直通建档（只有这里有一份表单实现，不复制第二套）
  onLoad(query) {
    if (query && query.action === 'create') {
      setTimeout(() => { if (!this._disposed) this.onCreateFamily() }, 300)
    }
  },
  onShow() {
    this._fetch()
  },
  onUnload() {
    // 两个独立句柄：_timer = 搜索防抖；_delTimer = 删除动画后的收尾刷新（勿合并，见 onClientLongPress）
    if (this._timer) clearTimeout(this._timer)
    if (this._delTimer) clearTimeout(this._delTimer)
    // 网络审计：卸载后禁止 _fetch 回调 setData（原 .finally 仍会执行 → 已销毁页面 setData 告警）
    this._disposed = true
  },
  // 全量列表持久缓存（SWR 秒开）：本页 navigateTo 每次进入都是新实例、内存必空，
  // 冷启动先渲染缓存出列表不闪骨架屏，随后照常后台刷新（本页低频进入，不做 TTL 短路，
  // 每次进入都刷新——新建/OCR 建档后返回 onShow 即可见，无陈旧窗口）。
  // 搜索态不读不写缓存（结果集与全量列表不同）；删除家庭时 family-actions 统一清键防闪回。
  _readCache() {
    try { const c = wx.getStorageSync(CLIENTS_CACHE_KEY); return (c && Array.isArray(c.data)) ? c : null } catch (e) { return null }
  },
  _writeCache(list, truncated) {
    try { wx.setStorageSync(CLIENTS_CACHE_KEY, { data: list, truncated: truncated || false, ts: Date.now() }) } catch (e) {}
  },
  // UI 审计 F-S1：loading 守卫改为请求 ID 追踪——in-flight 时新搜索不再被静默丢弃
  // （原 if (loading) return 导致输入"ab"时仍显示"a"的结果；旧请求结果由 seq 校验丢弃）
  // 客户列表审计 P1-3：静默刷新——内存已有列表（含删除本地 filter 后）不闪骨架屏，请求完成再更新；无数据才骨架屏
  _fetch() {
    const seq = (this._reqSeq = (this._reqSeq || 0) + 1)
    // SWR 秒开：仅冷启动（内存无数据）且非搜索态时渲染缓存；内存已有列表（含删除后本地 filter）
    // 不回渲染 storage 旧缓存，防已删家庭闪回
    if (!this.data.keyword && !(this.data.families && this.data.families.length)) {
      const c = this._readCache()
      if (c && c.data.length) this.setData({ families: c.data, truncated: !!c.truncated, loadError: false })
    }
    if (this.data.families && this.data.families.length) this.setData({ loading: false })
    else this.setData({ loading: true })
    const action = this.data.keyword ? 'searchFamilies' : 'listFamilies'
    // 审计 P2-16：显式取上限 100（云端上限也是 100），并据 truncated 提示用户
    const params = this.data.keyword ? { keyword: this.data.keyword } : { limit: 100 }
    return api(action, params)
      .then(res => {
        if (this._disposed || seq !== this._reqSeq) return
        if (res.ok) {
          const families = (res.data && res.data.families) || []
          const truncated = !!(res.data && res.data.truncated)
          // 仅全量列表（非搜索态）写缓存
          if (!this.data.keyword) this._writeCache(families, truncated)
          this.setData({ families: families, loadError: false, truncated: truncated })
        }
        // 审计 #P3：业务失败（ok=false 不 reject）原被静默吞掉 → 落"尚无客户档案"假空态
        else if (res.code !== 401) { this.setData({ loadError: true }); wx.showToast({ title: '加载失败，请下拉重试', icon: 'none', duration: 2500 }) }
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

  // 2026-09-12 显式建档入口：此前只能"上传保单"隐式建档（家庭名取投保人姓名），
  // 第一次见面、还没拿到保单时无处建档；且家庭名不可自定义（用不了"李姐-转介绍"这类记忆标签）。
  // 现在支持无保单建档 + 自定义名称（服务端 createFamily 已放开成员校验）。
  onCreateFamily() {
    if (this._creating) return
    const self = this
    wx.showModal({
      title: '新建客户',
      editable: true,
      placeholderText: '如：李姐-转介绍',
      confirmText: '下一步',
      success: function(r) {
        if (!r.confirm) return
        const name = (r.content || '').trim()
        if (!name) { wx.showToast({ title: '请输入客户名称', icon: 'none' }); return }
        // 2026-10-13 流程补齐：建档要收"人数"（第一次见面常只知人数、还拿不到成员明细）。
        // 服务端 createFamily 已接受 members，故按人数建 N 个**占位成员**（无名无角色），
        // 成员明细到家庭页再补 —— 这样 family_structure.member_count 立刻反映人数，
        // 且 readiness 会把它们当"未命名成员"给出 warn 级补全引导（不会 block 报告）。
        wx.showModal({
          title: '家庭成员人数',
          editable: true,
          placeholderText: '如：3（可留空，之后在家庭页补成员）',
          confirmText: '创建',
          success: function(r2) {
            if (!r2.confirm) return
            const raw = (r2.content || '').trim()
            const n = raw === '' ? 0 : Number(raw)
            if (!Number.isInteger(n) || n < 0 || n > 10) {
              wx.showToast({ title: '人数请填 0-10 的整数', icon: 'none' })
              return
            }
            self._doCreateFamily(name, n)
          }
        })
      }
    })
  },

  _doCreateFamily(name, memberCount) {
    const self = this
    const members = []
    for (let i = 0; i < (memberCount || 0); i++) members.push({})
    self._creating = true
    wx.showLoading({ title: '创建中...', mask: true })
    api('createFamily', { family_name: name, family_structure: [], members: members })
      .then(function(res) {
        wx.hideLoading()
        self._creating = false
        if (self._disposed) return
        if (!res || !res.ok) { wx.showToast({ title: (res && res.msg) || '创建失败，请重试', icon: 'none' }); return }
        const id = res.data && res.data._id
        // 2026-09-22 全面审计（前端 P3）：新建客户后必须作废首页的 SWR 缓存。
        // 首页 _fetchClients 的 60s TTL 内直接返回缓存（pages/index/index.js:38-41），
        // 而首页**没有下拉刷新** → 新客户最多 60s 不出现在首页且无法手动强刷。
        // 报告页三处写操作（编辑/删除/改状态）都已 removeStorageSync(HOME_CACHE_KEY)，此处补上。
        try { wx.removeStorageSync(HOME_CACHE_KEY) } catch (e) { /* 存储异常：下次 TTL 到期自然刷新 */ }
        wx.showToast({ title: memberCount > 0 ? '已创建，接下来上传保单' : '已创建，可上传保单或补成员', icon: 'none', duration: 2200 })
        // 直接进入新客户报告页（空态引导上传保单）；返回列表时 onShow 自动刷新
        if (id) setTimeout(function() { if (!self._disposed) navigateToFamily(id) }, 600)
        else self._fetch()
      })
      .catch(function() {
        wx.hideLoading()
        self._creating = false
        if (!self._disposed) wx.showToast({ title: '创建失败，请重试', icon: 'none' })
      })
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
        // 与首页同构：删除后本地先移除（刷新失败/骨架屏不残留已删家庭），后台刷新收尾
        const list = (this.data.families || []).filter(x => x._id !== c._id)
        this.setData({ removingId: c._id, families: list })
        // 2026-09-22 全面审计（前端 P3）：该 setTimeout 原先既未登记（onUnload 清不掉）
        // 也没检查 _disposed —— 确认删除后 250ms 内退出页面，回调仍会 setData 已卸载页面。
        // ⚠️ 2026-09-28 修正：**不能复用 this._timer** —— 那是 onSearch 防抖的句柄，
        // 用户在删除动画的 250ms 内继续输入会把这次回调 clearTimeout 掉（列表已是本地过滤后的，
        // 影响限于 removingId 不复位 + 少了后台复核）。删除动画用独立句柄。
        this._delTimer = setTimeout(() => {
          if (this._disposed) return
          this._fetch()
          this.setData({ removingId: '' })
        }, 250)
      }
    })
  }
})
