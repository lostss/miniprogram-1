const { buildChapters, buildGaps, makeHints, buildHero } = require('../../utils/report-builder')
const { normalizeFamilyData } = require('../../utils/report/data-normalizer')
const { buildEditConfig, validate: validateEdit, buildUpdateData } = require('../../utils/edit-form')
const api = require('../../utils/apiClient')
const session = require('../../utils/session-store')

/** 报告页 v2.0 — 基础版报告（6 章单页长图 + 保单 Sheet） */
Page({
  data: {
    familyId: '', family: null, chapters: [],
    loading: true, loadingText: '小秘正在认真看保单...',
    showEdit: false, reportUpdated: false, refreshing: false, editSaving: false,
    editTitle: '编辑', editFields: [], _editMode: '',
    gaps: [], hints: [], focusAnchor: '',
    reportMeta: { date: '', no: '' },
    hero: { alerts: [], summary: '', topAdvice: '', conclusion: '' },
    summaryCards: { premium: '', coverage: '', count: 0 },
    showPolicySheet: false, currentPolicy: null, policyRows: [], policyCat: '',
    showMemberManage: false, memberManageList: [],
    fabCollapsed: true, fabText: ''
  },
  onLoad(o) { const cid = o.familyId || o.customerId || ''; if (!cid) { this.setData({ loading: false }); wx.showModal({ title: '缺少客户信息', content: '请从首页选择客户打开报告', showCancel: false, confirmText: '返回首页', success: () => wx.reLaunch({ url: '/pages/index/index' }) }); return }; session.setActiveFamily(cid); this.setData({ familyId: cid }); this._loadReport(cid) },
  onUnload() { this._disposed = true; clearInterval(this._loaderTimer); clearInterval(this._ocrTick) },
  // 返回键拦截：若 edit-sheet / 保单 Sheet / 成员管理 / chat-panel 展开，先关闭它们而非退出页面
  onBackPress() {
    if (this.data.showMemberManage) { this.closeMemberManage(); return true }
    if (this.data.showPolicySheet) { this.onPolicySheetClose(); return true }
    if (this.data.showEdit) { this.setData({ showEdit: false }); return true }
    const panel = this.selectComponent('#chatpanel')
    if (panel && panel.tryCollapse && panel.tryCollapse()) return true
    return false
  },

  // ===== 章节内编辑入口（设计稿：家庭结构/财务 [编辑]） =====
  onChapterEdit(e) {
    const detail = e.detail || {}
    const mode = detail.mode || ''
    const memberId = detail.memberId || ''
    if (mode === 'financials') {
      const cfg = buildEditConfig({ mode: 'financials', family: this.data.family })
      this.setData(Object.assign({ showEdit: true, editTitle: cfg.title }, cfg))
      return
    }
    if (mode === 'family') {
      const list = (this.data.family && this.data.family.members) || []
      this.setData({
        showMemberManage: true,
        memberManageList: list.map(function(m) {
          return {
            name: m.name || '',
            role: m.role || '',
            member_id: m.member_id || '',
            display: (m.role || '') + (m.age ? '(' + m.age + ')' : '')
          }
        })
      })
      return
    }
    if (mode === 'member' && memberId) {
      this._openMemberEdit(memberId)
    }
  },
  _openMemberEdit(memberId) {
    const list = (this.data.family && this.data.family.members) || []
    const m = list.find(x => x.member_id === memberId)
    if (!m) return
    const cfg = buildEditConfig({ mode: 'member', family: this.data.family, member: m })
    this.setData(Object.assign({ showEdit: true, editTitle: cfg.title }, cfg))
  },
  closeMemberManage() {
    if (this.data.editSaving) return
    this.setData({ showMemberManage: false, memberManageList: [] })
  },
  onMemberManageEdit(e) {
    const mid = (e.currentTarget.dataset && e.currentTarget.dataset.mid) || ''
    if (!mid) return
    this._openMemberEdit(mid)
  },
  onMemberManageAdd() {
    const cfg = buildEditConfig({ mode: 'addMember', family: this.data.family })
    this.setData(Object.assign({ showEdit: true, editTitle: cfg.title }, cfg))
  },

  _loadingTexts: ['小秘正在认真看保单...', '小秘正在整理报告...', '小秘正在加载报告...'],

  // 统一刷新聚合：chapters + meta + gaps 一次算好，所有刷新点共用
  // 消除 5 处重复四件套 + 漏字段；新增字段只改这一处
  _applyReportData(c, reportOverride, extra) {
    const rp = reportOverride || (c.report || {})
    const gaps = buildGaps(c)
    const chapters = buildChapters(c, rp, gaps)
    const hints = makeHints(rp, c)
    // Hero 结论先行：规则版覆盖检查（警示列表 + 总结 + 优先建议）
    const heroView = buildHero(c, gaps)
    const hero = Object.assign(heroView, { conclusion: String(rp.conclusion || '') })
    const norm = normalizeFamilyData(c)
    const summaryCards = {
      premium: String(norm.annualPremiumW),
      coverage: String(norm.totalCoverage),
      count: norm.policyCount
    }
    const reportMeta = this._buildReportMeta()
    this.setData(Object.assign({
      family: c,
      chapters,
      hero,
      summaryCards,
      reportMeta,
      gaps,
      hints
    }, extra || {}))
  },

  async _loadReport(cid, retry) {
    retry = retry || 0
    try {
      if (retry === 0) this._startLoading()
      const q = await api('getFamily', { familyId: cid })
      if (this._disposed) return
      const code = q.code
      if (!q.ok) {
        // 未登录 → 等初始化完成后重试；其他错误 → 短暂重试 2 次
        if (code === 401 && retry < 3) { await new Promise(r => setTimeout(r, 1200)); if (this._disposed) return; return this._loadReport(cid, retry + 1) }
        if (code !== 401 && retry < 2) { await new Promise(r => setTimeout(r, 800)); if (this._disposed) return; return this._loadReport(cid, retry + 1) }
        this._stopLoading(); this.setData({ loading: false })
        const msg404 = '该客户档案已被删除或不存在，可能从其他设备操作了删除'
        const msg401 = '登录状态异常，请退出小程序重新进入'
        const msg = code === 404 ? msg404 : (code === 401 ? msg401 : '加载失败（' + code + '），请下拉刷新重试')
        wx.showModal({ title: '客户不存在', content: msg, showCancel: true, cancelText: '留在本页', confirmText: '返回首页', success: (r) => { if (r.confirm) wx.reLaunch({ url: '/pages/index/index' }) } })
        return
      }
      const c = q.data
      const rp = c.report || {}
      this._stopLoading()
      this._applyReportData(c, null, { loading: false })
      // 数据有更新（OCR/对话写入）但 AI 内容未刷新 → 提示用户
      // 基础版报告为纯数据驱动；AI 深度分析将改为手工触发（待设计），此处保留状态供未来使用
      if (c.insight_stale && rp.portrait) {
        this.setData({ reportUpdated: true })
      }
    } catch (e) { console.error(e); this._stopLoading(); if (!this._disposed) this.setData({ loading: false }) }
  },


  _startLoading() { clearInterval(this._loaderTimer); const texts = this._loadingTexts; if (!texts || !texts.length) { this.setData({ loadingText: '小秘正在加载...' }); return }; let i = 0; this._loaderTimer = setInterval(() => { if (this._disposed) { clearInterval(this._loaderTimer); return } i = (i + 1) % 3; this.setData({ loadingText: texts[i] || '小秘正在加载...' }) }, 2500) },
  _stopLoading() { clearInterval(this._loaderTimer); this._loaderTimer = null },

  // 统一报告刷新序列：缓冲（确保 DB 写入可见）→ 重读 → 应用（纯数据，不触发 AI）
  // 基础版报告为数据驱动；AI 深度分析待设计，后续在此处挂手工触发入口
  // waitMs 默认 500ms，调用方可传 0 跳过（数据已就绪时）
  async _refreshReportSequence(cid, opts) {
    opts = opts || {}
    const waitMs = opts.waitMs === undefined ? 500 : opts.waitMs
    if (this._disposed) return false
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs))
    if (this._disposed) return false
    const q = await api('getFamily', { familyId: cid })
    if (this._disposed) return false
    if (q.ok) {
      this._applyReportData(q.data, null, opts.applyOpts || {})
      return true
    }
    return false
  },

  // 分享：标题带结论钩子，路径带 familyId 直达
  onShareAppMessage() {
    const c = this.data.family || {}
    const hero = this.data.hero || {}
    const conc = hero.conclusion ? '｜' + hero.conclusion.slice(0, 18) : '｜专业保障分析'
    const title = ((c.name || '家庭') + '保障检视' + conc).slice(0, 30)
    return { title: title, path: '/pages/report/index?familyId=' + this.data.familyId, imageUrl: '' }
  },
  onShareTimeline() {
    const c = this.data.family || {}
    const hero = this.data.hero || {}
    const conc = hero.conclusion ? '｜' + hero.conclusion.slice(0, 14) : ''
    return { title: ((c.name || '家庭') + '保障检视' + conc).slice(0, 35), query: 'familyId=' + this.data.familyId }
  },
  _buildReportMeta() {
    const d = new Date()
    const pad = function(n) { return String(n).padStart(2, '0') }
    const date = d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate())
    const cid = this.data.familyId || ''
    const tail = cid.length >= 6 ? cid.slice(-6).toUpperCase() : cid.toUpperCase()
    const no = String(d.getFullYear()).slice(-2) + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + tail
    return { date: date, no: no }
  },

  // 页面级下拉刷新委托给 onRefreshReport
  onPullDownRefresh() { this.onRefreshReport() },
  async onRefreshReport() {
    if (this._refreshingReport) return
    this._refreshingReport = true
    const cid = this.data.familyId
    if (!cid) { wx.stopPullDownRefresh(); this._refreshingReport = false; return }
    this.setData({ refreshing: true, reportUpdated: false })
    wx.showLoading({ title: '正在刷新报告...', mask: true })
    try {
      const ok = await this._refreshReportSequence(cid, { applyOpts: { reportUpdated: false } })
      wx.hideLoading()
      wx.stopPullDownRefresh()
      if (ok) {
        wx.showToast({ title: '报告已更新', icon: 'success' })
      } else {
        wx.showToast({ title: '刷新失败', icon: 'none' })
      }
    } catch (e) {
      console.error(e)
      wx.hideLoading()
      wx.stopPullDownRefresh()
      wx.showToast({ title: '更新失败，请重试', icon: 'none' })
    } finally {
      if (!this._disposed) this.setData({ refreshing: false })
      this._refreshingReport = false
    }
  },

  async onSaveEdit(e) {
    const vals = e.detail || {}, mode = this.data._editMode
    if (this.data.editSaving) return

    // 最小校验（前端 JS 层拦截，避免无效请求）
    const v = validateEdit(mode, vals)
    if (!v.ok) return wx.showToast({ title: v.msg, icon: 'none' })

    this.setData({ editSaving: true })
    try {
      if (mode === 'policy') {
        // 保单编辑走 updatePolicy（白名单字段 + 事实同步）
        const r = buildUpdateData('policy', vals, null, this.data._editMemberIdx)
        await api('updatePolicy', { familyId: this.data.familyId, policyId: r.updatePolicy.policyId, data: r.updatePolicy.data })
        this.setData({ showPolicySheet: false, currentPolicy: null })
        // 本地增量更新：merge 到本地 policies → 立即重算 6 章
        const localFamily = this._applyLocalUpdate(r)
        if (localFamily) this._applyReportData(localFamily, null, {})
      } else {
        const updateData = buildUpdateData(mode, vals, this.data.family, this.data._editMemberIdx)
        await api('updateFamily', { familyId: this.data.familyId, updateData })
        // 本地增量更新：立即应用 + 重算渲染（消除 500ms 缓冲 + 网络往返的感知延迟）
        const localFamily = this._applyLocalUpdate(updateData)
        if (localFamily) this._applyReportData(localFamily, null, {})
      }
      wx.showToast({ title: '小秘记下了', icon: 'none' }); this.setData({ showEdit: false, editSaving: false, showMemberManage: false, memberManageList: [] })
      // 后台静默校验：DB 已写入完成（无需缓冲），读回规范化数据（member_id/fact 同步等）
      this._refreshReportSequence(this.data.familyId, { waitMs: 0, applyOpts: {} }).then(() => {
        if (this._disposed) return
        this.setData({ reportUpdated: false })
      }).catch(e => { console.error('[report] 刷新失败:', e.message) })
    } catch (e) {
      console.error(e)
      this.setData({ editSaving: false })
      wx.showToast({ title: '保存失败，请重试', icon: 'none', duration: 2500 })
    }
  },

  // 本地增量更新：把已确认写入的 updateData 应用到本地 family（纯前端重算 6 章，不查库）
  // 仅处理编辑表单产生的变更；后台由 _refreshReportSequence 校验 DB 规范化数据
  _applyLocalUpdate(updateData) {
    if (!updateData) return null
    const f = Object.assign({}, this.data.family || {})
    let changed = false
    if (Array.isArray(updateData.members)) {
      f.members = updateData.members.slice()
      changed = true
    }
    if (updateData.financial_snapshot) {
      f.financial_snapshot = Object.assign({}, f.financial_snapshot || {}, updateData.financial_snapshot)
      // 兼容旧内嵌字段（buildGaps 读取路径）
      if (updateData.financial_snapshot.debt) f.debt = updateData.financial_snapshot.debt
      if (updateData.financial_snapshot.income !== undefined) f.family_income = updateData.financial_snapshot.income
      changed = true
    }
    if (updateData.updatePolicy) {
      const up = updateData.updatePolicy
      const pid = up.policyId
      if (pid && Array.isArray(f.policies)) {
        f.policies = f.policies.map(function(p) {
          return (p.id === pid || p._id === pid) ? Object.assign({}, p, up.data) : p
        })
        changed = true
      }
    }
    return changed ? f : null
  },

  onCloseEdit() { this.setData({ showEdit: false }) },
  // OCR 入口：FAB 保单按钮/首页共用 ocr-flow 组件
  _startFlow(paths) {
    const ocrFlow = this.selectComponent('#ocrFlow')
    if (!ocrFlow) { wx.showToast({ title: 'OCR 模块加载中', icon: 'none' }); return }
    if (paths && paths.length) ocrFlow.startWithPaths(paths)
    else ocrFlow.chooseAndStart()
  },
  // ocr-flow 保存成功 → 刷新当前报告
  onOcrFlowSaved() {
    this.onRefreshReport()
  },
  // 提示卡片点击 → 展开对话面板并预填问题
  onHintTap(e) {
    const q = e.currentTarget.dataset.q
    if (!q) return
    const panel = this.selectComponent('#chatpanel')
    if (panel && panel.askPreset) panel.askPreset(q)
  },
  // 对话触发的报告刷新（AI 调用了 refreshReport/triggerAnalysis 工具）
  onChatReportRefresh() {
    // chat-panel 已防抖并延迟 3s 触发，此处直接刷新，避免双重延时
    this.onRefreshReport()
  },
  _cp() { return this.selectComponent('#chatpanel') },

  // ===== 保单明细 Sheet（附录卡片点击） =====
  onPolicyTap(e) {
    const id = (e.detail && e.detail.policyId) || ''
    const list = (this.data.family && this.data.family.policies) || []
    const p = list.find(x => (x.id === id) || (x._id === id))
    if (!p) return
    const rows = this._policyRows(p)
    const catShort = String(p.insurance_category || '').replace(/险$/, '')
    this.setData({ showPolicySheet: true, currentPolicy: p, policyRows: rows, policyCat: catShort })
  },
  onPolicySheetClose() {
    if (this.data.editSaving) return
    this.setData({ showPolicySheet: false, currentPolicy: null, policyRows: [], policyCat: '' })
  },
  onSheetNoop() {},
  onPolicySheetEdit() {
    const p = this.data.currentPolicy
    if (!p) return
    const cfg = buildEditConfig({ mode: 'policy', family: this.data.family, member: p })
    this.setData(Object.assign({ showEdit: true, editTitle: cfg.title }, cfg))
  },
  // 只读明细行（WXML 无法拼接，预处理）
  _policyRows(p) {
    p = p || {}
    const rows = []
    rows.push({ label: '保单号', value: p.policy_number || '--' })
    rows.push({ label: '保险公司', value: p.insurer || '--' })
    rows.push({ label: '投保人', value: p.policyholder_name || '--' })
    rows.push({ label: '被保险人', value: p.insured_name || '--' })
    const sum = p.sum_assured || 0
    rows.push({ label: '保额', value: sum >= 10000 ? (Math.round(sum / 10000 * 100) / 100) + '万' : sum + '元' })
    const eff = (p.effective_date || p.contract_effective_date || '--').substring(0, 10)
    const period = p.insurance_period || p.coverage_term || ''
    rows.push({ label: '保障期限', value: eff + '起' + (period ? '（' + period + '）' : '') })
    const premium = p.annual_premium || 0
    rows.push({ label: '年缴保费', value: premium >= 10000 ? (Math.round(premium / 10000 * 100) / 100) + '万' : premium + '元' })
    return rows
  },
  onFabTap() { const cp = this._cp(); if (cp) cp.onFabTap() },
  onUploadFab() { this._startFlow() },
  onFabInput(e) { this.setData({ fabText: e.detail.value }); const cp = this._cp(); if (cp) cp.onInput(e) },
  onFabFocus() { const cp = this._cp(); if (cp) cp.onFocus() },
  onFabSend() { const cp = this._cp(); if (cp) { cp.onSend(); this.setData({ fabText: '' }) } },
})
