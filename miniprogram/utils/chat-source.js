/**
 * chat-source.js — 聊天 AI 双 adapter 接缝
 *
 * 解决问题：chat-panel/index.js 的 _streamChat 和 _fallbackGenerate 是两个 adapter
 * 满足同一接缝 (Promise<string>)，但 retry / PII / throttle / timeout 全混在组件里。
 * 架构审计 C：两个 adapter = 真接缝，应抽深模块。
 *
 * 设计：工厂函数 + 注入组件实例引用（component）
 *   - send(opts) → Promise<string>  // 自动选 stream/fallback
 *   - opts: { sp, streamHist, genHist, userText, ms2, lastIdx }
 *   - stream/sp/fallback 内部复用 PII 脱敏 + retry + 节流逻辑
 *
 * component 需提供：
 *   - data.familyId / _sessionId / _timers
 *   - setData / scrollToBottom
 */
const { desensitize } = require('./pii-rules')
const { cleanMarkers } = require('./markers')
const { _toFullwidth: _fullWidthPunct } = require('./md-inline')
const api = require('./apiClient')
const errorHandler = require('./errorHandler')

function createChatSource(component) {
  // 降级 adapter：走 conversationAI generateText 模式（不写消息，不执行工具）
  async function fallback(sp, hist, text) {
    try {
      const r = await api('conversationAI', {
        mode: 'generateText',
        familyId: component.data.familyId,
        systemPrompt: sp,
        messages: hist,
        text: text,
        sessionId: component._sessionId
      })
      if (r.result && r.result.code === 200 && r.result.data) {
        return r.result.data.content || ''
      }
      return errorHandler.getErrorInfo({
        code: (r.result && r.result.code) || 500,
        msg: (r.result && r.result.msg) || '生成失败'
      }).tip + '，请重试。'
    } catch (e) {
      console.error('[chat-source] generateText 失败:', e)
      return errorHandler.getErrorInfo(e).tip + '，请重试。'
    }
  }

  // 流式 adapter：前端直连混元；429 自动重试（最多 2 次）；其他失败降级
  function stream(sp, streamHist, ms2, lastIdx, userText, genHist, retryCount) {
    if (retryCount === undefined) retryCount = 0

    // P0 安全防护：对 system prompt 和历史消息做 PII 脱敏
    const safeSp = desensitize(sp)
    const safeHist = streamHist.map(m => ({ role: m.role, content: desensitize(m.content) }))

    return new Promise((resolve, reject) => {
      let fullText = ''
      let firstChunk = true
      let timedOut = false
      let _lastFlush = 0
      let _pendingFlush = null
      const _doFlush = () => {
        component.scrollToBottom()
        _pendingFlush = null
      }
      const model = wx.cloud.extend.AI.createModel('cloudbase') // 成长计划免费资源包（hy3）
      // 30 秒无首字判定超时，触发重试
      const timeoutTimer = setTimeout(() => {
        if (firstChunk) { timedOut = true; console.warn('[chat-source] streamText 首字超时') }
      }, 30000)
      component._timers.push(timeoutTimer)
      model.streamText({
        data: { model: 'hy3', messages: [{ role: 'system', content: safeSp }, ...safeHist] },
        onText: c => {
          if (timedOut) { timedOut = false; clearTimeout(timeoutTimer) }
          if (firstChunk) {
            firstChunk = false; clearTimeout(timeoutTimer)
            component.setData({ thinking: false })
          }
          fullText += c
          const displayText = cleanMarkers(fullText, { partial: true })
          // 节流：每 100ms 最多更新一次 UI
          const now = Date.now()
          if (now - _lastFlush >= 100) {
            _lastFlush = now
            component.setData({ ['messages[' + lastIdx + '].content']: _fullWidthPunct(displayText) })
            _doFlush()
          } else if (!_pendingFlush) {
            _pendingFlush = setTimeout(() => {
              _lastFlush = Date.now()
              component.setData({ ['messages[' + lastIdx + '].content']: _fullWidthPunct(displayText) })
              _doFlush()
            }, 100 - (now - _lastFlush))
            component._timers.push(_pendingFlush)
          }
        },
        onFinish: () => {
          clearTimeout(timeoutTimer)
          if (firstChunk) component.setData({ thinking: false })
          resolve(fullText)
        },
        onError: (err) => {
          clearTimeout(timeoutTimer)
          if (firstChunk) component.setData({ thinking: false })
          const errMsg = (err && (err.errMsg || err.message || '')) || ''
          const is429 = errMsg.includes('429') || errMsg.includes('Too Many Requests')
          const isTimeout = errMsg.includes('timeout') || errMsg.includes('time out')
          // 429 或超时：最多重试 2 次，指数退避（1s → 2s）
          if ((is429 || isTimeout) && retryCount < 2) {
            const delay = (retryCount + 1) * 1000
            console.warn('[chat-source] streamText 429/超时，' + delay + 'ms 后重试 (第' + (retryCount + 1) + '次)')
            component._timers.push(setTimeout(() => {
              stream(sp, streamHist, ms2, lastIdx, userText, genHist, retryCount + 1)
                .then(resolve).catch(reject)
            }, delay))
            return
          }
          console.error('[chat-source] streamText 失败，降级:', err)
          // 流式失败，走 generateText 降级（用 genHist 避免用户消息重复）
          fallback(sp, genHist, userText).then(resolve).catch(reject)
        }
      })
    })
  }

  // 主入口：按 wx.cloud.extend.AI 可用性自动选 adapter
  async function send(opts) {
    const { sp, streamHist, genHist, userText, ms2, lastIdx } = opts
    if (wx.cloud.extend && wx.cloud.extend.AI) {
      return stream(sp, streamHist, ms2, lastIdx, userText, genHist)
    }
    return fallback(sp, genHist, userText)
  }

  return { send, stream, fallback }
}

module.exports = { createChatSource }
