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
    families: [], keyword: '', loading: false, removingId: '', loadError: false, truncated: false, ocrBusy: false,
    // 新建客户弹窗（2026-10-17：名称 + 人数一次性录入，替代原两步 wx.showModal）
    createModal: { visible: false, name: '', count: 0, error: '', submitting: false }
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
  //
  // 2026-10-17 改造（用户实报 + 决策）：
  //   ① 名称与人数**一次性录入**（原为两步 wx.showModal：先名称、再人数 —— 中间还要等一个弹窗，
  //      而两件事在"第一次见面"场景里总是同时知道的）；
  //   ② 修 UX bug：wx.showModal 的确认**先关闭弹窗再回调**，名称留空时只弹了个 toast，
  //      输入框连同已打的字一起消失，用户得重开重打（真机实测）。
  //      自定义弹窗把校验结果留在原地 —— 名称为空只标红并保持输入，人数由步进器限死范围，
  //      不再需要"人数请填 0-10 的整数"这类靠 toast 纠错的路径。
  //   ③ 遮罩点击**不关闭**（表单类弹窗的通用做法：防误触丢失已填名称），退出只走「取消」。
  onCreateFamily() {
    if (this._creating) return
    this.setData({ createModal: { visible: true, name: '', count: 0, error: '', submitting: false } })
  },
  // 阻止事件冒泡到遮罩（catchtap 需要一个已定义的方法名）
  onNoop() {},
  // 点遮罩不关：表单未提交前任何"意外关闭"都等于丢输入
  onCreateMaskTap() {},
  onCreateNameInput(e) {
    // 一输入就清错误：留住红色提示会让用户以为继续输入也没用
    this.setData({ 'createModal.name': (e.detail || {}).value || '', 'createModal.error': '' })
  },
  onCountMinus() {
    const c = this.data.createModal.count
    if (c > 0) this.setData({ 'createModal.count': c - 1 })
  },
  onCountPlus() {
    const c = this.data.createModal.count
    // 上限 10 与服务端/readiness 的合理家庭规模一致；超过 10 个占位成员没有业务意义
    if (c < 10) this.setData({ 'createModal.count': c + 1 })
  },
  onCreateCancel() {
    if (this.data.createModal.submitting) return
    this.setData({ 'createModal.visible': false })
  },
  onCreateSubmit() {
    if (this._creating || this.data.createModal.submitting) return
    const name = String(this.data.createModal.name || '').trim()
    if (!name) {
      // 就地报错：弹窗不关、输入保留（这是本次改造要修的那个 bug）
      this.setData({ 'createModal.error': '请填写客户名称' })
      return Promise.resolve()
    }
    return this._doCreateFamily(name, this.data.createModal.count)
  },

  _doCreateFamily(name, memberCount) {
    const self = this
    const members = []
    // 占位成员必须按契约命名「成员1/成员2…」：OCR 写保单时后端以此识别并**按顺序认领**
    // （member-matcher「未匹配上的人一律建档」前置的骨架认领）——空名会让认领失效、变成新建成员。
    for (let i = 0; i < (memberCount || 0); i++) members.push({ name: skeletonName(i) })
    self._creating = true
    // 2026-10-17：创建中用按钮自身的"创建中..."承担 loading（取代 wx.showLoading）——
    // 弹窗已自带遮罩+禁用态，再叠一个系统 loading 是两层等待提示，且 hide 时机会与弹窗状态打架。
    self.setData({ 'createModal.submitting': true, 'createModal.error': '' })
    // 返回 promise 供测试 await（不改变运行行为：调用方本就不依赖返回值）
    return api('createFamily', { family_name: name, family_structure: [], members: members })
      .then(function(res) {
        self._creating = false
        if (self._disposed) return
        if (!res || !res.ok) {
          // 失败**留在弹窗里**报错（名称不丢），不再关窗 toast
          self.setData({ 'createModal.submitting': false, 'createModal.error': (res && res.msg) || '创建失败，请重试' })
          return
        }
        const id = res.data && res.data._id
        self.setData({ 'createModal.visible': false, 'createModal.submitting': false })
        // 2026-09-22 全面审计（前端 P3）：新建客户后必须作废 SWR 缓存，否则 60s TTL 内
        // 新客户不出现（缓存键与列表读写同一常量，此处清的就是本页那个键）。
        try { wx.removeStorageSync(HOME_CACHE_KEY) } catch (e) { /* 存储异常：下次 TTL 到期自然刷新 */ }
        wx.showToast({ title: memberCount > 0 ? '已创建，接下来上传保单' : '已创建，可上传保单或补成员', icon: 'none', duration: 2200 })
        // 直接进入新客户报告页（空态引导上传保单）；返回列表时 onShow 自动刷新
        if (id) setTimeout(function() { if (!self._disposed) navigateToFamily(id) }, 600)
        else self._fetch(true)
      })
      .catch(function() {
        self._creating = false
        if (!self._disposed) self.setData({ 'createModal.submitting': false, 'createModal.error': '创建失败，请重试' })
      })
  }
})
