const { buildReportView } = require('../../utils/report-builder')
const { buildEditConfig, validate: validateEdit, buildUpdateData, POLICY_STATUS_OPTIONS, POLICY_STATUS_LABEL_TO_VALUE } = require('../../utils/edit-form')
const { buildShareTitle, buildSharePath, buildReportMeta, ensureShareToken } = require('../../utils/report-share')
const { HOME_CACHE_KEY } = require('../../utils/family-actions')
const api = require('../../utils/apiClient')
// 领域写薄层（候选 5）：表单保存收敛三种写入范式，避免调用方直拼字符串 action
const { savePolicyData, saveFamilyPatch } = require('../../utils/domain-writes')
const session = require('../../utils/session-store')
const errorHandler = require('../../utils/errorHandler')
const { createReportAnalysis } = require('../../utils/report-analysis')
// 画像确认：本地 readiness 判定（与后端 reportAI 共用同一事实源，sync-shared 契约同步）
const { evaluateReadiness } = require('../../utils/readiness')

// 免责声明：报告底部静态合规小字（reportAI 未产出时兜底，见 _applyReportData）
const DISCLAIMER_FALLBACK = '本报告基于OCR识别结果自动生成，数据仅供参考，不构成投保建议。请以保单原件为准。'

/** 报告页 v2.0 — 基础版报告（6 章单页长图 + 保单 Sheet） */
Page({
  data: {
    familyId: '', family: null, chapters: [],
    loading: true, loadError: false, loadingText: '小秘正在认真看保单...',
    // UI 审计 状态 S3：深度分析自定义弹层（可取消，替代 60s 锁死 showLoading）
    analysisShow: false, analysisSec: 0,
    // readiness 门禁（2026-08）：深度分析前置检查清单
    readinessShow: false, readiness: null,
    showEdit: false, refreshing: false, editSaving: false,
    // scroll-view refresher 受控态（2026-09-06：页面主体为 scroll-view，页面级下拉被吞，改用原生 refresher）
    pullDownTriggered: false,
    editTitle: '编辑', editFields: [], _editMode: '',
    // edit-sheet 显示态：view=只读查看（按钮=编辑）；edit=直接编辑（按钮=保存）；保单明细走 view，成员/财务直接 edit
    sheetMode: 'view',
    // 全链路审计 UC4：无保单空状态（隐藏 hero/summary/chapters，显示引导卡）
    hasPolicy: true,
    reportMeta: { date: '', no: '' },
    // 活报告模型（2026-09）：summary 结构标签 + 时效标识（owner stale 提示）+ 待澄清项（owner）
    familyTag: '', staleTag: '', clarifications: [],
    // 2026-09-11：孤儿现价表（自动匹配未中）→ 「待关联」入口数据源（owner 展示）
    unmatchedCashValues: [],
    disclaimer: '',
    hero: { alerts: [], summary: '', topAdvice: '', conclusion: '' },
    summaryCards: { premium: '', coverage: '', count: 0 },
    showMemberManage: false, memberManageList: [],
    fabText: '',
    // 分享模式：客户查看（share=1 只读脱敏，隐藏编辑/对话/FAB）
    isShared: false,
    // 对话空态预埋问题（从缺口引擎生成"您可能想问"，回退空数组用组件默认提示）
    presetHints: [],
  },
  // 真机 404 修复兜底：familyId 为 'undefined'/'null' 字面量（跳转传参异常时）→ 走"缺少客户信息"而非 getFamily 404 误报"客户不存在"
  onLoad(o) {
    // 重构审计：深度分析关切下沉 controller（一次一个关切拆分 report 页）
    this._analysisCtl = createReportAnalysis({
      getFamilyId: () => this.data.familyId,
      setData: this.setData.bind(this),
      onDone: (cid) => this._refreshReportSequence(cid, { waitMs: 0 }),
      // readiness 门禁：422 明细 → 渲染补全清单（同一 tick 关分析弹层，无闪烁；补齐画像摘要供弹窗渲染）
      onBlocked: (readiness) => {
        if (!readiness.portrait) readiness.portrait = this._buildPortrait(this.data.family || {})
        this.setData({ readinessShow: true, readiness })
      }
    })
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
  // OCR 批次恢复（与首页 onShow 一致）：report 页上传中断后回到页面可继续处理未完成批次
  onShow() {
    const ocr = this.selectComponent('#ocrFlow')
    if (ocr && ocr.checkResume) ocr.checkResume()
  },
  onUnload() {
    this._disposed = true
    clearInterval(this._loaderTimer)
    if (this._autoRetryTimer) { clearTimeout(this._autoRetryTimer); this._autoRetryTimer = null }
    if (this._analysisCtl) this._analysisCtl.destroy()
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
      this._openEditSheet(buildEditConfig({ mode: 'financials', family: this.data.family }))
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
    // 审计修复：pid 来自 `p.id || p._id`（chapter-builder），比对必须业务 id 与文档 _id 都试；
    // 原 `(x._id || x.id)` 恒取 _id，对带 pol_xxx 业务 id 的保单永不相等 → [核对] 无反应
    const p = list.find(x => (x.id === pid) || (x._id === pid))
    if (!p) return
    this._openEditSheet(buildEditConfig({ mode: 'policy', family: this.data.family, member: p }))
  },
  // 活报告模型（2026-09）：待澄清项「去补全」→ 按缺失类型直达补录入口（复用现有编辑 sheet）
  onClarifyFix(e) {
    const d = e.currentTarget.dataset || {}
    const mode = d.mode || ''
    const id = d.id || ''
    if (this._disposed) return
    if (mode === 'financials') { this._openEditSheet(buildEditConfig({ mode: 'financials', family: this.data.family })); return }
    if (mode === 'member' && id) { this._openMemberEdit(id); return }
    if (mode === 'policy' && id) {
      const list = (this.data.family && this.data.family.policies) || []
      const p = list.find(x => (x._id || x.id) === id)
      if (p) this._openEditSheet(buildEditConfig({ mode: 'policy', family: this.data.family, member: p }))
      return
    }
    wx.showToast({ title: '请先在报告对应位置补充该信息', icon: 'none' })
  },
  // 待关联现价表 → 人工关联到保单（2026-09-11）。
  // 自动匹配靠"产品名去后缀取前 8 字 + 被保人"模糊比对，不中即 matched=false 永远躺在库里；
  // 此入口让用户手动指定目标保单，写入 matched_by='manual'（该状态此前只有保护逻辑、无写入路径）。
  onLinkCashValue(e) {
    if (this._disposed || this.data.isShared) return
    const ds = (e.currentTarget && e.currentTarget.dataset) || {}
    const cv = (this.data.family && this.data.family.unmatchedCashValues || [])[Number(ds.idx)]
    if (!cv) return
    const policies = (this.data.family && this.data.family.policies) || []
    if (!policies.length) { wx.showToast({ title: '该家庭暂无保单可关联', icon: 'none' }); return }
    // 候选排序：被保人同名优先（最强信号）→ 通常含现价的长期险种优先；showActionSheet 上限 6 项
    const LONG_TERM = ['寿险', '终身寿险', '重疾险', '年金', '增额终身寿', '年金险']
    const ranked = policies.slice().sort(function(a, b) {
      const sa = (cv.insured_name && a.insured_name === cv.insured_name ? 10 : 0) + (LONG_TERM.indexOf(a.insurance_category || '') >= 0 ? 3 : 0)
      const sb = (cv.insured_name && b.insured_name === cv.insured_name ? 10 : 0) + (LONG_TERM.indexOf(b.insurance_category || '') >= 0 ? 3 : 0)
      return sb - sa
    }).slice(0, 6)
    const self = this
    wx.showActionSheet({
      alertText: '把「' + (cv.product_name || '现价表') + '」关联到哪张保单？',
      itemList: ranked.map(function(p) {
        return ((p.product_name || '未命名产品') + (p.insured_name ? '（' + p.insured_name + '）' : '')).slice(0, 40)
      }),
      success(res) {
        const target = ranked[res.tapIndex]
        if (!target) return
        const pid = target.id || target._id
        wx.showLoading({ title: '关联中...', mask: true })
        api('linkCashValue', { familyId: self.data.familyId, cashValueId: cv._id, policyId: pid }, { retries: 0 })
          .then(function(r) {
            wx.hideLoading()
            if (r && r.ok) {
              wx.showToast({ title: '已关联到' + (target.product_name || '保单'), icon: 'success' })
              // 关联后现价/回本列与保障节点会立即变化 → 重拉报告数据
              self._refreshReportSequence(self.data.familyId, { waitMs: 0, applyOpts: {} }).catch(function() {})
            } else {
              wx.showToast({ title: (r && r.msg) || '关联失败', icon: 'none' })
            }
          })
          .catch(function() { wx.hideLoading(); wx.showToast({ title: '关联失败，请重试', icon: 'none' }) })
      }
    })
  },
  // 深度分析（手工触发）：仅 BLOCK 级缺口先弹画像确认，WARN 直接开始（后端 422 兜底仍会拦截）
  // 用户决策（2026-08-31）：画像确认按需——BLOCK 影响产出质量强制核对，WARN 不打断流程
  onDeepAnalysis() {
    if (this._disposed) return
    const family = this.data.family
    if (!family) { wx.showToast({ title: '请先加载报告', icon: 'none' }); return }
    const readiness = this._evalReadiness(family)
    if (readiness.hasBlockers) {
      readiness.portrait = this._buildPortrait(family)
      this.setData({ readinessShow: true, readiness })
    } else if (this._analysisCtl) {
      this._analysisCtl.start()
    }
  },
  // 画像确认：信息属实，开始分析
  onReadinessConfirm() {
    this.setData({ readinessShow: false, readiness: null })
    if (this._analysisCtl) this._analysisCtl.start()
  },
  // 本地 readiness 判定：前端 family 数据 → evaluateReadiness 契约映射（finance 内嵌对象 → 数组首位）
  _evalReadiness(family) {
    family = family || {}
    const fin = family.financial_snapshot || {}
    const debt = fin.debt || family.debt || {}
    const income = fin.income != null ? fin.income : family.family_income
    return evaluateReadiness({
      familyMeta: family,
      members: family.members || [],
      finances: [{
        annual_income: income, income: income,
        total_debt: debt.amount, debt: debt.amount,
        fixed_annual_expense: fin.fixed_expense, fixed_expense: fin.fixed_expense,
        annual_premium_budget: fin.annual_premium_budget
      }],
      policies: family.policies || []
    })
  },
  // 画像摘要（弹窗展示：成员/财务/保障摘要，缺口由 readiness.dimensions 高亮）
  _buildPortrait(family) {
    family = family || {}
    const members = (family.members || []).filter(m => m.status !== 'deleted')
    const fin = family.financial_snapshot || {}
    const debt = fin.debt || family.debt || {}
    const income = fin.income != null ? fin.income : family.family_income
    const policies = family.policies || []
    return {
      members: members.map(m => ({
        name: m.name || '未命名', role: m.role || '未设角色',
        ageText: m.age ? m.age + '岁' : (m.birth_date ? '由出生日期推算' : '未填'),
        health: m.health || '未填', income: m.income != null ? m.income + '万' : '未填'
      })),
      income: income != null ? income + '万' : '未填写',
      debt: debt.amount != null ? debt.amount + '万' : '未填写',
      fixedExpense: fin.fixed_expense != null ? fin.fixed_expense + '万' : '未填写',
      policyCount: policies.length,
      activePolicyCount: policies.filter(p => p.status === 'active' || !p.status).length
    }
  },
  // UI 审计 状态 S3：取消深度分析（UI 立即释放；请求结果回来时由 controller 内部 aborted 忽略）
  onAnalysisCancel() {
    if (this._analysisCtl) this._analysisCtl.cancel()
  },
  // readiness 门禁（2026-08）：清单 [去补全] → 复用既有 edit-sheet（member/addMember/financials/policy/upload）
  onReadinessFix(e) {
    const ds = (e.currentTarget && e.currentTarget.dataset) || {}
    const mode = ds.mode || ''
    const id = ds.id || ''
    this.setData({ readinessShow: false, readiness: null })
    if (mode === 'addMember') {
      this._openEditSheet(buildEditConfig({ mode: 'addMember', family: this.data.family }))
      return
    }
    if (mode === 'member' && id) { this._openMemberEdit(id); return }
    if (mode === 'financials') {
      this._openEditSheet(buildEditConfig({ mode: 'financials', family: this.data.family }))
      return
    }
    if (mode === 'policy' && id) {
      const list = (this.data.family && this.data.family.policies) || []
      const p = list.find(x => (x.id === id) || (x._id === id))
      if (p) this._openEditSheet(buildEditConfig({ mode: 'policy', family: this.data.family, member: p }), 'view')
      return
    }
    if (mode === 'upload') { this._startFlow(); return }
  },
  onReadinessClose() { this.setData({ readinessShow: false, readiness: null }) },
  // 弹窗互斥单一入口（候选 1）：edit-sheet 独占顶层，打开即清底层 member-manage（审计 Bug 1 语义单点化）
  // sheetMode：'edit' 直接编辑 / 'view' 只读查看（保单明细等）
  _openEditSheet(cfg, sheetMode) {
    this.setData(Object.assign({ showEdit: true, editTitle: cfg.title, sheetMode: sheetMode || 'edit', showMemberManage: false, memberManageList: [] }, cfg))
  },
  _openMemberEdit(memberId) {
    const list = (this.data.family && this.data.family.members) || []
    const m = list.find(x => x.member_id === memberId)
    if (!m) return
    this._openEditSheet(buildEditConfig({ mode: 'member', family: this.data.family, member: m }))
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
    // sheetMode:'edit'：新增成员空表单直接编辑（否则残留 onPolicyTap/onCloseEdit 的 'view' → 只读不可输入）
    this._openEditSheet(buildEditConfig({ mode: 'addMember', family: this.data.family }))
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
        saveFamilyPatch({ familyId: this.data.familyId, updateData: { members: remaining } })
          .then(r => {
            if (this._disposed) return
            if (r.ok) {
              wx.showToast({ title: '已删除', icon: 'success' })
              // UI 审计 F-M3：成员删除后清首页缓存
              try { wx.removeStorageSync(HOME_CACHE_KEY) } catch (e) {}
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
  // 对话空态预埋问题：从缺口引擎生成具体追问（高优先级缺口优先），无缺口数据时回退空数组（chat-panel 用默认提示）
  _buildPresetQuestions(view, family) {
    const qs = []
    const gaps = (view && view.gaps) || []
    const order = { high: 0, medium: 1, low: 2 }
    const missing = gaps.filter(function(g) { return g.gap > 0 && g.member }).sort(function(a, b) { return (order[a.priority] || 9) - (order[b.priority] || 9) })
    for (const g of missing.slice(0, 2)) {
      const cat = String(g.category || '')
      const short = cat.length > 1 && cat.charAt(cat.length - 1) === '险' ? cat.slice(0, -1) : cat
      qs.push(g.member + '的' + short + '缺口为什么是' + (g.gap || 0) + '万？')
    }
    const sc = (view && view.summaryCards) || {}
    const premiumW = parseFloat(sc.premium)
    const income = family && family.family_income
    if (premiumW > 0 && income > 0) {
      // 审计 P1-6：premiumW(万)/income(万) 均为万口径，占比 = 保费÷收入×100；此前误乘 10000 放大
      const pct = Math.round(premiumW / income * 10000) / 100
      qs.push('家庭保费占收入' + pct + '%，合理吗？')
    }
    return qs.slice(0, 3)
  },

  _applyReportData(c, reportOverride, extra) {
    // 2026-09-06：保障分析恒展开完整解读（无折叠态）
    const rp = reportOverride || (c.report || {})
    // 双视图：客户版（share=1）走中性措辞 + 置信度/现价回本隐藏；owner 版行为不变
    const view = buildReportView(c, rp, { view: this.data.isShared ? 'shared' : 'owner' })
    // 审计 P1-1：meta 必须基于本次 family（c），不能读 this.data.family（setData 前是旧值/首次为 null，
    // 否则标题日期首次显示当前时刻、后续滞后一个刷新周期，且分享标题同步错）
    const reportMeta = buildReportMeta(c)
    // 活报告模型（2026-09）：summary（家庭保障结构标签）接线页头；stale 提示仅 owner 且已有分析待刷新
    const summaryText = rp.summary || ''
    const familyTag = summaryText ? String(summaryText).replace(/\s+/g, ' ').slice(0, 50) : ''
    const staleTag = (!this.data.isShared && !!c.insight_stale && !!view.deep) ? '数据有更新，下拉刷新报告内容' : ''
    this.setData(Object.assign({
      family: c,
      reportMeta: reportMeta,
      familyTag: familyTag,
      staleTag: staleTag,
      // 活报告模型（2026-09）：待澄清项（readiness 缺失清单派生，owner 展示；客户版不渲染）
      clarifications: this.data.isShared ? [] : (Array.isArray(c.pending_clarifications) ? c.pending_clarifications.slice(0, 5) : []),
      // 2026-09-11：待关联现价表（客户版不渲染，与 clarifications 同口径）
      unmatchedCashValues: this.data.isShared ? [] : (Array.isArray(c.unmatchedCashValues) ? c.unmatchedCashValues : []),
      chapters: view.chapters,
      hero: view.hero,
      summaryCards: view.summaryCards,
      // 深度分析（AI 专家解读）：无深度分析时为 null，WXML wx:if 隐藏
      deep: view.deep,
      // 合规审计 P0-1：免责声明固定模板——法律文书必须稳定，不随 AI 生成逐次漂移。
      // AI 生成的 last_disclaimer 字段弃用（不再展示），静态常量 DISCLAIMER_FALLBACK 为唯一来源
      disclaimer: DISCLAIMER_FALLBACK,
      // 全链路审计 UC4：无保单时走空状态（buildReportView 对空 policies 产生零值+红色告警，需引导而非报错）
      hasPolicy: !!(c.policies && c.policies.length > 0),
      // 对话空态预埋问题（"您可能想问"）：基于本次缺口引擎数据生成
      presetHints: this._buildPresetQuestions(view, c)
    }, extra || {}))
    // 活报告模型（2026-09）：owner 且数据已变更（stale）→ 自动触发保障分析。
    // 本方法是 OCR/编辑/对话/撤销/进场所有刷新路径的汇聚点，作为自动介入唯一挂载位。
    this._tryAutoAnalysis()
  },

  // 活报告模型（2026-09）：自动介入保障分析（source:'auto'，fire-and-forget）。
  // 后端 30s CAS/节流兜底并发与连点；本地 30s 抑制窗口减少无效请求；客户版/无保单/未 stale 不触发。
  _tryAutoAnalysis() {
    if (this.data.isShared || this._disposed || this._autoTrying) return
    const cid = this.data.familyId
    const f = this.data.family
    if (!cid || !f || !f.insight_stale) return
    if (!f.policies || !f.policies.length) return
    const now = Date.now()
    const last = f.last_analysis_at ? new Date(f.last_analysis_at).getTime() : 0
    // 2026-09-06：节流窗口内命中 → 安排窗口结束后补发一次（stale 自愈，避免"下拉后 tag 永不消失"）
    const waitLast = now - last < 30000 ? (30000 - (now - last)) : 0
    const waitFire = (this._lastAutoFireAt && now - this._lastAutoFireAt < 30000) ? (30000 - (now - this._lastAutoFireAt)) : 0
    const wait = Math.max(waitLast, waitFire)
    if (wait > 0) { this._scheduleAutoRetry(wait); return }
    this._lastAutoFireAt = now
    this._autoTrying = true
    // 2026-09-06 进行中反馈：auto 已发起 → 页头提示切换"自动更新中"，避免用户误以为刷新未生效
    this.setData({ staleTag: '保障分析自动更新中…' })
    api('generateReport', { familyId: cid, source: 'auto' }, { retries: 0 })
      .then((r) => {
        if (r && r.ok && r.data && r.data.portrait && !this._disposed) {
          // 实际生成完成：静默刷新取新分析（stale 复位后 staleTag 自然消失）
          this._refreshReportSequence(cid, { waitMs: 0, applyOpts: {} }).catch(e => { console.error('[report] auto analysis refresh:', (e && e.message) || e); this._restoreStaleTag() })
        } else {
          // throttled/skipped/未实际执行 → 恢复提示文案
          this._restoreStaleTag()
        }
      })
      .catch(() => { this._restoreStaleTag() })
      .then(() => { this._autoTrying = false })
  },

  // 2026-09-06：auto 未执行/失败时恢复 staleTag 提示（数据仍待刷新则回到下拉引导，否则清空）
  _restoreStaleTag() {
    if (this._disposed || this.data.isShared) return
    const f = this.data.family
    const stillStale = f && f.insight_stale && !!this.data.deep
    this.setData({ staleTag: stillStale ? '数据有更新，下拉刷新报告内容' : '' })
  },

  // 2026-09-06：节流窗口结束后补发 auto 尝试（单例 timer，防 stale 悬置；onUnload 清理）
  _scheduleAutoRetry(delay) {
    if (this._disposed || this.data.isShared) return
    if (this._autoRetryTimer) return
    this._autoRetryTimer = setTimeout(() => {
      this._autoRetryTimer = null
      if (this._disposed || this.data.isShared) return
      this._tryAutoAnalysis()
    }, Math.max(1000, delay))
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
    const tok = await ensureShareToken(api, cid)
    if (tok && !this._disposed) this._shareToken = tok
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

  // PDF 导出（正式存档/打印）：reportPdf 生成 → 下载 → openDocument（微信内直接查看/转发）
  async onExportPdf() {
    if (this._disposed || this._exportingPdf) return
    this._exportingPdf = true
    wx.showLoading({ title: '生成 PDF 中...', mask: true })
    try {
      const r = await api('generateReportPdf', { familyId: this.data.familyId }, { timeout: 60000, retries: 0 })
      wx.hideLoading()
      if (!r.ok || !r.data || !r.data.fileID) {
        wx.showToast({ title: r.msg || '生成失败，请重试', icon: 'none' })
        return
      }
      const dl = await wx.cloud.downloadFile({ fileID: r.data.fileID })
      if (!dl || !dl.tempFilePath) throw new Error('下载失败')
      wx.openDocument({
        filePath: dl.tempFilePath,
        fileType: 'pdf',
        showMenu: true,
        fail: function() { wx.showToast({ title: '打开失败，请重试', icon: 'none' }) }
      })
    } catch (e) {
      console.error('[report] PDF 导出失败:', e)
      wx.hideLoading()
      wx.showToast({ title: '导出失败，请重试', icon: 'none' })
    } finally {
      this._exportingPdf = false
    }
  },

  // 分享标题/路径/封面元数据：纯逻辑已抽离至 utils/report-share.js（可单测），此处仅转发
  onShareAppMessage() {
    const c = this.data.family || {}
    const token = this._clientToken || this._shareToken || ''
    const path = buildSharePath(token, this.data.familyId)
    const title = buildShareTitle(c.name, (this.data.reportMeta && this.data.reportMeta.dateTime) || '')
    return { title: title, path: path, imageUrl: '' }
  },
  // 页面级下拉生命周期：主体 scroll-view 已改用 refresher（onScrollRefresh）；此为兜底转发（页面滚动形态预留）
  onPullDownRefresh() { this.onScrollRefresh() },
  // 弹窗锁屏兜底：ocr-flow（识别结果/编辑 sheet）或页面自身 sheet 任一打开时，下拉刷新空转。
  // 真机上页面原生下拉手势可能绕过 JS catchtouchmove，此处拦截是第二道防线（配合各遮罩 catchtouchmove）。
  // catchtouchmove 拦截（member/policy sheet 遮罩拖动不穿透到页面 scroll-view）
  onNoop() {},
  onScrollRefresh() {
    const ocr = this.selectComponent('#ocrFlow')
    // UI 审计 F-M1：chat-panel 展开时同样拦截（否则刷新 loading 盖在对话面板上方）
    const panel = this.selectComponent('#chatpanel')
    const overlayOpen = !!(
      (ocr && (ocr.data.ocrMask.visible || ocr.data.ocrSheet.visible)) ||
      this.data.showEdit || this.data.showMemberManage ||
      // 全项目审计 G-2：深度分析弹层打开时同样拦截下拉刷新（避免刷新 loading 盖在 analysis 弹层上）
      this.data.analysisShow
    )
    if (overlayOpen || (panel && !panel.data.collapsed)) { this.setData({ pullDownTriggered: false }); return }
    if (this.data.isShared) {
      // 客户版下拉 → 重拉分享数据（scroll refresher 结束动画）
      const p = this._loadSharedReport(this._clientToken)
      if (p && p.then) { p.then(() => this.setData({ pullDownTriggered: false })).catch(() => this.setData({ pullDownTriggered: false })) }
      else this.setData({ pullDownTriggered: false })
      return
    }
    // 手动下拉刷新节流 60s（2026-09-06）：防频繁下拉；OCR/对话/auto 自动刷新经 onRefreshReport 路径不受此限
    const now = Date.now()
    if (this._lastManualPullAt && now - this._lastManualPullAt < 60000) {
      this.setData({ pullDownTriggered: false })
      wx.showToast({ title: '刷新太频繁，请 60 秒后再试', icon: 'none' })
      return
    }
    this._lastManualPullAt = now
    this.setData({ pullDownTriggered: true })
    if (this._refreshingReport) { this.setData({ pullDownTriggered: false }); return }
    // silent：refresher 原生转圈即刷新提示，不再叠全屏 mask loading
    // 2026-09-10：下拉刷新同时刷新保障分析（refreshAnalysis）——下拉是用户的**显式刷新意图**，
    // 不能只看 insight_stale：数据未变（如仅 prompt/代码更新）时 stale 为 false，
    // 原实现既无 auto 触发、又因已有报告不显示"立即生成分析"按钮 → 用户无从刷新已有分析内容
    this.onRefreshReport({ silent: true, refreshAnalysis: true })
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
  async onRefreshReport(opts) {
    opts = opts || {}
    if (this._refreshingReport) return
    this._refreshingReport = true
    const cid = this.data.familyId
    if (!cid) { wx.stopPullDownRefresh(); this._refreshingReport = false; this.setData({ pullDownTriggered: false }); return }
    this.setData({ refreshing: true })
    // 2026-09-06：下拉（refresher）场景 silent——不弹全屏 mask loading（refresher 原生转圈即提示），避免双层 loading 盖屏
    const silent = !!opts.silent
    if (!silent) wx.showLoading({ title: '正在刷新报告...', mask: true })
    try {
      const ok = await this._refreshReportSequence(cid, { applyOpts: {} })
      if (!silent) wx.hideLoading()
      wx.stopPullDownRefresh()
      if (ok) {
        // 2026-09-10：下拉刷新显式触发保障分析刷新。复用 onDeepAnalysis 完整链路——
        // 本地 readiness 校验 → 弹层/controller 状态机 → 服务端 30s CAS 节流（命中则提示"已是最新分析"）。
        // 仅下拉路径传入 refreshAnalysis，OCR/对话等自动刷新路径不受影响（它们可能已触发 auto，避免双份调用）
        //
        // 2026-09-11：下拉会触发分析时**不再先弹"报告已更新"**——该文案表达"流程已结束"，
        // 紧接着弹出"AI 深度分析中"会让用户以为已完成又重新开始（两个反馈语义互斥）。
        // 分析流程自带反馈：成功→"分析完成"、节流→"已是最新分析"、门禁→readiness 补全弹层。
        // 仅当本次不触发分析（无保单/分享模式/非下拉来源）时才用"报告已更新"兜底。
        const willAnalyze = !!(opts.refreshAnalysis && !this._disposed && !this.data.isShared &&
          this.data.family && this.data.family.policies && this.data.family.policies.length)
        if (willAnalyze) this.onDeepAnalysis()
        else wx.showToast({ title: '报告已更新', icon: 'success' })
      } else {
        wx.showToast({ title: '刷新失败', icon: 'none' })
      }
    } catch (e) {
      console.error(e)
      if (!silent) wx.hideLoading()
      wx.stopPullDownRefresh()
      wx.showToast({ title: '更新失败，请重试', icon: 'none' })
    } finally {
      if (!this._disposed) this.setData({ refreshing: false, pullDownTriggered: false })
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
        await savePolicyData({ familyId: this.data.familyId, policyId: r.updatePolicy.policyId, data: r.updatePolicy.data })
        // 本地增量更新：merge 到本地 policies → 立即重算 6 章
        const localFamily = this._applyLocalUpdate(r)
        if (localFamily) this._applyReportData(localFamily, null, {})
      } else {
        const updateData = buildUpdateData(mode, vals, this.data.family, this.data._editMemberIdx)
        await saveFamilyPatch({ familyId: this.data.familyId, updateData })
        // 本地增量更新：立即应用 + 重算渲染（消除 500ms 缓冲 + 网络往返的感知延迟）
        const localFamily = this._applyLocalUpdate(updateData)
        if (localFamily) this._applyReportData(localFamily, null, {})
      }
      // UI 审计 F-M3：编辑已持久化 → 清首页 60s 缓存，返回首页不再显示过期成员数/完整度
      try { wx.removeStorageSync(HOME_CACHE_KEY) } catch (e) {}
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
    // 弹层叠加审计：与 onMemberManageEdit/onMemberManageAdd 互斥模式对齐——打开 sheet 同时清底层 member sheet
    this._openEditSheet(buildEditConfig({ mode: 'policy', family: this.data.family, member: p }), 'view')
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
            // 用户决策（2026-08-30）：改失效/退保/理赔终止必须填写失效日期
            wx.showModal({
              title: '确认变更状态？',
              content: '该保单将标记为「' + label + '」，不再计入保障汇总/缴费月历。请填写失效日期（YYYY-MM-DD）：',
              editable: true,
              placeholderText: '如 2026-08-30',
              confirmText: '确认变更',
              cancelText: '取消',
              success: (r) => {
                if (!r.confirm) return
                const d = (r.content || '').trim()
                if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { wx.showToast({ title: '失效日期格式 YYYY-MM-DD', icon: 'none' }); return }
                this._changePolicyStatus(p, status, d)
              }
            })
          } else {
            this._changePolicyStatus(p, status)
          }
        }
      })
    },

    async _changePolicyStatus(p, status, effectiveDate) {
      if (this._changingStatus) return
      this._changingStatus = true
      try {
        const q = await api('changePolicyStatus', {
          familyId: this.data.familyId,
          policyId: p.id || p._id,
          status,
          effectiveDate
        })
        if (!q.ok) throw new Error(q.msg || '状态变更失败')
        // 本地立即更新
        const localFamily = this._applyLocalUpdate({ updatePolicy: { policyId: p.id || p._id, data: { status } } })
        if (localFamily) this._applyReportData(localFamily, null, {})
        try { wx.removeStorageSync(HOME_CACHE_KEY) } catch (err) {}
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
