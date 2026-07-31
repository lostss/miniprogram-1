const api = require('../../utils/apiClient')
const errorHandler = require('../../utils/errorHandler')
// P0 安全防护：复用 _shared/pii-rules.js（由 sync-shared.js CONTRACT_FILES 同步到 utils/）
const { sanitize, desensitize } = require('../../utils/pii-rules')
// 全角标点转换：复用 md-inline 公共引擎，与 report-markdown/markdown-render 行为一致
const { _toFullwidth: _fullWidthPunct } = require('../../utils/md-inline')
// AI 输出标记清理（兜底 + 流式 partial）：复用 markers.js 单一事实源
const { cleanMarkers } = require('../../utils/markers')
// 架构审计 C：抽 3 个深模块（chat-source / history-store / prompt-cache）
// 接缝显形：stream/generate 是双 adapter，history 分页状态独立，prompt TTL 可测
const { createChatSource } = require('../../utils/chat-source')
const { createHistoryStore } = require('../../utils/history-store')
const { createPromptCache } = require('../../utils/prompt-cache')

// 兜底清理（落库前）：与 cleanMarkers() 默认行为一致
function _stripMarkers(s) { return cleanMarkers(s) }

/** AI 对话面板 — FAB 吸底（三步流程 v5.0） */
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { familyId: { type: String, value: '' } },
  data: { collapsed: true, inputText: '', messages: [], thinking: false, scrollIntoView: '', refreshingMore: false },
  lifetimes: {
    created() {
      // 模块初始化提到 created：observer 在 attached 前触发，此时 _historyStore 必须已存在
      this._chatSource = createChatSource(this)
      this._historyStore = createHistoryStore()
      this._promptCache = createPromptCache()
    },
    attached() {
      this._timers = []
      this._sessionId = 's_' + Date.now().toString(36)
      this._lastReportRefresh = 0
      this._postProcessing = false
    },
    detached() { this._disposed = true; this._streamSession = null; this._timers.forEach(t => clearTimeout(t)); this._timers = [] }
  },
  observers: {
    'familyId'(id) {
      if (!id) return
      this._historyStore.reset()
      this._promptCache.invalidate()
      this._sessionId = 's_' + Date.now().toString(36)
      this.setData({ messages: [], scrollIntoView: '' })
      if (!this.data.collapsed) {
        wx.nextTick(() => { this._loadHistory().then(() => this._scrollAfterRender()) })
      }
    }
  },
  methods: {
    _fmtTime(d) {
      const n = new Date(), diff = n - d, mins = Math.floor(diff / 60000)
      if (mins < 1) return '刚刚'
      if (mins < 60) return mins + '分钟前'
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
    },
    onNoop() {},
    // 滚动到底部：scroll-into-view 锚点，配合 IntersectionObserver 兜底解决 markdown 异步高度
    scrollToBottom() {
      if (this._disposed) return
      this.setData({ scrollIntoView: '' })
      this._timers.push(setTimeout(() => { if (this._disposed) return; this.setData({ scrollIntoView: 'msg-bottom-anchor' }) }, 20))
    },
    _scrollAfterRender() {
      if (this._disposed) return
      this.scrollToBottom()
      // markdown 异步渲染后延时重试
      this._timers.push(setTimeout(() => { if (!this._disposed) this.scrollToBottom() }, 300))
      this._timers.push(setTimeout(() => { if (!this._disposed) this.scrollToBottom() }, 800))
    },

    async _loadHistory(mode) {
      const r = await this._historyStore.load(this.data.familyId, mode)
      if (this._disposed || !r) return 0
      if (r.replace) {
        this.setData({ messages: r.replace })
        this._scrollAfterRender()
      } else if (r.prepend) {
        this.setData({ messages: [...r.prepend, ...this.data.messages] })
      }
      return r.rawCount
    },

    // 展开面板并加载历史（onFabTap / onFocus 共用）
    _expandPanel() {
      if (!this.data.collapsed) return
      this.setData({ collapsed: false })
      wx.nextTick(() => {
        this._loadHistory().then(() => this._scrollAfterRender())
      })
    },
    onFabTap() { this._expandPanel() },
    onFocus() { this._expandPanel() },
    onCollapse() { this._historyStore.reset(); this.setData({ collapsed: true }) },
    // 供父页面调用：若面板展开则收起并返回 true，否则返回 false
    tryCollapse() {
      if (!this.data.collapsed) { this.setData({ collapsed: true }); return true }
      return false
    },
    // 供父页面调用：预设问题展开面板并发送（缺口卡"问小秘"接缝）
    askPreset(question) {
      const q = String(question || '').trim()
      if (!q || this.data.thinking) return
      if (this.data.collapsed) {
        this.setData({ collapsed: false, inputText: q })
        wx.nextTick(() => { this._loadHistory().then(() => { this._scrollAfterRender(); this.onSend() }) })
      } else {
        this.setData({ inputText: q })
        wx.nextTick(() => this.onSend())
      }
    },
    onInput(e) { this.setData({ inputText: e.detail.value }) },

    async onSend() {
      var text = this.data.inputText.trim()
      if (!text || this.data.thinking || this._postProcessing) return

      // P0 安全防护：sanitize → desensitize 用户输入
      text = desensitize(sanitize(text))

      const now = new Date(), nowStr = this._fmtTime(now)
      const ms = [...this.data.messages, { role: 'user', content: text, time: nowStr }]
      // 注意：不在此处调 _saveMsg('user', text)，由 postProcess 统一写，避免双写
      this.setData({ inputText: '', messages: ms, thinking: true })
      this.scrollToBottom()
      try {
        const sp = await this._promptCache.get(this.data.familyId)
        // streamText 用含当前用户消息的 hist；generateText 用不含的，由 text 单独传
        // S2-7 修复：slice(0, -1) 只去掉当前用户消息；原 slice(0, -2) 多去掉了上一轮 AI 回复，
        // 导致 429/超时降级到 generateText 时 AI 看不到自己上一轮回复，多轮对话上下文断裂
        const streamHist = ms.slice(-15).map(m => ({ role: m.role, content: (m.content || '').substring(0, 1500) }))
        const genHist = ms.slice(0, -1).map(m => ({ role: m.role, content: (m.content || '').substring(0, 1500) }))
        const ms2 = [...ms, { role: 'assistant', content: '', time: nowStr }]
        this.setData({ messages: ms2 })
        this.scrollToBottom()
        const lastIdx = ms2.length - 1

        // 委托 chatSource 自动选 stream / fallback adapter
        const fullText = await this._chatSource.send({
          sp, streamHist, genHist, userText: text, ms2, lastIdx
        })
        if (this._disposed) return
        // 流式完成：立即渲染最终文本 + 收起 thinking，sug 异步追加
        this.setData({
          ['messages[' + lastIdx + '].content']: _fullWidthPunct(fullText),
          thinking: false
        })
        // postProcess 异步执行，完成后覆盖文本 + 注入 sug（fire-and-forget）
        this._postProcess(text, fullText, ms2, lastIdx)
      } catch (e) {
        console.error('[chat-panel] onSend 错误:', e)
        if (this._disposed) return
        const info = errorHandler.getErrorInfo(e)
        const ms3 = [...this.data.messages, { role: 'assistant', content: info.tip + '（可点击重试）', isError: true, retryText: text, errorCode: info.code }]
        this.setData({ messages: ms3, thinking: false })
      }
    },

    // 错误消息重试：用原用户文本重新发送
    onRetrySend(e) {
      const idx = e.currentTarget.dataset.idx
      const msgs = this.data.messages
      if (idx < 0 || idx >= msgs.length) return
      const retryText = msgs[idx].retryText
      if (!retryText) return
      // 移除错误消息
      const newMsgs = msgs.slice(0, idx).concat(msgs.slice(idx + 1))
      this.setData({ messages: newMsgs, inputText: retryText })
      // 重新触发发送
      wx.nextTick(() => this.onSend())
    },

    // postProcess：审计 + 工具执行 + sug 注入 + 持久化（fire-and-forget）
    async _postProcess(userText, aiText, ms2, lastIdx) {
      if (this._postProcessing) return  // 防重入
      this._postProcessing = true
      try {
        const r = await api('conversationAI', {
            mode: 'postProcess',
            familyId: this.data.familyId,
            userText: userText,
            text: aiText,
            sessionId: this._sessionId
          })
        if (this._disposed) return
        if (r.ok && r.data) {
          const d = r.data
          // 用后端权威文本替换显示（清理了标记）
          if (d.cleanText && d.cleanText !== aiText) {
            this.setData({ ['messages[' + lastIdx + '].content']: _fullWidthPunct(d.cleanText) })
          }
          // sug 选项（如有）：挂到对应 assistant 消息
          if (d.suggestions && d.suggestions.length > 0) {
            this.setData({ ['messages[' + lastIdx + '].suggestions']: d.suggestions })
          }
          // 工具执行结果反馈
          if (d.toolResults && d.toolResults.length > 0) {
            const hasWrite = d.toolResults.some(tr =>
              ['upsertMember', 'updateFinances', 'addPolicy', 'addFact'].includes(tr.tool) && tr.success
            )
            const hasReportRefresh = d.toolResults.some(tr =>
              tr.tool === 'triggerAnalysis' && tr.success
            )
            if (hasWrite || hasReportRefresh) {
              this._debouncedReportRefresh()
            }
          }
        }
      } catch (e) {
        console.error('[chat-panel] postProcess 失败:', e)
        // 后端未写入任何消息时的兜底
        if (userText) this._saveMsg('user', userText)
        this._saveMsg('assistant', _stripMarkers(aiText))
      } finally {
        this._postProcessing = false
      }
    },

    // 防抖触发报告刷新（记录类工具成功后调用，避免单轮多次刷新）
    _debouncedReportRefresh() {
      const now = Date.now()
      if (this._lastReportRefresh && now - this._lastReportRefresh < 10000) return
      this._lastReportRefresh = now
      this._timers.push(setTimeout(() => this.triggerEvent('reportRefresh', {}), 3000))
    },

    // 下拉刷新更多历史消息
    async onPullRefresh() {
      this.setData({ refreshingMore: true })
      const count = await this._loadHistory('more')
      this.setData({ refreshingMore: false })
      if (count === 0) wx.showToast({ title: '没有更多了', icon: 'none', duration: 1000 })
    },
    // 快捷建议点击 → 跳过流式，直接 postProcess（sug 确认/保留原值/取消等）
    onSugTap(e) {
      const sug = e.currentTarget.dataset.sug || ''
      if (!sug || this._postProcessing) return
      const now = new Date(), nowStr = this._fmtTime(now)
      const ms = [...this.data.messages, { role: 'user', content: sug, time: nowStr }]
      const ms2 = [...ms, { role: 'assistant', content: '', time: nowStr }]
      const lastIdx = ms2.length - 1
      this.setData({ inputText: '', messages: ms2, thinking: false })
      this.scrollToBottom()
      this._postProcess(sug, '', ms2, lastIdx)
    },
    _saveMsg(role, content) {
      if (!this.data.familyId) return
      api('writeMessage', { familyId: this.data.familyId, role, content: content.substring(0, 4000) }).catch(() => {})
    },

  }
})
