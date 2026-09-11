const api = require('../../utils/apiClient')
const errorHandler = require('../../utils/errorHandler')
// P0 安全防护：复用 _shared/pii-rules.js（由 sync-shared.js CONTRACT_FILES 同步到 utils/）
const { sanitize, desensitize } = require('../../utils/pii-rules')
// 注入检测：与后端 guard 共用同一规则源
const { detectInjection } = require('../../utils/injection-guard')
// 全角标点转换：复用 md-inline 公共引擎，与 report-markdown/markdown-render 行为一致
const { _toFullwidth: _fullWidthPunct } = require('../../utils/md-inline')
// AI 输出标记清理（兜底）：复用 markers.js 单一事实源
const { cleanMarkers } = require('../../utils/markers')
// 历史分页加载 + TTL 缓存；fmtTime/fmtCountdown 为公共格式化（C2 2026-08-30 审计）
const { createHistoryStore, fmtTime, fmtCountdown } = require('../../utils/history-store')

/**
 * AI 对话面板 — FAB 吸底（单通道 v10）
 * 架构变化（2026-08-29）：
 *  - 放弃流式 + 双通道：不再 streamText/{TOOL_INTENT} 标识，前端一次调用 conversationAI mode:'chat'
 *  - 后端原生 function calling 一步到位；写入成员/财务/保单类工具返回确认卡（pendingConfirms），
 *    代理人确认后二次调用走 CONFIRM 拦截执行；facts 写入无需确认
 *  - 删除：chat-source（流式 adapter）、prompt-cache（getPrompt 已下线）、onStopGenerate/streaming
 */
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    familyId: { type: String, value: '' },
    // 空态预埋问题：父页面从缺口引擎生成"您可能想问"；空数组时回退默认 emptyHints
    presetHints: { type: Array, value: [] }
  },
  data: { collapsed: true, inputText: '', messages: [], thinking: false, bProcessing: false, scrollIntoView: '', refreshingMore: false, emptyHints: ['查看当前家庭的保障情况', '记录家庭成员信息', '分析保障缺口'] },
  observers: {
    // AI 处理期间上抛处理态：父级 FAB 发送按钮联动置灰（逻辑守卫已在 onSend，此处补视觉）
    'thinking, bProcessing'(t, b) { this.triggerEvent('busy', { busy: !!(t || b) }) },
    'familyId'(id) {
      if (!id) return
      this._historyStore.reset()
      this._sessionId = 's_' + Date.now().toString(36)
      this.setData({ messages: [], scrollIntoView: '', bProcessing: false, thinking: false })
      if (!this.data.collapsed) {
        wx.nextTick(() => { this._loadHistory().then(() => this._scrollAfterRender()) })
      }
    }
  },
  lifetimes: {
    created() {
      this._historyStore = createHistoryStore()
    },
    attached() {
      this._timers = []
      this._sessionId = 's_' + Date.now().toString(36)
      this._lastReportRefresh = 0
      this._postProcessing = false
      // P2-4：组件被页面 wx:if 重挂时 _disposed 残留 true 会静默吞掉所有消息，必须重置
      this._disposed = false
      // 撤销倒计时：组件存活期间每秒递减 undoOps.ttl
      this._startUndoTimer()
    },
    detached() {
      this._disposed = true
      this._timers.forEach(t => clearTimeout(t))
      this._timers = []
      if (this._undoTimer) { clearInterval(this._undoTimer); this._undoTimer = null }
    }
  },
  methods: {
    // 时间格式化：公共实现 history-store.fmtTime（C2 2026-08-30 审计，消除两处重复）
    onNoop() {},
    // 空态引导点击 → 直接作为预设问题发送
    onEmptyHintTap(e) {
      const q = e.currentTarget.dataset.q || ''
      if (!q || this._postProcessing) return
      this.askPreset(q)
    },
    onLinkTap(e) {
      const href = e.detail && e.detail.href
      if (!href) return
      wx.setClipboardData({ data: href, success: function() { wx.showToast({ title: '链接已复制', icon: 'none' }) } })
    },
    // 滚动到底部：scroll-into-view 锚点，配合 IntersectionObserver 兜底解决 markdown 异步高度
    scrollToBottom() {
      if (this._disposed) return
      this.setData({ scrollIntoView: '' })
      this._timers.push(setTimeout(() => { if (this._disposed) return; this.setData({ scrollIntoView: 'msg-bottom-anchor' }) }, 20))
    },
    _scrollAfterRender() {
      if (this._disposed) return
      this.scrollToBottom()
      this._timers.push(setTimeout(() => { if (!this._disposed) this.scrollToBottom() }, 300))
      this._timers.push(setTimeout(() => { if (!this._disposed) this.scrollToBottom() }, 800))
    },

    async _loadHistory(mode) {
      const anchorId = (mode === 'more' && this.data.messages[0] && this.data.messages[0]._scrollId) || ''
      const r = await this._historyStore.load(this.data.familyId, mode)
      if (this._disposed || !r) return 0
      if (r.error) return -1
      if (r.replace) {
        this.setData({ messages: r.replace })
        this._scrollAfterRender()
      } else if (r.prepend) {
        this.setData({ messages: [...r.prepend, ...this.data.messages] })
        if (anchorId) {
          this.setData({ scrollIntoView: '' })
          this._timers.push(setTimeout(() => {
            if (this._disposed) return
            this.setData({ scrollIntoView: anchorId })
          }, 50))
        }
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
    // UI 审计 交互 M3：收起时清空输入（PII 残留 + 下次展开显示旧输入），并通知父级清 FAB 栏
    onCollapse() { this._historyStore.reset(); this.setData({ collapsed: true, inputText: '', bProcessing: false, thinking: false }); this.triggerEvent('collapse') },
    // 供父页面调用：若面板展开则收起并返回 true，否则返回 false
    // B2（2026-08-30 审计）：与 onCollapse 行为一致——reset historyStore，下次展开重新拉取
    tryCollapse() {
      if (!this.data.collapsed) { this._historyStore.reset(); this.setData({ collapsed: true, inputText: '' }); this.triggerEvent('collapse'); return true }
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

    /**
     * 单通道核心调用：conversationAI mode:'chat'
     * userText: 实际发送文本（普通消息原文 / 确认动作 {CONFIRM:xx}/{KEEP:xx}）
     * lastIdx: 该轮 assistant 占位消息索引
     * P1-1（2026-08-30 审计）：不再传 history——后端以 messages 集合为单真相源（getFamilyHistory），
     * 前端截断历史会误导维护者且浪费带宽
     */
    async _postChat({ userText, lastIdx }) {
      if (this._postProcessing) return
      this._postProcessing = true
      this.setData({ thinking: true, bProcessing: true })
      try {
        const r = await api('conversationAI', {
          mode: 'chat',
          familyId: this.data.familyId,
          userText,
          sessionId: this._sessionId
        }, { timeout: 60000, retries: 0 })
        if (this._disposed) return
        if (r.ok && r.data) {
          const d = r.data
          const patch = {}
          // 最终回复（无条件覆盖占位；确认卡动作返回的确认语也走这里）
          if (d.cleanText && d.cleanText.trim()) {
            patch['messages[' + lastIdx + '].content'] = _fullWidthPunct(d.cleanText)
            patch['messages[' + lastIdx + '].time'] = fmtTime(new Date())
          } else if (!d.pending_confirms || !d.pending_confirms.length) {
            // P2-A 修复：后端异常吞错返回空 cleanText → 补错误态而非空气泡
            patch['messages[' + lastIdx + '].content'] = '小秘处理出错了，请重试'
            patch['messages[' + lastIdx + '].isError'] = true
            patch['messages[' + lastIdx + '].retryText'] = userText
            patch['messages[' + lastIdx + '].time'] = fmtTime(new Date())
          }
          // 确认卡（写入成员/财务/保单类工具待代理人确认）
          if (d.pending_confirms && d.pending_confirms.length > 0) {
            patch['messages[' + lastIdx + '].pendingConfirms'] = d.pending_confirms
          }
          // 默认执行+撤销（②）：执行结果带 undo 信息 → 渲染撤销按钮（含倒计时）
          if (d.toolResults && d.toolResults.some(tr => tr.undo && tr.undo.opId)) {
            patch['messages[' + lastIdx + '].undoOps'] = d.toolResults
              .filter(tr => tr.undo && tr.undo.opId)
              .map(tr => {
                const ttl = tr.undo.ttlSec || 300
                return { opId: tr.undo.opId, summary: tr.undo.summary || '操作已执行', undoing: false, ttl, ttlText: fmtCountdown(ttl) }
              })
          }
          this.setData(patch)
          // 工具执行结果 → 报告刷新联动
          if (d.toolResults && d.toolResults.length > 0) {
            const hasWrite = d.toolResults.some(tr =>
              ['upsertMember', 'updateFinances', 'addPolicy', 'addFact', 'updatePolicy'].includes(tr.tool) && tr.success
            )
            const hasReportRefresh = d.toolResults.some(tr =>
              tr.tool === 'triggerAnalysis' && tr.success
            )
            if (hasWrite || hasReportRefresh) {
              this._debouncedReportRefresh()
            }
          }
        } else {
          // 业务失败（后端返回非 200）
          const info = errorHandler.getErrorInfo({ code: r.code || 500, msg: r.msg || '处理失败' })
          // P2-B 修复：优先展示后端可读 msg（如"该确认操作已失效"），替代泛化 tip
          // P2 修复：确认卡指令业务失败不设重试——重试拦截指令无意义
          const isCardAction = /^\{CONFIRM:|^\{KEEP:/.test(userText)
          const failText = (info.detail || info.tip) + (isCardAction ? '' : '（可点击重试）')
          const failPatch = {
            ['messages[' + lastIdx + '].content']: failText,
            ['messages[' + lastIdx + '].isError']: true
          }
          if (!isCardAction) failPatch['messages[' + lastIdx + '].retryText'] = userText
          this.setData(failPatch)
        }
      } catch (e) {
        console.error('[chat-panel] 对话失败:', e)
        if (this._disposed) return
        const info = errorHandler.getErrorInfo(e)
        this.setData({
          ['messages[' + lastIdx + '].content']: info.tip + '（可点击重试）',
          ['messages[' + lastIdx + '].isError']: true,
          ['messages[' + lastIdx + '].retryText']: userText
        })
        // 仅网络/服务硬失败才前端兜底补写（前端 60s 超时 ≠ 后端失败，后端可能最终落库，补写会双份）
        const isTimeout = String((e && e.message) || '').indexOf('超时') !== -1
        if (!isTimeout) {
          if (userText && !/^\{CONFIRM:|^\{KEEP:/.test(userText)) this._saveMsg('user', userText)
          this._saveMsg('assistant', cleanMarkers('抱歉，小秘遇到了一点问题，请重试。'))
        }
      } finally {
        this._postProcessing = false
        if (!this._disposed) this.setData({ thinking: false, bProcessing: false })
      }
    },

    // 发送按钮：返回 boolean（守卫拦截/注入拦截/页面销毁返回 false，供 FAB 决定是否清空输入框）
    async onSend() {
      var text = this.data.inputText.trim()
      if (!text || this.data.thinking || this._postProcessing) return false
      // P0 安全防护：sanitize → desensitize → detectInjection 三步
      text = desensitize(sanitize(text))
      const inj = detectInjection(text)
      if (inj.injected) {
        this.setData({ inputText: '' })
        wx.showToast({ title: '内容包含敏感指令，已拦截', icon: 'none', mask: true })
        return false
      }
      const now = new Date(), nowStr = fmtTime(now)
      // 不在此处 _saveMsg('user')，由 chat 模式统一写，避免双写
      // 性能审计：user + assistant 占位一次 setData（原两次全列表深拷贝 + 双序列化），回复更新走索引 patch
      const ms2 = [...this.data.messages, { role: 'user', content: text, time: nowStr }, { role: 'assistant', content: '', time: '' }]
      const lastIdx = ms2.length - 1
      this.setData({ inputText: '', messages: ms2 })
      this.scrollToBottom()
      this._postChat({ userText: text, lastIdx })
      return true
    },

    // ======================== 确认卡（写入成员/财务/保单类工具） ========================
    onCardConfirm(e) {
      const idx = e.currentTarget.dataset.idx
      const cIdx = e.currentTarget.dataset.cidx
      const msg = this.data.messages[idx]
      const pc = msg && msg.pendingConfirms && msg.pendingConfirms[cIdx]
      if (!pc || this._postProcessing || this.data.thinking) return
      this._sendCardAction(pc.pendingId, 'confirm', idx)
    },
    onCardCancel(e) {
      const idx = e.currentTarget.dataset.idx
      const cIdx = e.currentTarget.dataset.cidx
      const msg = this.data.messages[idx]
      const pc = msg && msg.pendingConfirms && msg.pendingConfirms[cIdx]
      if (!pc || this._postProcessing || this.data.thinking) return
      this._sendCardAction(pc.pendingId, 'keep', idx)
    },
    // 确认/取消 → 发送 {CONFIRM}/{KEEP} 拦截指令（后端直接执行，不走 AI），并发起新的 assistant 占位
    _sendCardAction(pendingId, action, srcIdx) {
      const sendText = action === 'keep' ? ('{KEEP:' + pendingId + '}') : ('{CONFIRM:' + pendingId + '}')
      const displayText = action === 'keep' ? '取消' : '确认'
      const now = new Date(), nowStr = fmtTime(now)
      // P2 修复：立即清除原确认卡，防止过期卡片重复点击
      const msgs = this.data.messages.slice()
      if (msgs[srcIdx]) msgs[srcIdx] = { ...msgs[srcIdx], pendingConfirms: [] }
      const ms = [...msgs, { role: 'user', content: displayText, time: nowStr }]
      const ms2 = [...ms, { role: 'assistant', content: '', time: '' }]
      const lastIdx = ms2.length - 1
      this.setData({ messages: ms2 })
      this.scrollToBottom()
      this._postChat({ userText: sendText, lastIdx })
    },

    // ======================== 默认执行+撤销（② 2026-08-30） ========================
    // 倒计时格式化：公共实现 history-store.fmtCountdown（C2 2026-08-30 审计）
    // 每秒递减 undoOps.ttl（仅更新有变化的消息），到 0 后前端隐藏撤销按钮（后端同样校验过期）
    _startUndoTimer() {
      if (this._undoTimer) return
      this._undoTimer = setInterval(() => {
        if (this._disposed) { clearInterval(this._undoTimer); this._undoTimer = null; return }
        const msgs = this.data.messages
        const patch = {}
        let changed = false
        msgs.forEach((m, i) => {
          if (m && m.undoOps && m.undoOps.length) {
            let dirty = false
            const list = m.undoOps.map(op => {
              if (op.undoing || op.ttl <= 0) return op
              dirty = true
              const ttl = op.ttl - 1
              return { ...op, ttl, ttlText: fmtCountdown(ttl) }
            })
            if (dirty) { patch['messages[' + i + '].undoOps'] = list; changed = true }
          }
        })
        if (changed) this.setData(patch)
      }, 1000)
    },
    onUndo(e) {
      const idx = e.currentTarget.dataset.idx
      const uIdx = e.currentTarget.dataset.uidx
      const msg = this.data.messages[idx]
      const op = msg && msg.undoOps && msg.undoOps[uIdx]
      if (!op || op.undoing || this._postProcessing || this.data.thinking) return
      this._sendUndo(op.opId, idx, uIdx)
    },
    // 撤销 → 发送 {UNDO:op_id} 拦截指令（后端直接恢复，不走 AI），并发起新的 assistant 占位
    _sendUndo(opId, srcIdx, uIdx) {
      const sendText = '{UNDO:' + opId + '}'
      const now = new Date(), nowStr = fmtTime(now)
      // 立即标记该 op 为"撤销中"，按钮置灰防重复点击
      const msgs = this.data.messages.slice()
      if (msgs[srcIdx] && msgs[srcIdx].undoOps) {
        const list = msgs[srcIdx].undoOps.slice()
        list[uIdx] = { ...list[uIdx], undoing: true }
        msgs[srcIdx] = { ...msgs[srcIdx], undoOps: list }
      }
      const ms = [...msgs, { role: 'user', content: '撤销', time: nowStr }]
      const ms2 = [...ms, { role: 'assistant', content: '', time: '' }]
      const lastIdx = ms2.length - 1
      this.setData({ messages: ms2 })
      this.scrollToBottom()
      this._postChat({ userText: sendText, lastIdx })
    },

    // 错误消息重试：用原用户文本重新发送
    onRetrySend(e) {
      if (this._postProcessing || this.data.thinking) return
      const idx = e.currentTarget.dataset.idx
      const msgs = this.data.messages
      if (idx < 0 || idx >= msgs.length) return
      const retryText = msgs[idx].retryText
      if (!retryText) return
      // 同时移除错误消息及其前一条 user 消息，防重试后两条相同 user 消息污染上下文
      let removeFrom = idx
      if (idx > 0 && msgs[idx - 1] && msgs[idx - 1].role === 'user') removeFrom = idx - 1
      const newMsgs = msgs.slice(0, removeFrom).concat(msgs.slice(idx + 1))
      this.setData({ messages: newMsgs, inputText: retryText })
      wx.nextTick(() => this.onSend())
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
      if (count === -1) wx.showToast({ title: '加载失败，请稍后重试', icon: 'none', duration: 1500 })
      else if (count === 0) wx.showToast({ title: '没有更多了', icon: 'none', duration: 1000 })
    },
    _saveMsg(role, content) {
      if (!this.data.familyId) return
      api('writeMessage', { familyId: this.data.familyId, role, content: content.substring(0, 4000) }).catch(() => {})
    },

  }
})
