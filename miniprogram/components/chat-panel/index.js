const api = require('../../utils/apiClient')
const errorHandler = require('../../utils/errorHandler')
// P0 安全防护：复用 _shared/pii-rules.js（由 sync-shared.js CONTRACT_FILES 同步到 utils/）
const { sanitize, desensitize } = require('../../utils/pii-rules')
// 注入检测（R3v2 #1）：与后端 guard 共用同一规则源
const { detectInjection } = require('../../utils/injection-guard')
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
  data: { collapsed: true, inputText: '', messages: [], thinking: false, scrollIntoView: '', refreshingMore: false, bProcessing: false, emptyHints: ['查看当前家庭的保障情况', '记录家庭成员信息', '分析保障缺口'] },
  // 审计：原文件存在两个 observers 键（对象字面量后者覆盖前者），'thinking, bProcessing' 监听实际失效，合并修复
  observers: {
    // AI 回复期间上抛处理态：父级 FAB 发送按钮联动置灰（逻辑守卫已在 onSend，此处补视觉）
    'thinking, bProcessing'(t, b) { this.triggerEvent('busy', { busy: !!(t || b) }) },
    'familyId'(id) {
      if (!id) return
      this._historyStore.reset()
      this._promptCache.invalidate()
      this._sessionId = 's_' + Date.now().toString(36)
      // 审计 P0-2：中止旧 family 的在途流式（chat-source sessionId 检查 + _streamAborted 双保险）
      this._streamSession = null
      this._streamAborted = true
      this.setData({ messages: [], scrollIntoView: '', bProcessing: false, thinking: false, streaming: false })
      if (!this.data.collapsed) {
        wx.nextTick(() => { this._loadHistory().then(() => this._scrollAfterRender()) })
      }
    }
  },
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
      // P2-4：组件被页面 wx:if 重挂时 _disposed 残留 true 会静默吞掉所有消息，必须重置
      this._disposed = false
    },
    detached() { this._disposed = true; this._streamSession = null; this._timers.forEach(t => clearTimeout(t)); this._timers = [] }
  },
  methods: {
    // 时间格式：当天 → 刚刚/X分钟前/HH:mm；跨天 → 昨天/M月D日 + HH:mm（区分跨天会话）
    _fmtTime(d) {
      const n = new Date(), mins = Math.floor((n - d) / 60000)
      const pad = v => ('0' + v).slice(-2)
      const hhmm = pad(d.getHours()) + ':' + pad(d.getMinutes())
      if (mins < 1) return '刚刚'
      if (n.toDateString() === d.toDateString()) {
        if (mins < 60) return mins + '分钟前'
        return hhmm
      }
      const y = new Date(n); y.setDate(y.getDate() - 1)
      if (y.toDateString() === d.toDateString()) return '昨天 ' + hhmm
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hhmm
    },
    onNoop() {},
    // 空态引导点击 → 直接作为预设问题发送（与 onHintTap 同链路）
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
      // markdown 异步渲染后延时重试
      this._timers.push(setTimeout(() => { if (!this._disposed) this.scrollToBottom() }, 300))
      this._timers.push(setTimeout(() => { if (!this._disposed) this.scrollToBottom() }, 800))
    },

    async _loadHistory(mode) {
      // 下拉加载更多：记录原顶部消息锚点，加载后定位回该消息（保持阅读位置不跳变）
      const anchorId = (mode === 'more' && this.data.messages[0] && this.data.messages[0]._scrollId) || ''
      const r = await this._historyStore.load(this.data.familyId, mode)
      if (this._disposed || !r) return 0
      if (r.error) return -1
      if (r.replace) {
        this.setData({ messages: r.replace })
        this._scrollAfterRender()
      } else if (r.prepend) {
        this.setData({ messages: [...r.prepend, ...this.data.messages] })
        // 定位回原顶部消息：等 DOM 渲染后用 scroll-into-view 锚定
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
    onCollapse() { this._historyStore.reset(); this.setData({ collapsed: true, inputText: '', bProcessing: false, thinking: false, streaming: false }); this.triggerEvent('collapse') },
    // 供父页面调用：若面板展开则收起并返回 true，否则返回 false
    tryCollapse() {
      if (!this.data.collapsed) { this.setData({ collapsed: true, inputText: '' }); this.triggerEvent('collapse'); return true }
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

    // 返回 boolean：守卫拦截/注入拦截/页面销毁返回 false（供 FAB 决定是否清空输入框，F-S4）
    async onSend() {
      var text = this.data.inputText.trim()
      if (!text || this.data.thinking || this._postProcessing) return false
      // UI 审计 状态 S2：每轮开始重置停止标志
      this._streamAborted = false

      // P0 安全防护：sanitize → desensitize → detectInjection 三步（R3v2 #1 补输入注入检测）
      text = desensitize(sanitize(text))
      const inj = detectInjection(text)
      if (inj.injected) {
        this.setData({ inputText: '' })
        wx.showToast({ title: '内容包含敏感指令，已拦截', icon: 'none', mask: true })
        return false
      }

      const now = new Date(), nowStr = this._fmtTime(now)
      const ms = [...this.data.messages, { role: 'user', content: text, time: nowStr }]
      // 注意：不在此处调 _saveMsg('user', text)，由 postProcess 统一写，避免双写
      this.setData({ inputText: '', messages: ms, thinking: true, streaming: true })
      this.scrollToBottom()
      try {
        // v9 双通道：prompt-cache 返回 { systemPrompt, context, toolDefs }，sp 拼接画像
        const p = await this._promptCache.get(this.data.familyId)
        const sp = p.systemPrompt + (p.context ? '\n\n## 当前客户信息\n' + p.context : '')
        // streamText 用含当前用户消息的 hist；generateText 用不含的，由 text 单独传
        // S2-7 修复：slice(0, -1) 只去掉当前用户消息；原 slice(0, -2) 多去掉了上一轮 AI 回复，
        // 导致 429/超时降级到 generateText 时 AI 看不到自己上一轮回复，多轮对话上下文断裂
        const streamHist = ms.slice(-15).map(m => ({ role: m.role, content: (m.content || '').substring(0, 1500) }))
        // P1-6：genHist 同样截断最后 15 条（原全量在 429/超时降级 generateText 时 token 可能超限）
        const genHist = ms.slice(-15, -1).map(m => ({ role: m.role, content: (m.content || '').substring(0, 1500) }))
        const ms2 = [...ms, { role: 'assistant', content: '', time: '' }]
        this.setData({ messages: ms2 })
        this.scrollToBottom()
        const lastIdx = ms2.length - 1

        // 通道 A：流式输出回复文本 + （可能）工具意图标识；send 返回剥离标识后的 { text, toolIntent, malformed }
        const result = await this._chatSource.send({ sp, streamHist, genHist, userText: text, ms2, lastIdx })
        const fullText = result.text
        const toolIntent = result.toolIntent
        const malformed = !!result.malformed
        if (this._disposed) {
          // 消息链路审计 P0：页面销毁时仍须完成 DB 落库（user+assistant 已生成，不落库则整轮丢失）。
          this._finalizeConversation(text, fullText, ms, ms2, lastIdx, toolIntent, malformed)
          return false
        }
        // 流式完成：有工具意图（含 malformed——识别到疑似意图但标识解析失败）→ A 文本替换为占位；纯问答 → 直接渲染
        const hasTool = malformed || !!(toolIntent && toolIntent.tools && toolIntent.tools.length > 0)
        if (hasTool) {
          // P0修复1: 有工具意图时不保留 A 的流式文本，替换为简短占位
          // 用户预期：看到"正在处理"而非完整回复，B 回流后填充真实结果（无"改写"感）
          this.setData({
            ['messages[' + lastIdx + '].content']: '正在为您处理…',
            thinking: true,
            streaming: false,
            bProcessing: true
          })
        } else {
          this.setData({
            ['messages[' + lastIdx + '].content']: _fullWidthPunct(fullText),
            ['messages[' + lastIdx + '].time']: this._fmtTime(new Date()),
            thinking: false,
            streaming: false,
            bProcessing: false
          })
        }
        // 收尾：有工具意图（含 malformed）→ B 通道 postProcess（工具执行 + 落库）；无 → record（纯问答落库）
        this._finalizeConversation(text, fullText, ms, ms2, lastIdx, toolIntent, malformed)
        return true
      } catch (e) {
        console.error('[chat-panel] onSend 错误:', e)
        if (this._disposed) return false
        const info = errorHandler.getErrorInfo(e)
        // F-S3 修复：流式失败时 this.data.messages 最后一条是空 AI 占位消息（ms2 尾项），
        // 直接替换为错误消息而非追加，避免"空消息+错误消息"双条残留
        const base = this.data.messages
        const last = base[base.length - 1]
        const ms3 = (last && last.role === 'assistant' && !last.content)
          ? base.slice(0, -1).concat([{ role: 'assistant', content: info.tip + '（可点击重试）', isError: true, retryText: text, errorCode: info.code }])
          : base.concat([{ role: 'assistant', content: info.tip + '（可点击重试）', isError: true, retryText: text, errorCode: info.code }])
        this.setData({ messages: ms3, thinking: false, streaming: false, bProcessing: false })
        return false
      }
    },

    // UI 审计 状态 S2：AI 生成中手动停止（chat-source onText 感知后提前 resolve，保留已生成部分）
    onStopGenerate() {
      if (!this.data.streaming && !this.data.thinking) return
      this._streamAborted = true
      wx.showToast({ title: '已停止生成', icon: 'none' })
    },

    // 错误消息重试：用原用户文本重新发送
    onRetrySend(e) {
      // F-S5 修复：record/后处理进行中时禁止重试，避免错误消息被移除后 onSend 被守卫拦截、
      // 用户看到"消息消失但未发出"的静默失败
      if (this._postProcessing || this.data.thinking) return
      const idx = e.currentTarget.dataset.idx
      const msgs = this.data.messages
      if (idx < 0 || idx >= msgs.length) return
      const retryText = msgs[idx].retryText
      if (!retryText) return
      // 审计 P0-1：同时移除错误消息及其前一条 user 消息，防重试后两条相同 user 消息污染上下文
      let removeFrom = idx
      if (idx > 0 && msgs[idx - 1] && msgs[idx - 1].role === 'user') removeFrom = idx - 1
      const newMsgs = msgs.slice(0, removeFrom).concat(msgs.slice(idx + 1))
      this.setData({ messages: newMsgs, inputText: retryText })
      // 重新触发发送
      wx.nextTick(() => this.onSend())
    },

    // v9 双通道收尾：有工具意图 → postProcess（B 通道工具执行 + 落库）；无 → record（纯问答落库）。
    // 二值渲染：postProcess 全部成功 → cleanText=A 原样（前端无变化）；有失败 → 后端失败提示替换 A。
    async _finalizeConversation(userText, aText, ms, ms2, lastIdx, toolIntent, forcePost) {
      if (this._postProcessing) return  // 防重入
      this._postProcessing = true
      try {
        const hasTool = forcePost || !!(toolIntent && toolIntent.tools && toolIntent.tools.length > 0)
        const payload = {
          mode: hasTool ? 'postProcess' : 'record',
          familyId: this.data.familyId,
          userText: userText,
          text: aText,
          sessionId: this._sessionId
        }
        if (hasTool) {
          // B 通道（v9.2）：A 只出工具判定 → 透传 intent（仅 name），B function calling 按 schema 填参数。
          // 不传 A 的 args（A 手写字段名不可控，曾致 liability 等别名入库）；A 的断言文本也不注入 B 决策
          // （v9.0 根因：B 看到"已更新"断言误以为已写入而不调工具）。
          payload.aText = aText
          // P1-6：历史截断最后 15 条（原全量历史在降级 generateText 时 token 可能超限）
          payload.history = ms.slice(-15, -1).map(m => ({ role: m.role, content: (m.content || '').substring(0, 1500) }))
          // malformed（标识解析失败）：不传 intent → orchestrate 走 function calling 兜底，B 自判工具
          if (toolIntent && toolIntent.tools && toolIntent.tools.length > 0) {
            payload.intent = toolIntent.tools.map(t => ({ name: t.name }))
          }
        }
        // 审计 P0：postProcess 链路过长（上下文构建+AI phase1+工具+回流），前端 30s 先超时且 retries=1
        // 会"前端报错→重试→工具重复执行"。显式 60s 超时（对齐后端 SCF）+ 禁重试（与写操作原则一致）
        const r = await api('conversationAI', payload, { timeout: 60000, retries: 0 })
        if (this._disposed) return
        if (r.ok && r.data) {
          const d = r.data
          // v9.6 渲染权威化：B 回流文本无条件覆盖 A（A 仅流式预览的中性理解/过程语）。
          // 消除"改写"（A 断言被 B 换掉）与"悬空"（查询类 A 停在"正在查询"无下文）——
          // 工具执行后 B 的 cleanText 是最终答复（成功=基于真实结果/失败=失败提示），必覆盖。
          // 例外：待确认（delete* 409）→ 后端返回空 cleanText（A 已清空），由确认卡承接交互，不覆盖
          if (d.cleanText && d.cleanText.trim()) {
            this.setData({
              ['messages[' + lastIdx + '].content']: _fullWidthPunct(d.cleanText),
              ['messages[' + lastIdx + '].time']: this._fmtTime(new Date())
            })
          }
          // v9.5 确认卡渲染：delete* 409 待确认 → 后端返回 suggestions/pending_confirms，
          // 挂到该条 assistant 消息上（wxml sug-bar 渲染 + onSugTap 走 CONFIRM 拦截）
          if (d.suggestions && d.suggestions.length > 0) {
            this.setData({ ['messages[' + lastIdx + '].suggestions']: d.suggestions })
          }
          // 工具执行结果 → 报告刷新联动（B 通道在 postProcess 内执行，返回 toolResults）
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
        }
      } catch (e) {
        console.error('[chat-panel] 对话收尾失败:', e)
        // 后端未写入任何消息时的兜底
        if (userText) this._saveMsg('user', userText)
        this._saveMsg('assistant', _stripMarkers(aText))
      } finally {
        this._postProcessing = false
        if (!this._disposed) this.setData({ thinking: false, bProcessing: false })
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
      if (count === -1) wx.showToast({ title: '加载失败，请稍后重试', icon: 'none', duration: 1500 })
      else if (count === 0) wx.showToast({ title: '没有更多了', icon: 'none', duration: 1000 })
    },
    // 快捷建议/确认卡点击 → 直接 postProcess（CONFIRM/KEEP/sug 拦截不经 AI，不消耗流式）
    // 审计修复：补 thinking 守卫——流式回复期间（_postProcessing=false、thinking=true）上轮残留 sug-chip 仍可点，
    // 会导致流式输出与新 postProcess 并发（_finalizeConversation 的 _postProcessing 防重入无法拦截此窗口）
    onSugTap(e) {
      const sug = e.currentTarget.dataset.sug || ''
      if (!sug || this._postProcessing || this.data.thinking) return
      const now = new Date(), nowStr = this._fmtTime(now)
      const ms = [...this.data.messages, { role: 'user', content: sug, time: nowStr }]
      const ms2 = [...ms, { role: 'assistant', content: '', time: '' }]
      const lastIdx = ms2.length - 1
      // 处理中反馈：置 thinking 显示三点，postProcess 完成时复位
      this.setData({ inputText: '', messages: ms2, thinking: true, bProcessing: false })
      this.scrollToBottom()
      this._finalizeConversation(sug, '', ms, ms2, lastIdx, null, true)
    },
    _saveMsg(role, content) {
      if (!this.data.familyId) return
      api('writeMessage', { familyId: this.data.familyId, role, content: content.substring(0, 4000) }).catch(() => {})
    },

  }
})
