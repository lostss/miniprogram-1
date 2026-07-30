const { buildChapters, buildGaps, computeReportMeta, makeHints } = require('../../utils/report-builder')
const { buildEditConfig, validate: validateEdit, buildUpdateData } = require('../../utils/edit-form')
const api = require('../../utils/apiClient')
const session = require('../../utils/session-store')
const flow = require('../../utils/ocr-flow')

/** 报告页 v1.3 — 静默刷新 + FAB提示 */
Page({
  data: {
    familyId: '', family: null, chapters: [],
    mainChapters: [], appendixChapters: [], activeTab: 'report',
    loading: true, loadingText: '小秘正在认真看保单...',
    ocrMask: flow.defaultState(),
    showEdit: false, reportUpdated: false, refreshing: false, editSaving: false,
    editTitle: '编辑', editFields: [], _editMode: '',
    summaryBasis: '', gaps: [], dataNotice: '', completeness: [], hints: [], focusAnchor: '',
    reportMeta: { date: '', no: '' },
    fabCollapsed: true, fabText: ''
  },
  onLoad(o) { const cid = o.familyId || o.customerId || ''; this._focus = o.focus || ''; if (!cid) { this.setData({ loading: false }); wx.showModal({ title: '缺少客户信息', content: '请从首页选择客户打开报告', showCancel: false, confirmText: '返回首页', success: () => wx.navigateBack() }); return }; session.setActiveFamily(cid); this.setData({ familyId: cid }); this._loadReport(cid) },
  onUnload() { this._disposed = true; clearInterval(this._loaderTimer); flow.forgetDedupCache() },
  // 返回键拦截：若 edit-sheet 或 chat-panel 展开，先关闭它们而非退出页面
  onBackPress() {
    if (this.data.showEdit) { this.setData({ showEdit: false }); return true }
    const panel = this.selectComponent('chat-panel')
    if (panel && panel.tryCollapse && panel.tryCollapse()) return true
    return false
  },

  _loadingTexts: ['小秘正在认真看保单...', '小秘正在整理报告...', '小秘正在分析建议...'],

  // 统一刷新聚合：chapters + meta + gaps 一次算好，所有刷新点共用
  // 消除 5 处重复四件套 + 漏字段；新增字段只改这一处
  _applyReportData(c, reportOverride, extra) {
    const rp = reportOverride || (c.report || {})
    const gaps = buildGaps(c)
    const chapters = buildChapters(c, rp, gaps)
    const appendixChapters = chapters.filter(function(ch) { return ch.key.indexOf('appendix') === 0 })
    const mainChapters = chapters.filter(function(ch) { return ch.key.indexOf('appendix') !== 0 })
    const hints = makeHints(rp, c)
    const meta = computeReportMeta(c)
    // Hero 抬头：AI 结论（最致命一句）+ 摘要，首屏视觉锚点
    const hero = { conclusion: String(rp.conclusion || ''), summary: String(rp.summary || '') }
    const reportMeta = this._buildReportMeta()
    this.setData(Object.assign({
      family: c,
      chapters, mainChapters, appendixChapters,
      hero,
      reportMeta,
      summaryBasis: meta.basis,
      dataNotice: meta.dataNotice,
      completeness: meta.completeness,
      gaps,
      hints
    }, extra || {}))
  },

  async _loadReport(cid, retry) {
    retry = retry || 0
    try {
      if (retry === 0) this._startLoading()
      const q = await api('getFamily', { familyId: cid })
      const code = (q.result && q.result.code)
      if (code !== 200) {
        // 未登录 → 等初始化完成后重试；其他错误 → 短暂重试 2 次
        if (code === 401 && retry < 3) { await new Promise(r => setTimeout(r, 1200)); return this._loadReport(cid, retry + 1) }
        if (code !== 401 && retry < 2) { await new Promise(r => setTimeout(r, 800)); return this._loadReport(cid, retry + 1) }
        this._stopLoading(); this.setData({ loading: false })
        const msg404 = '该客户档案已被删除或不存在，可能从其他设备操作了删除'
        const msg401 = '登录状态异常，请退出小程序重新进入'
        const msg = code === 404 ? msg404 : (code === 401 ? msg401 : '加载失败（' + code + '），请下拉刷新重试')
        wx.showModal({ title: '客户不存在', content: msg, showCancel: true, cancelText: '留在本页', confirmText: '返回首页', success: (r) => { if (r.confirm) wx.navigateBack() } })
        return
      }
      const c = q.result.data
      const rp = c.report || {}
      this._stopLoading()
      this._applyReportData(c, null, { loading: false })
      if (this._focus === 'review') this.setData({ focusAnchor: 'ch-review' })
      // 数据有更新（OCR/对话写入）但 AI 内容未刷新 → 提示用户
      if (c.insight_stale && rp.portrait) {
        this.setData({ reportUpdated: true })
      }
      if (!rp.portrait && retry < 1) {
        // 首次进入无分析：同步等待 reportAI 完成（其内部已 await AI 调用 + DB 写入），
        // 完成后立即重载，不再依赖固定延迟轮询
        this.setData({ loading: true, loadingText: '小秘正在生成报告...' })
        this._startLoading()
        // 内联 _triggerReport：try/catch 返回 null，便于降级重载判断
        let r = null
        try {
          const ar = await api('generateReport', { familyId: cid })
          r = (ar && ar.result) || null
        } catch (e) { console.error(e) }
        this._stopLoading()
        if (!r || r.code !== 200) {
          // reportAI 失败（冷启动超时/429限流等），降级重载
          return this._loadReport(cid, retry + 1)
        }
        // generateReport 已完成 DB 写入，直接重读并渲染
        const q = await api('getFamily', { familyId: cid })
        if (q.result && q.result.code === 200) {
          this._applyReportData(q.result.data, null, { loading: false })
          return
        }
        return this._loadReport(cid, retry + 1)
      }
    } catch (e) { console.error(e); this._stopLoading(); this.setData({ loading: false }) }
  },


  _startLoading() { clearInterval(this._loaderTimer); const texts = this._loadingTexts; if (!texts || !texts.length) { this.setData({ loadingText: '小秘正在加载...' }); return }; let i = 0; this._loaderTimer = setInterval(() => { if (this._disposed) { clearInterval(this._loaderTimer); return } i = (i + 1) % 3; this.setData({ loadingText: texts[i] || '小秘正在加载...' }) }, 2500) },
  _stopLoading() { clearInterval(this._loaderTimer); this._loaderTimer = null },

  // 统一报告刷新序列：触发 → 缓冲（确保 DB 写入可见）→ 重读 → 应用
  // waitMs 默认 500ms，调用方可传 0 跳过（仅 reportAI 同步返回完整数据时）
  async _refreshReportSequence(cid, opts) {
    opts = opts || {}
    const waitMs = opts.waitMs === undefined ? 500 : opts.waitMs
    // 内联 _triggerReport：此处忽略返回值，吞掉错误保持现有调用方契约
    try { await api('generateReport', { familyId: cid }) } catch (e) { console.error(e) }
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs))
    const q = await api('getFamily', { familyId: cid })
    if (q.result && q.result.code === 200) {
      this._applyReportData(q.result.data, null, opts.applyOpts || {})
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
      this.setData({ refreshing: false })
      this._refreshingReport = false
    }
  },

  onEditField(e) {
    const { field, member } = e.detail || {}
    // edit-form.buildEditConfig 统一三种模式（member/addMember/financials）的字段配置
    const mode = (field === 'member' && member) ? 'member'
      : (field === 'addMember' ? 'addMember' : 'financials')
    const cfg = buildEditConfig({ mode, family: this.data.family, member: member || {} })
    this.setData(Object.assign({ showEdit: true, editTitle: cfg.title }, cfg))
  },

  async onSaveEdit(e) {
    const vals = e.detail || {}, mode = this.data._editMode
    if (this.data.editSaving) return

    // 最小校验（前端 JS 层拦截，避免无效请求）
    const v = validateEdit(mode, vals)
    if (!v.ok) return wx.showToast({ title: v.msg, icon: 'none' })

    this.setData({ editSaving: true })
    try {
      const updateData = buildUpdateData(mode, vals, this.data.family, this.data._editMemberIdx)
      await api('updateFamily', { familyId: this.data.familyId, updateData })
      wx.showToast({ title: '小秘记下了', icon: 'none' }); this.setData({ showEdit: false, editSaving: false })
      // 统一刷新序列（修复原 0ms 缓冲可能读到陈旧数据的 bug）
      this._refreshReportSequence(this.data.familyId, { applyOpts: {} }).then(() => {
        this.setData({ reportUpdated: false })
      })
    } catch (e) {
      console.error(e)
      this.setData({ editSaving: false })
      wx.showToast({ title: '保存失败，请重试', icon: 'none', duration: 2500 })
    }
  },

  onCloseEdit() { this.setData({ showEdit: false }) },
  onChatUpload(e) { this._uploadMore(e.detail.paths) },
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
  async _uploadMore(paths) {
    var setData = this.setData.bind(this)
    var familyId = this.data.familyId
    if (!familyId) { wx.showToast({ title: '请先选择家庭', icon: 'none' }); return }
    var allFileIds = []
    flow.forgetDedupCache()
    this.setData(flow.start(paths.length))
    try {
      // ① 一次性全部上传
      var allUploadTasks = paths.map(function(path) {
        return flow.compressAndUpload([path], setData).then(function(r) { return r.fileIds[0] }).catch(function() { return null })
      })
      var allUpResults = await Promise.allSettled(allUploadTasks)
      for (var i = 0; i < allUpResults.length; i++) {
        var fid = allUpResults[i].status === 'fulfilled' ? allUpResults[i].value : null
        if (fid) allFileIds.push(fid)
      }
      setData({ 'ocrMask.uploaded': allFileIds.length })
      // ② 全部传入 ocrSingle（云函数内错峰 AI，消除冷启动）
      var allPolicies = [], cashValues = [], errors = []
      var validIds = allFileIds.filter(function(id) { return !!id })
      if (validIds.length > 0) {
        try {
          var ocrRes = await flow.batchOCR(validIds, setData, { familyId: familyId })
          allPolicies = ocrRes.policies || []
          cashValues = ocrRes.cashValues || []
          errors = ocrRes.errors || []
          setData({ 'ocrMask.processed': validIds.length })
        } catch (e2) { errors.push({ error: (e2 && e2.message) || 'OCR异常', error_code: 'ocr_exception' }) }
      }
      flow.cleanupTempFiles(allFileIds)
      if (!allPolicies.length && cashValues.length > 0) {
        this.setData(Object.assign(flow.setSaving(cashValues), { 'ocrMask.cashCount': cashValues.length }))
        var cr = await flow.saveCashValuesWithRetry(familyId, cashValues, setData)
        if (cr.ok) wx.showToast({ title: cr.matched ? '现价表已关联保单' : '现价表已保存', icon: 'success' })
        return
      }
      if (!allPolicies.length) { wx.showToast({ title: '未识别到保单', icon: 'none' }); this.setData(flow.hide()); return }
      this.setData(flow.setDone(allPolicies, cashValues, {
        'ocrMask.preview': allPolicies.slice(0, 10).map(function(p) { return { product_name: p.product_name || '未知', insurance_category: p.insurance_category || '未知' } })
      }))
    } catch (e) { this._ocrErrorUI(e, '识别失败'); this.setData(flow.hide()) }
    finally { flow.cleanupTempFiles(allFileIds) }
  },

  _ocrErrorUI(e, prefix) {
    const ui = flow.errorToUI(e)
    wx.showToast({ title: (prefix || '识别失败') + '：' + ui.content, icon: 'none', duration: 2500 })
  },

  async onOcrConfirm() {
    if (this.data.ocrMask.confirming) return
    this.setData(flow.setConfirming(true))
    const setData = this.setData.bind(this)
    const familyId = this.data.familyId
    const ok = await flow.confirmWritePolicies(familyId, this.data.ocrMask._policies, this.data.ocrMask._cashValues, setData)
    if (!ok || !ok.ok) {
      this.setData(flow.setConfirming(false))
      wx.showToast({ title: (ok && ok.error) || '写入失败，请重试', icon: 'none' })
      return
    }
    this.setData(Object.assign(flow.hide(), flow.setConfirming(false)))
    await this._refreshReportSequence(familyId, { applyOpts: {} })
  },

  // FAB 代理（组件内 position:fixed 失效，提到页面层渲染）
  _cp() { return this.selectComponent('#chatpanel') },
  switchTab(e) { const tab = e.currentTarget.dataset.tab; if (tab) this.setData({ activeTab: tab }) },
  onFabTap() { const cp = this._cp(); if (cp) cp.onFabTap() },
  onUploadFab() { const cp = this._cp(); if (cp) { cp.onUploadTap() } else { wx.showToast({ title: '对话模块加载中', icon: 'none' }) } },
  onFabInput(e) { this.setData({ fabText: e.detail.value }); const cp = this._cp(); if (cp) cp.onInput(e) },
  onFabFocus() { const cp = this._cp(); if (cp) cp.onFocus() },
  onFabSend() { const cp = this._cp(); if (cp) { cp.onSend(); this.setData({ fabText: '' }) } },
})
