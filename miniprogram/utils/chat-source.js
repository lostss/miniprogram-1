/**
 * chat-source.js — 聊天 AI 双 adapter 接缝（v9 双通道：A 流式 + 意图标识）
 *
 * 架构（v9）：
 * - 通道 A（本模块）：前端 streamText 纯流式。模型输出 = 回复文本 + （有工具意图时）独立行 JSON 标识
 *   {TOOL_INTENT:{"tools":[{"name":"工具名","args":{...}}]}}。前端渲染时过滤标识，流式完成剥离解析。
 * - 通道 B（conversationAI postProcess）：工具执行。前端解析到标识后调 postProcess（见 chat-panel）。
 *
 * 设计：工厂函数 + 注入组件实例引用（component）
 *   - send(opts) → Promise<{ text, toolIntent }>
 *   - opts: { sp, streamHist, genHist, userText, ms2, lastIdx }
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

// 工具意图标识：独立一行 {TOOL_INTENT:{"tools":[...]}}；JSON 尽量单行，多行按块吸收（与 prompts.js 协议一致）
const TOOL_INTENT_RE = /^\{TOOL_INTENT:(\{[\s\S]*\})\}\s*$/

// 流式渲染时屏蔽标识块（partial 阶段标识可能未完整；协议规定标识在末尾独立成块，
// 从 {TOOL_INTENT: 起截断屏蔽，防多行 JSON 残片泄漏给用户）
function _maskToolIntent(text) {
  if (!text) return text
  const idx = text.indexOf('{TOOL_INTENT:')
  if (idx === -1) return text
  return text.substring(0, idx)
}

// 计算字符串中未闭合括号数（{ 为 +1，} 为 -1），用于判定标识块是否闭合
function _braceBalance(s) {
  let bal = 0
  for (const ch of String(s)) {
    if (ch === '{') bal++
    else if (ch === '}') bal--
  }
  return bal
}

// 流式完成后剥离标识块并解析 JSON。
// - 单行/多行 JSON 均可：以 {TOOL_INTENT: 开头进入标识块，按括号平衡吸收后续行，整体剥离
// - 解析成功 → toolIntent；失败（畸形/JSON 不合法）→ malformed=true，供前端补偿（走 postProcess function calling 兜底）
// - 以 {TOOL_INTENT: 开头的块一律剥离（含畸形/未闭合），防模型输出泄漏给用户
function _extractToolIntent(fullText) {
  const lines = String(fullText || '').split('\n')
  const kept = []
  let intent = null
  let malformed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\{TOOL_INTENT:/.test(line)) {
      // 吸收标识块：直到括号平衡或空行/末尾（协议规定标识独立成块，其后无正常内容）
      let block = line
      let bal = _braceBalance(line)
      i++
      while (i < lines.length && bal > 0 && lines[i].trim() !== '') {
        block += '\n' + lines[i]
        bal += _braceBalance(lines[i])
        i++
      }
      const m = block.match(TOOL_INTENT_RE)
      if (m) {
        try { intent = JSON.parse(m[1]) } catch (e) { intent = null; malformed = true }
      } else {
        malformed = true // 畸形标识块：剥离 + 标记（补偿路径在 chat-panel）
      }
    } else {
      kept.push(line)
      i++
    }
  }
  return { text: kept.join('\n').trim(), toolIntent: intent, malformed }
}

function createChatSource(component) {
  // 降级 adapter：走 conversationAI generateText 模式（无工具，不写消息；落库由 record 统一）
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
      if (r.ok && r.data) {
        return { text: r.data.content || '', toolIntent: null, malformed: false }
      }
      return {
        text: errorHandler.getErrorInfo({ code: r.code || 500, msg: r.msg || '生成失败' }).tip + '，请重试。',
        toolIntent: null, malformed: false
      }
    } catch (e) {
      console.error('[chat-source] generateText 失败:', e)
      return { text: errorHandler.getErrorInfo(e).tip + '，请重试。', toolIntent: null, malformed: false }
    }
  }

  // 流式 adapter（通道 A）：前端直连混元，输出回复文本 + 工具意图标识；429 重试（最多 2 次）；其他失败降级
  function stream({ sp, streamHist, ms2, lastIdx, userText, genHist, retryCount, sessionId }) {
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
      // 官方文档：wx.cloud.extend.AI streamText 无 onError 参数（仅有 onText/onEvent/onFinish），
      // 错误处理须 try/catch 包裹调用（此处捕获 Promise 拒绝路径）
      const model = wx.cloud.extend.AI.createModel('cloudbase') // 成长计划免费资源包（hy3）
      // 错误处理：提取为具名函数，便于首字超时定时器调用
      let _settled = false // 防止 resolve/reject 重复触发（onError 被 timeout 主动调用时）
      function handleError(err) {
        if (_settled) return
        _settled = true
        clearTimeout(timeoutTimer)
        if (!component._disposed && firstChunk) component.setData({ thinking: false })
        if (component._disposed) { reject(err); return }
        const errMsg = (err && (err.errMsg || err.message || '')) || ''
        const is429 = errMsg.includes('429') || errMsg.includes('Too Many Requests')
        const isTimeout = errMsg.includes('timeout') || errMsg.includes('time out')
        // 429 或超时：最多重试 2 次，指数退避（1s → 2s）
        if ((is429 || isTimeout) && retryCount < 2) {
          const delay = (retryCount + 1) * 1000
          console.warn('[chat-source] streamText 429/超时，' + delay + 'ms 后重试 (第' + (retryCount + 1) + '次)')
          component._timers.push(setTimeout(() => {
            _settled = false
            stream({ sp, streamHist, ms2, lastIdx, userText, genHist, retryCount: retryCount + 1, sessionId })
              .then(resolve).catch(reject)
          }, delay))
          return
        }
        console.error('[chat-source] streamText 失败，降级:', err)
        // 流式失败，走 generateText 降级（用 genHist 避免用户消息重复）
        fallback(sp, genHist, userText).then(resolve).catch(reject)
      }
      // 30 秒无首字判定超时，主动触发 onError 路径，避免 Promise 永久挂起
      const timeoutTimer = setTimeout(() => {
        if (firstChunk) {
          timedOut = true
          console.warn('[chat-source] streamText 首字超时')
          handleError({ message: 'timeout: 30s 无首字' })
        }
      }, 30000)
      component._timers.push(timeoutTimer)
      // token 成本审计 P1：限制单次输出长度
      model.streamText({
        data: { model: 'hy3', messages: [{ role: 'system', content: safeSp }, ...safeHist], max_tokens: 1500 },
        onText: c => {
          if (component._disposed) return
          // UI 审计 状态 S2：用户停止生成 → 保留已生成文本提前收尾，不再追加新内容
          if (component._streamAborted) {
            if (!_settled) {
              _settled = true
              clearTimeout(timeoutTimer)
              const { text: cleanText, toolIntent, malformed } = _extractToolIntent(fullText)
              resolve({ text: cleanText, toolIntent, malformed })
            }
            return
          }
          if (timedOut) { timedOut = false; clearTimeout(timeoutTimer) }
          if (firstChunk) {
            firstChunk = false; clearTimeout(timeoutTimer)
            component.setData({ thinking: false })
          }
          fullText += c
          // v9：渲染时屏蔽工具意图标识行（partial 阶段不完整，行首匹配即整行隐藏）
          const displayText = _maskToolIntent(cleanMarkers(fullText, { partial: true }))
          // 节流：每 100ms 最多更新一次 UI
          const now = Date.now()
          if (now - _lastFlush >= 100) {
            _lastFlush = now
            if (component._streamSession !== sessionId) return
            component.setData({ ['messages[' + lastIdx + '].content']: _fullWidthPunct(displayText) })
            _doFlush()
          } else if (!_pendingFlush) {
            _pendingFlush = setTimeout(() => {
              if (component._disposed || component._streamAborted) return
              if (component._streamSession !== sessionId) return
              _lastFlush = Date.now()
              component.setData({ ['messages[' + lastIdx + '].content']: _fullWidthPunct(displayText) })
              _doFlush()
            }, 100 - (now - _lastFlush))
            component._timers.push(_pendingFlush)
          }
        },
        onFinish: () => {
          if (_settled) return
          _settled = true
          clearTimeout(timeoutTimer)
          if (!component._disposed && firstChunk) component.setData({ thinking: false })
          // v9：剥离标识块 + 解析工具意图（多行容错 + malformed 标记）
          const { text: cleanText, toolIntent, malformed } = _extractToolIntent(fullText)
          resolve({ text: cleanText, toolIntent, malformed })
        },
        onError: handleError
      })
    })
  }

  // 主入口：按 wx.cloud.extend.AI 可用性自动选 adapter
  async function send(opts) {
    const { sp, streamHist, genHist, userText, ms2, lastIdx } = opts
    const sessionId = Date.now() + '_' + Math.random().toString(36).slice(2)
    component._streamSession = sessionId
    if (wx.cloud.extend && wx.cloud.extend.AI) {
      return stream({ sp, streamHist, ms2, lastIdx, userText, genHist, retryCount: undefined, sessionId })
    }
    return fallback(sp, genHist, userText)
  }

  return { send, stream, fallback }
}

module.exports = { createChatSource, _extractToolIntent }
