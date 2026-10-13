const api = require('../../utils/apiClient')
const { navigateToFamily, confirmDeleteFamily, HOME_CACHE_KEY } = require('../../utils/family-actions')
const session = require('../../utils/session-store')
// 跨树契约：骨架成员命名（建档占位）——与后端 member-matcher 的认领判定同源
const { skeletonName } = require('../../utils/member-skeleton')

/**
 * 客户列表（2026-10-13 合并页）—— 同时是小程序的**根页面**
 *
 * 合并动因：原 `pages/index`（最近 3 个 + 新建入口 + 未完成批次恢复宿主）与 `pages/clients`
 * （搜索 + 全量 100 + 建档表单）职责高度重叠 —— 同一 `listFamilies`、同一 `client-card`、
 * 同一骨架屏、同一套点击/长按（已抽 utils/family-actions）；且 clients 是**单向二级页**
 * （只能从首页「全部 →」进），"最近 3 个"只是同一份查询的 limit 变体。
 * 合并后：搜索 + 全量列表 + 建档 + 恢复提示都在这一页；**"最近客户"概念取消**。
 * 路径仍为 pages/index → 报告页/app.js 的 7 处 reLaunch 与页面栈语义不变；
 * `pages/clients` 已删除，`?action=create` 跳转链一并消失（此处直接弹建档）。
 *
 * 缓存（SWR）：单键 `HOME_CACHE_KEY`（原 clientsAllList 键已废弃，两键收成一个）。
 * 根页面 onShow 频繁（从报告页返回）→ 保留 60s TTL 短路；数据变更由报告页写操作与
 * family-actions 删除流程显式清键（force 绕过）。
 */
const CACHE_TTL = 60 * 1000

