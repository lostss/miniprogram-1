const { buildReportView } = require('../../utils/report-builder')
const { buildEditConfig, validate: validateEdit, buildUpdateData, POLICY_STATUS_OPTIONS, POLICY_STATUS_LABEL_TO_VALUE } = require('../../utils/edit-form')
const api = require('../../utils/apiClient')
const session = require('../../utils/session-store')
const errorHandler = require('../../utils/errorHandler')

// 免责声明：报告底部静态合规小字（reportAI 未产出时兜底，见 _applyReportData）
const DISCLAIMER_FALLBACK = '本报告基于OCR识别结果自动生成，数据仅供参考，不构成投保建议。请以保单原件为准。'

/** 报告页 v2.0 — 基础版报告（6 章单页长图 + 保单 Sheet） */
Page({
  data: {
    familyId: '', family: null, chapters: [],
    loading: true, loadError: false, loadingText: '小秘正在认真看保单...',
    // UI 审计 状态 S3：深度分析自定义弹层（可取消，替代 60s 锁死 showLoading）
    analysisShow: false, analysisSec: 0,
    showEdit: false, refreshing: false, editSaving: false,
    editTitle: '编辑', editFields: [], _editMode: '',
    // edit-sheet 显示态：view=只读查看（按钮=编辑）；edit=直接编辑（按钮=保存）；保单明细走 view，成员/财务直接 edit
    sheetMode: 'view',
    hints: [],
    // 全链路审计 UC4：无保单空状态（隐藏 hero/summary/chapters，显示引导卡）
    hasPolicy: true,
    reportMeta: { date: '', no: '' },
    disclaimer: '',
    hero: { alerts: [], summary: '', topAdvice: '', conclusion: '' },
    summaryCards: { premium: '', coverage: '', count: 0 },
    showMemberManage: false, memberManageList: [],
    fabText: '',
    // 分享模式：客户查看（share=1 只读脱敏，隐藏编辑/对话/FAB）
    isShared: false
  },
  // 真机 404 修复兜底：familyId 为 'undefined'/'null' 字面量（跳转传参异常时）→ 走"缺少客户信息"而非 getFamily 404 误报"客户不存在"
  onLoad(o) {
    const token = o.token || ''
    if (o.share === '1' || token) {
      this.setData({ isShared: true })
      this._clientToken = token
      if (!token) { this.setData({ loading: false }); wx.showModal({ title: '链接已失效', content: '缺少分享凭证，请联系代理人重新分享', showCancel: false, confirmText: '知道了', success: () => wx.reLaunch({ url: '/pages/index/index' }) }); return }
      this._loadSharedReport(token)
      return
    }
    const cid = o.familyId || o.customerId || ''
    if (!cid || cid === 'undefined' || cid === 'null') { this.setData({ loading: false }); wx.showModal({ title: '缺少客户信息', content: '请从首页选择客户打开报告', showCancel: false, confirmText: '返回首页', success: () => wx.reLaunch({ url: '/pages/index/index' }) }); return }
    session.setActiveFamily(cid); this.setData({ familyId: cid }); this._loadReport(cid)
  },
  onUnload() { this._disposed = true; clearInterval(this._loaderTimer); clearInterval(this._ocrTick); clearInterval(this._analysisTick) },
  // 返回键拦截：若 edit-sheet / 保单 Sheet / 成员管理 / chat-panel 展开，先关闭它们而非退出页面
  // 返回键：顶层优先关闭（edit-sheet 顶层 → policy-sheet → member-manage；审计 Bug 3 顺序修正）
  onBackPress() {
    // UI 审计 交互 S1：OCR 弹窗优先拦截（编辑 sheet → 确认放弃），防 OCR 中按返回退页丢进度
    const ocr = this.selectComponent('#ocrFlow')
    if (ocr && ocr.onBackPressed && ocr.onBackPressed()) return true
    if (this.data.showEdit) { this.onCloseEdit(); return true }
    if (this.data.showMemberManage) { this.closeMemberManage(); return true }
    const panel = this.selectComponent('#chatpanel')
    if (panel && panel.tryCollapse && panel.tryCollapse()) return true
    return false
  },
  // UI 审计 交互 M3：chat-panel 收起时同步清空 FAB 输入
  onChatCollapse() { this.setData({ fabText: '' }) },
  // AI 回复期间 FAB 发送按钮置灰（chat-panel busy 事件）
  onChatBusy(e) { this.setData({ chatBusy: !!e.detail.busy }) },

  // ===== 章节内编辑入口（设计稿：家庭结构/财务 [编辑]） =====
  onChapterEdit(e) {
    const detail = e.detail || {}
    const mode = detail.mode || ''
    const memberId = detail.memberId || ''
    if (mode === 'financials') {
      const cfg = buildEditConfig({ mode: 'financials', family: this.data.family })
      this.setData(Object.assign({ showEdit: true, editTitle: cfg.title, sheetMode: 'edit' }, cfg))
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
  // 风险提示 [核对]：打开对应保单编辑 Sheet（低置信字段带底色，设计稿 v4）
  onRiskCheck(e) {
    const detail = e.detail || {}
    const pid = detail.policyId || ''
    if (!pid || this._disposed) return
    const list = (this.data.family && this.data.family.policies) || []
    const p = list.find(x => (x._id || x.id) === pid)
    if (!p) return
    const cfg = buildEditConfig({ mode: 'policy', family: this.data.family, member: p })
    this.setData(Object.assign({ showEdit: true, editTitle: cfg.title, sheetMode: 'edit' }, cfg))
  },
  // 深度分析（手工触发）：调 reportAI（30s 节流），完成刷新报告（hero 结论更新）
  onDeepAnalysis() {
    if (this._analysisBusy || this._disposed) return
    const cid = this.data.familyId
    if (!cid) return
    this._analysisBusy = true
    this._analysisAborted = false
    const t0 = Date.now()
    // UI 审计 状态 S3：自定义弹层替代 showLoading（60s 长任务可取消，不锁死用户）；R-M1 阶段反馈由 analysisSec 承担
    this.setData({ analysisShow: true, analysisSec: 0 })
    this._analysisTick = setInterval(() => {
      if (this._disposed) { clearInterval(this._analysisTick); return }
      this.setData({ analysisSec: Math.round((Date.now() - t0) / 1000) })
    }, 1000)
    // R3v2 审计 #7：原 action 'reportAI' 未在 apiClient DIRECT_FN 注册（只有 generateReport）→ 功能永远失败
    // 改走 generateReport + 显式 60s 超时（reportAI 函数 timeout=60s，默认 30s 会先断+重试双份计费）
    api('generateReport', { familyId: cid }, { timeout: 60000, retries: 0 }).then(q => {
      clearInterval(this._analysisTick)
      this.setData({ analysisShow: false })
      this._analysisBusy = false
      // 用户已取消：云函数仍会完成，但结果标记忽略
      if (this._disposed || this._analysisAborted) return
      if (q && q.ok) {
        wx.showToast({ title: '分析完成', icon: 'success' })
        this._refreshReportSequence(cid, { waitMs: 0 })
      } else if (q && q.throttled) {
        wx.showToast({ title: '已是最新分析', icon: 'none' })
      } else {
        wx.showToast({ title: (q && q.msg) || '分析失败，请重试', icon: 'none' })
      }
    }).catch(() => {
      clearInterval(this._analysisTick)
      this.setData({ analysisShow: false })
      this._analysisBusy = false
      if (!this._disposed) wx.showToast({ title: '分析失败，请重试', icon: 'none' })
    })
  },
  // UI 审计 状态 S3：取消深度分析（UI 立即释放；请求结果回来时由 _analysisAborted 忽略）
  onAnalysisCancel() {
    this._analysisAborted = true
    this._analysisBusy = false
    clearInterval(this._analysisTick)
    this.setData({ analysisShow: false })
    wx.showToast({ title: '已取消分析', icon: 'none' })
  },
  _openMemberEdit(memberId) {
    const list = (this.data.family && this.data.family.members) || []
    const m = list.find(x => x.member_id === memberId)
    if (!m) return
    const cfg = buildEditConfig({ mode: 'member', family: this.data.family, member: m })
    // 弹窗互斥：edit-sheet 为独占顶层，打开时清掉底层 member-manage（审计 Bug 1）
    this.setData(Object.assign({ showEdit: true, editTitle: cfg.title, sheetMode: 'edit', showMemberManage: false, memberManageList: [] }, cfg))
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
    // 弹窗互斥：打开 edit-sheet 同时清掉底层 member-manage（审计 Bug 1）
    // sheetMode:'edit'：新增成员空表单直接编辑（否则残留 onPolicyTap/onCloseEdit 的 'view' → 只读不可输入）
    this.setData(Object.assign({ showEdit: true, editTitle: cfg.title, sheetMode: 'edit', showMemberManage: false, memberManageList: [] }, cfg))
  },
  // 家庭结构可编辑性：删除成员（确认后从全量 members 移除 → updateFamily → _syncMembers 软删，保留审计轨迹）
  onMemberManageDelete(e) {
    const mid = (e.currentTarget.dataset && e.currentTarget.dataset.mid) || ''
    if (!mid || this.data.editSaving) return
    const list = (this.data.family && this.data.family.members) || []
    const target = list.find(x => x.member_id === mid)
    if (!target) return
    wx.showModal({
      title: '删除成员',
      content: '确定删除成员「' + (target.name || '未命名') + '」？删除后不再出现在保障报告。',
      confirmText: '删除',
      confirmColor: '#B85450',
      success: (res) => {
        if (!res.confirm) return
        const remaining = list.filter(x => x.member_id !== mid)
        api('updateFamily', { familyId: this.data.familyId, updateData: { members: remaining } })
          .then(r => {
            if (this._disposed) return
            if (r.ok) {
              wx.showToast({ title: '已删除', icon: 'success' })
              // UI 审计 F-M3：成员删除后清首页缓存
              try { wx.removeStorageSync('homeRecentClients') } catch (e) {}
              this.setData({ showMemberManage: false, memberManageList: [] })
              this._loadReport(this.data.familyId)
            } else {
              wx.showToast({ title: r.msg || '删除失败', icon: 'none' })
            }
          })
          .catch(() => {
            if (!this._disposed) wx.showToast({ title: '网络异常，删除失败', icon: 'none' })
          })
      }
    })
  },

  _loadingTexts: ['小秘正在认真看保单...', '小秘正在整理报告...', '小秘正在加载报告...'],

  // 统一刷新聚合：视图一次算好（buildReportView 深模块），所有刷新点共用
  _applyReportData(c, reportOverride, extra) {
    const rp = reportOverride || (c.report || {})
    const view = buildReportView(c, rp)
    const reportMeta = this._buildReportMeta()
    this.setData(Object.assign({
      family: c,
      reportMeta: reportMeta,
      chapters: view.chapters,
      hero: view.hero,
      summaryCards: view.summaryCards,
      hints: view.hints,
      // 免责声明：页面底部小字承载（不进入章节），reportAI 未产出时兜底
      disclaimer: String(rp.disclaimer || '') || DISCLAIMER_FALLBACK,
      // 全链路审计 UC4：无保单时走空状态（buildReportView 对空 policies 产生零值+红色告警，需引导而非报错）
      hasPolicy: !!(c.policies && c.policies.length > 0)
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
        // UI 审计 R-S1：失败即标记错误态（WXML 渲染错误分支 + 重试入口，不再空白死胡同）
        this._stopLoading(); this.setData({ loading: false, loadError: true })
        const msg404 = '该客户档案已被删除或不存在，可能从其他设备操作了删除'
        const msg401 = '登录状态异常，请退出小程序重新进入'
        const msg = code === 404 ? msg404 : (code === 401 ? msg401 : '加载失败（' + code + '），请下拉刷新重试')
        // 错误提示审计 #1：title 按 code 分流，消除"标题客户不存在/正文登录异常"语义冲突
        const modalTitle = code === 404 ? '客户不存在' : (code === 401 ? '登录异常' : '加载失败')
        // UI 审计 R-S2：404 家庭已删除，"留在本页"是死胡同（空白无内容可看），移除取消项强制回首页
        const is404 = code === 404
        wx.showModal({ title: modalTitle, content: msg, showCancel: !is404, cancelText: is404 ? '' : '留在本页', confirmText: '返回首页', success: (r) => { if (r.confirm) wx.reLaunch({ url: '/pages/index/index' }) } })
        return
      }
      const c = q.data
      this._stopLoading()
      this._applyReportData(c, null, { loading: false, loadError: false })
      this._ensureShareToken(cid)
    } catch (e) { console.error(e); this._stopLoading(); if (!this._disposed) this.setData({ loading: false, loadError: true }) }
  },

  // 分享 token 预生成（owner 端）：进入报告页即懒生成，onShareAppMessage 复用；失败静默（分享时兜底 familyId 旧路径）
  async _ensureShareToken(cid) {
    if (!cid || this._disposed || this._shareToken) return
    try {
      const q = await api('shareFamily', { familyId: cid })
      if (!this._disposed && q && q.ok && q.data) this._shareToken = q.data.token
    } catch (e) { /* 静默：分享 token 非关键路径 */ }
  },
  // 客户查看模式：token 鉴权读取脱敏报告（只读规则版 7 章，不含 AI 深度分析文本）
  // 审计修复：失败区分 404（链接失效，重试无意义 → 弹窗引导返回）与其他错误（进 loadError 态，可重试）
  async _loadSharedReport(token) {
    try {
      this._startLoading()
      const q = await api('getSharedFamily', { token: token })
      if (this._disposed) return
      this._stopLoading()
      if (!q.ok) {
        if (q.code === 404) {
          this.setData({ loading: false, loadError: false })
          wx.showModal({ title: '链接已失效', content: '该分享链接已过期或已被撤销，请联系代理人重新分享', showCancel: false, confirmText: '知道了', success: () => wx.reLaunch({ url: '/pages/index/index' }) })
        } else {
          // 网络等瞬时错误：进错误态卡（onRetryReport 用 token 重试），不强制踢回首页
          this.setData({ loading: false, loadError: true })
        }
        return
      }
      this._applyReportData(q.data, null, { loading: false, loadError: false })
    } catch (e) {
      console.error(e)
      this._stopLoading()
      if (!this._disposed) this.setData({ loading: false, loadError: true })
    }
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
    const token = this._clientToken || this._shareToken || ''
    const path = token ? '/pages/report/index?token=' + token + '&share=1' : '/pages/report/index?familyId=' + this.data.familyId
    return { title: title, path: path, imageUrl: '' }
  },
  onShareTimeline() {
    const c = this.data.family || {}
    const hero = this.data.hero || {}
    const conc = hero.conclusion ? '｜' + hero.conclusion.slice(0, 14) : ''
    const title = ((c.name || '家庭') + '保障检视' + conc).slice(0, 35)
    const token = this._clientToken || this._shareToken || ''
    const query = token ? 'token=' + token + '&share=1' : 'familyId=' + this.data.familyId
    return { title: title, query: query }
  },
  // 报告封面元数据：日期与编号基于"报告更新日期"（family.updated_at 数据更新时间优先，last_analysis_at 兜底）
  // 原用 new Date()（当前时间）导致每次刷新编号日期都变化，且与报告内容更新时间不符
  _buildReportMeta() {
    const f = this.data.family || {}
    const ts = f.updated_at || f.last_analysis_at
    let d = ts ? new Date(ts) : new Date()
    if (isNaN(d.getTime())) d = new Date()
    const pad = function(n) { return String(n).padStart(2, '0') }
    // 年月日 + 时:分，正规显示（如 2026年08月08日 14:30）
    const dateTime = d.getFullYear() + '年' + pad(d.getMonth() + 1) + '月' + pad(d.getDate()) + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    return { dateTime: dateTime }
  },

  // 上下文审计：数据变更后失效对话 prompt-cache（chat-panel 实例存活时直接调其 invalidate）
  _invalidateChatPrompt() {
    try {
      const panel = this.selectComponent('#chatpanel')
      if (panel && panel._promptCache) panel._promptCache.invalidate()
    } catch (e) { /* 组件未就绪/异常：静默跳过，依赖 5min TTL 自然过期 */ }
  },

  // 页面级下拉刷新委托给 onRefreshReport
  // 弹窗锁屏兜底：ocr-flow（识别结果/编辑 sheet）或页面自身 sheet 任一打开时，下拉刷新空转。
  // 真机上页面原生下拉手势可能绕过 JS catchtouchmove，此处拦截是第二道防线（配合各遮罩 catchtouchmove）。
  // catchtouchmove 拦截（member/policy sheet 遮罩拖动不穿透到页面 scroll-view）
  onNoop() {},
  onPullDownRefresh() {
    const ocr = this.selectComponent('#ocrFlow')
    // UI 审计 F-M1：chat-panel 展开时同样拦截（否则 wx.showLoading 盖在对话面板上方）
    const panel = this.selectComponent('#chatpanel')
    const overlayOpen = !!(
      (ocr && (ocr.data.ocrMask.visible || ocr.data.ocrSheet.visible)) ||
      this.data.showEdit || this.data.showPolicySheet || this.data.showMemberManage
    )
    if (overlayOpen || (panel && !panel.data.collapsed)) { wx.stopPullDownRefresh(); return }
    if (this.data.isShared) { wx.stopPullDownRefresh(); this._loadSharedReport(this._clientToken); return }
    this.onRefreshReport()
  },
  // UI 审计 R-S1：错误态重试 / 返回首页
  // 审计修复：分享模式（token 鉴权）重试走 _loadSharedReport，普通模式走 _loadReport
  onRetryReport() {
    if (this._disposed) return
    this.setData({ loading: true, loadError: false })
    if (this.data.isShared) {
      if (this._clientToken) this._loadSharedReport(this._clientToken)
      else this.setData({ loading: false, loadError: true })
      return
    }
    this._loadReport(this.data.familyId)
  },
  onGoHome() { wx.reLaunch({ url: '/pages/index/index' }) },
  async onRefreshReport() {
    if (this._refreshingReport) return
    this._refreshingReport = true
    const cid = this.data.familyId
    if (!cid) { wx.stopPullDownRefresh(); this._refreshingReport = false; return }
    this.setData({ refreshing: true })
    wx.showLoading({ title: '正在刷新报告...', mask: true })
    try {
      const ok = await this._refreshReportSequence(cid, { applyOpts: {} })
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

      // 状态变更二次确认：从有效/未知改为失效/退保/理赔终止属于影响报告的关键操作
      if (mode === 'policy' && vals.status) {
        const newStatus = POLICY_STATUS_LABEL_TO_VALUE[vals.status]
        const pid = this.data._editMemberIdx
        const current = (this.data.family && this.data.family.policies || []).find(p => (p.id === pid) || (p._id === pid))
        const oldActive = !current || !current.status || current.status === 'active' || current.status === 'unknown'
        if (newStatus && newStatus !== 'active' && oldActive) {
          const confirmed = await new Promise(function(resolve) {
            wx.showModal({
              title: '确认变更状态？',
              content: '该保单将标记为「' + vals.status + '」，不再计入保障汇总/缴费月历。确认变更？',
              confirmText: '确认变更',
              cancelText: '取消',
              success: (r) => resolve(!!r.confirm)
            })
          })
          if (!confirmed) return
        }
      }


    this.setData({ editSaving: true })
    try {
      if (mode === 'policy') {
        // 保单编辑走 updatePolicy（白名单字段 + 事实同步）
        const r = buildUpdateData('policy', vals, null, this.data._editMemberIdx)
        await api('updatePolicy', { familyId: this.data.familyId, policyId: r.updatePolicy.policyId, data: r.updatePolicy.data })
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
      // UI 审计 F-M3：编辑已持久化 → 清首页 60s 缓存，返回首页不再显示过期成员数/完整度
      try { wx.removeStorageSync('homeRecentClients') } catch (e) {}
      // 上下文审计：数据已变更 → 失效对话 prompt-cache（否则对话画像停留 5min 旧值）
      this._invalidateChatPrompt()
      wx.showToast({ title: '小秘记下了', icon: 'none' }); this.setData({ showEdit: false, editSaving: false, showMemberManage: false, memberManageList: [] })
      // 后台静默校验：DB 已写入完成（无需缓冲），读回规范化数据（member_id/fact 同步等）
      this._refreshReportSequence(this.data.familyId, { waitMs: 0, applyOpts: {} }).catch(e => { console.error('[report] 刷新失败:', e.message) })
    } catch (e) {
      console.error(e)
      this.setData({ editSaving: false })
      // 错误提示审计 #3+#4：写操作错误统一走 errorHandler（文案收敛 + 云端上报）
      errorHandler.handle(e, { context: 'saveEdit' })
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

  // 弹窗互斥：取消编辑时清理全部底层 sheet（审计 Bug 1/2：仅保存路径有关闭，取消路径全漏）
  // UI 审计 交互 M5：关闭同时清空编辑字段状态，防下次打开残留旧配置
  onCloseEdit() { this.setData({ showEdit: false, showMemberManage: false, memberManageList: [], editFields: [], editTitle: '编辑', _editMode: '', sheetMode: 'view' }) },
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

  // ===== 保单明细（附录卡片点击）—— 复用统一 edit-sheet：view 态只读 → [编辑] 切编辑态 → [保存] =====
  onPolicyTap(e) {
    const id = (e.detail && e.detail.policyId) || ''
    const list = (this.data.family && this.data.family.policies) || []
    const p = list.find(x => (x.id === id) || (x._id === id))
    if (!p) return
    const cfg = buildEditConfig({ mode: 'policy', family: this.data.family, member: p })
    // 弹层叠加审计：与 onMemberManageEdit/onMemberManageAdd 互斥模式对齐——打开 sheet 同时清底层 member sheet
    this.setData(Object.assign({ showEdit: true, editTitle: cfg.title, sheetMode: 'view', showMemberManage: false, memberManageList: [] }, cfg))
  },
    // 快速状态变更：点击保单卡片上的状态标识直接弹出操作项
    onStatusChange(e) {
      if (this.data.isShared) return
      const id = (e.detail && e.detail.policyId) || ''
      const list = (this.data.family && this.data.family.policies) || []
      const p = list.find(x => (x.id === id) || (x._id === id))
      if (!p) return

      wx.showActionSheet({
        itemList: POLICY_STATUS_OPTIONS,
        success: (res) => {
          const label = POLICY_STATUS_OPTIONS[res.tapIndex]
          const status = POLICY_STATUS_LABEL_TO_VALUE[label]
          if (!status || status === p.status) return

          if (status !== 'active' && (p.status === 'active' || !p.status || p.status === 'unknown')) {
            wx.showModal({
              title: '确认变更状态？',
              content: '该保单将标记为「' + label + '」，不再计入保障汇总/缴费月历。确认变更？',
              confirmText: '确认变更',
              cancelText: '取消',
              success: (r) => {
                if (r.confirm) this._changePolicyStatus(p, status)
              }
            })
          } else {
            this._changePolicyStatus(p, status)
          }
        }
      })
    },

    async _changePolicyStatus(p, status) {
      if (this._changingStatus) return
      this._changingStatus = true
      try {
        const q = await api('changePolicyStatus', {
          familyId: this.data.familyId,
          policyId: p.id || p._id,
          status
        })
        if (!q.ok) throw new Error(q.msg || '状态变更失败')
        // 本地立即更新
        const localFamily = this._applyLocalUpdate({ updatePolicy: { policyId: p.id || p._id, data: { status } } })
        if (localFamily) this._applyReportData(localFamily, null, {})
        try { wx.removeStorageSync('homeRecentClients') } catch (err) {}
        this._invalidateChatPrompt()
        wx.showToast({ title: '状态已更新', icon: 'none' })
        // 后台静默校验
        this._refreshReportSequence(this.data.familyId, { waitMs: 0, applyOpts: {} }).catch(err => { console.error('[report] 状态刷新失败:', err.message) })
      } catch (err) {
        console.error(err)
        errorHandler.handle(err, { context: 'changePolicyStatus' })
      } finally {
        this._changingStatus = false
      }
    },

  onSheetNoop() {},
  onFabTap() { const cp = this._cp(); if (cp) cp.onFabTap() },
  onUploadFab() { this._startFlow() },
  onFabInput(e) { this.setData({ fabText: e.detail.value }); const cp = this._cp(); if (cp) cp.onInput(e) },
  onFabFocus() { const cp = this._cp(); if (cp) cp.onFocus() },
  onFabSend() {
    const cp = this._cp()
    if (cp) {
      // FAB 输入清空时机修复：发送即清（onSend 是 async，resolve(true) 要等流式+B 通道完成，
      // 原等 then 才清导致文本遗留到 AI 回复输出后）；onSend 返回 false（守卫/注入/异常拦截）时微任务内恢复文本
      const prev = this.data.fabText
      this.setData({ fabText: '' })
      const ok = cp.onSend()
      if (ok && ok.then) {
        ok.then(sent => { if (!sent) this.setData({ fabText: prev }) })
      } else if (!ok) {
        this.setData({ fabText: prev })
      }
    }
  },
})