Page({
  data: {
    families: [], keyword: '', loading: false, removingId: '', loadError: false, truncated: false, ocrBusy: false
  },

  onShow() {
    this._fetch()
    // 根页面职责：未完成批次恢复提示（上传入口虽在报告页，恢复弹窗仍挂在根页面）
    const ocrFlow = this.selectComponent('#ocrFlow')
    if (ocrFlow) ocrFlow.checkResume()
  },
  onUnload() {
    // 两个独立句柄：_timer = 搜索防抖；_delTimer = 删除动画后的收尾刷新（勿合并，见 onClientLongPress）
    if (this._timer) clearTimeout(this._timer)
    if (this._delTimer) clearTimeout(this._delTimer)
    this._disposed = true
  },
  onOcrBusy(e) {
    this.setData({ ocrBusy: !!((e && e.detail) && e.detail.busy) })
  },

  _readCache() {
    try { const c = wx.getStorageSync(HOME_CACHE_KEY); return (c && Array.isArray(c.data)) ? c : null } catch (e) { return null }
  },
  _writeCache(list, truncated) {
    try { wx.setStorageSync(HOME_CACHE_KEY, { data: list, truncated: truncated || false, ts: Date.now() }) } catch (e) {}
  },

  /**
   * 拉取列表。force=true 绕过缓存（数据变更/重试/下拉刷新）。
   * SWR：仅"全量态"（非搜索）+ 非 force 时先用缓存秒开；TTL 内直接返回不发请求。
   * 搜索态不读不写缓存（结果集与全量不同）。内存已有列表（含删除后本地 filter）
   * 不回渲染 storage 旧缓存 —— 防已删家庭闪回。
   */
  _fetch(force) {
    const seq = (this._reqSeq = (this._reqSeq || 0) + 1)
    const kw = this.data.keyword
    if (!force && !kw) {
      const c = this._readCache()
      if (c && c.data.length) {
        if (!(this.data.families && this.data.families.length)) {
          this.setData({ families: c.data, truncated: !!c.truncated, loadError: false })
        }
        if ((Date.now() - c.ts) < CACHE_TTL) { this.setData({ loading: false }); return Promise.resolve() }
      }
    }
    // 静默刷新：内存已有列表不闪骨架屏（无数据才骨架）
    if (this.data.families && this.data.families.length) this.setData({ loading: false })
    else this.setData({ loading: true })
    const action = kw ? 'searchFamilies' : 'listFamilies'
    // 审计 P2-16：显式取上限 100（云端上限也是 100），据 truncated 明示截断
    const params = kw ? { keyword: kw } : { limit: 100 }
    return api(action, params)
      .then(res => {
        if (this._disposed || seq !== this._reqSeq) return
        if (res.ok) {
          const families = (res.data && res.data.families) || []
          const truncated = !!(res.data && res.data.truncated)
          if (!this.data.keyword) this._writeCache(families, truncated)
          this.setData({ families: families, loadError: false, truncated: truncated })
        }
        // 审计 #P3：业务失败（ok=false 不 reject）原被静默吞掉 → 落"尚无客户档案"假空态。
        // 401 交给 apiClient 统一处理，不在本页显示错误态（避免闪烁）
        else if (res.code !== 401) this.setData({ loadError: true })
      })
      .catch(e => {
        if (this._disposed || seq !== this._reqSeq) return
        console.error('获取客户列表失败:', e)
        this.setData({ loadError: true })
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none', duration: 2500 })
      })
      .finally(() => {
        if (this._disposed || seq !== this._reqSeq) return
        this.setData({ loading: false })
      })
  },
  // 搜索防抖 300ms（seq 校验已在 _fetch，无需 loading 守卫——否则输入"ab"时仍显示"a"的结果）
  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    clearTimeout(this._timer)
    this._timer = setTimeout(() => this._fetch(), 300)
  },
  onClearSearch() {
    this.setData({ keyword: '' })
    this._fetch()
  },
  // 错误态重试：force 绕过 60s TTL 缓存
  onRetryLoad() { this._fetch(true) },
  onPullDownRefresh() {
    const p = this._fetch(true)
    if (p && p.finally) p.finally(() => { if (!this._disposed) wx.stopPullDownRefresh() })
    else wx.stopPullDownRefresh()
  },

  // ============ OCR（恢复提示 + 保存后跳转）============
  // 保存成功：设置活跃家庭 → 进入报告页
  onOcrSaved(e) {
    const d = (e && e.detail) || {}
    if (!d.familyId) { this._fetch(true); return } // 防御：无 familyId 不跳空 ID 报告页
    this._fetch(true) // 数据已变更，绕过缓存强制刷新
    navigateToFamily(d.familyId)
  },
  onOcrDiscarded() { this._fetch(true) },
  // 手动"返回首页"（保存成功弹窗）：只刷新列表，不跳报告页
  onOcrSavedHome(e) {
    const d = (e && e.detail) || {}
    if (d.familyId) session.setActiveFamily(d.familyId)
    this._fetch(true)
  },

  // ============ 列表交互 ============
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
    const c = (this.data.families || [])[idx]
    if (!c) return
    confirmDeleteFamily({
      familyId: c._id,
      name: c.name || c.family_name || '',
      onSuccess: () => {
        // 先播 fadeOut 再移除：同帧 filter 会让 card-removing 匹配项直接消失，动画永不触发
        this.setData({ removingId: c._id })
        this._delTimer = setTimeout(() => {
          // 2026-09-22 全面审计（前端 P3）：原回调未查 _disposed，也未登记句柄 ——
          // 确认删除后 250ms 内离开页面 → 对已卸载页面 setData（告警 + 无谓的强制刷新）
          if (this._disposed) return
          // ⚠️ 不能复用 this._timer：那是 onSearch 防抖的句柄，用户在删除动画的 250ms 内继续输入
          // 会把这次回调 clearTimeout 掉。删除动画用独立句柄 _delTimer。
          // 动画播完本地移除（避免刷新失败时已删家庭残留或闪回），后台 force 刷新收尾
          this.setData({ removingId: '', families: (this.data.families || []).filter(x => x._id !== c._id) })
          this._fetch(true)
        }, 250)
      }
    })
  },

  // ============ 建档 ============
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
    // 占位成员必须按契约命名「成员1/成员2…」：OCR 写保单时后端以此识别并**按顺序认领**
    // （member-matcher「未匹配上的人一律建档」前置的骨架认领）——空名会让认领失效、变成新建成员。
    for (let i = 0; i < (memberCount || 0); i++) members.push({ name: skeletonName(i) })
    self._creating = true
    wx.showLoading({ title: '创建中...', mask: true })
    api('createFamily', { family_name: name, family_structure: [], members: members })
      .then(function(res) {
        wx.hideLoading()
        self._creating = false
        if (self._disposed) return
        if (!res || !res.ok) { wx.showToast({ title: (res && res.msg) || '创建失败，请重试', icon: 'none' }); return }
        const id = res.data && res.data._id
        // 2026-09-22 全面审计（前端 P3）：新建客户后必须作废 SWR 缓存，否则 60s TTL 内
        // 新客户不出现（缓存键与列表读写同一常量，此处清的就是本页那个键）。
        try { wx.removeStorageSync(HOME_CACHE_KEY) } catch (e) { /* 存储异常：下次 TTL 到期自然刷新 */ }
        wx.showToast({ title: memberCount > 0 ? '已创建，接下来上传保单' : '已创建，可上传保单或补成员', icon: 'none', duration: 2200 })
        // 直接进入新客户报告页（空态引导上传保单）；返回列表时 onShow 自动刷新
        if (id) setTimeout(function() { if (!self._disposed) navigateToFamily(id) }, 600)
        else self._fetch(true)
      })
      .catch(function() {
        wx.hideLoading()
        self._creating = false
        if (!self._disposed) wx.showToast({ title: '创建失败，请重试', icon: 'none' })
      })
  }
})
