/**
 * ai-client.js v4.1 — hunyuan-v3 + hy3 流式协议
 */
const tcb = require('@cloudbase/node-sdk')
const { AI, ENV_ID } = require('./config')

// 模型名常量 — 切换推理模型只需改 config.js
const THINK_MODEL = AI.THINK_MODEL
const CHAT_MODEL = AI.CHAT_MODEL
const GROUP = AI.GROUP

let _ai = null
function _getAI() {
  if (!_ai) _ai = tcb.init({ env: ENV_ID, timeout: AI.SDK_TIMEOUT }).ai()
  return _ai
}

function _createModel() {
  return _getAI().createModel(GROUP)
}

/**
 * 内部推理 — 非流式，不传 response_format/temperature
 * thinking 模型无 system role，自动合并到首条 user message
 * 超时降级：超过 timeoutMs 自动回退 callChat
 */
async function callThink(messages, timeoutMs = AI.THINK_TIMEOUT) {
  const ai = _getAI()
  const systemContent = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  let userMessages = messages.filter(m => m.role !== 'system')
  if (systemContent) {
    if (userMessages.length > 0) {
      userMessages[0] = { role: 'user', content: systemContent + '\n\n' + userMessages[0].content }
    } else {
      userMessages = [{ role: 'user', content: systemContent }]
    }
  }
  const model = _createModel()

  const thinkPromise = model.generateText({
    model: THINK_MODEL,
    messages: userMessages
  }).then(res => ({
    result: 'think',
    text: (res.text || '').trim(),
    usage: res.usage || {}
  }))

  // S3-1 修复：保存 timerId，Promise.race 后清理，避免定时器残留导致 unhandled rejection
  let timerId
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error('THINK_TIMEOUT')), timeoutMs)
  })

  try {
    const { text, usage } = await Promise.race([thinkPromise, timeoutPromise])
    clearTimeout(timerId)
    return { text, usage }
  } catch (e) {
    clearTimeout(timerId)
    console.warn('[ai-client] callThink 失败(' + (e.message || e) + ')，交由 reasoningDispatcher 降级')
    throw e
  }
}

/**
 * 用户面非流式响应 — 用 generateText 获取准确的 usage
 * opts.model / opts.temperature / opts.timeoutMs 覆盖默认值
 */
async function callChat(messages, opts = {}) {
  const { responseFormat, maxTokens, model: modelOverride, temperature, timeoutMs } = opts
  const reqOpts = {
    model: modelOverride || CHAT_MODEL,
    messages
  }
  if (responseFormat) reqOpts.response_format = responseFormat
  if (maxTokens) reqOpts.max_tokens = maxTokens
  if (temperature != null) reqOpts.temperature = temperature
  const model = _createModel()

  // 超时保护：与 callThink 同样用 Promise.race，超时抛错交由上层处理
  const callPromise = model.generateText(reqOpts).then(res => ({
    text: (res.text || '').trim(),
    usage: res.usage || {}
  }))

  if (!timeoutMs) return callPromise

  // S3-1 修复：保存 timerId，Promise.race 后清理，避免定时器残留导致 unhandled rejection
  let timerId
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error('CHAT_TIMEOUT')), timeoutMs)
  })
  return Promise.race([callPromise, timeoutPromise]).finally(() => clearTimeout(timerId))
}

/** 带原生 function calling 的 AI 调用 — 返回 { text, toolCalls, usage }
 * ponytail: @cloudbase/ai 的 generateText 规范化响应，顶层无 choices；
 * tool_calls 在 res.messages（含 ToolCallAssistantMessage）。
 * maxSteps=1 让 SDK 只发一次请求、不自动执行工具，由调用方两阶段手动 dispatch
 * （避免 SDK 全局 toolMap 并发串号 + 无 fn 时的 callTool 异常）。
 */
async function callChatWithTools(messages, tools, opts = {}) {
  const model = _createModel()
  const { maxTokens } = opts || {}
  const reqOpts = {
    model: CHAT_MODEL,
    messages,
    tools,
    temperature: 0.3,
    maxSteps: 1 // 只取模型首轮决策（tool_calls），不自动执行
  }
  if (maxTokens) reqOpts.max_tokens = maxTokens
  const res = await model.generateText(reqOpts)
  const usage = res.usage || {}
  const toolCalls = _extractToolCalls(res.messages, res.rawResponses)
  // P0-1: 已发工具但模型未产出 tool_calls → 记录 keys 便于排查
  if (tools && tools.length > 0 && toolCalls.length === 0) {
    console.warn('[ai-client] callChatWithTools: tools sent but no tool_calls in messages, keys:', Object.keys(res || {}).join(','))
  }
  const text = (res.text || '').trim()
  return { text, toolCalls, usage }
}

/** 从 SDK 规范化响应中提取 tool_calls。
 * 优先取 res.messages 末条 assistant 工具调用消息（maxSteps=1 生效时）；
 * 兜底取 res.rawResponses 的 OpenAI 原始 choices（maxSteps 被忽略、SDK 走 callTool 异常分支时）。
 */
function _extractToolCalls(messages, rawResponses) {
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        return m.tool_calls
      }
    }
  }
  if (Array.isArray(rawResponses)) {
    for (const raw of rawResponses) {
      const tcs = raw && raw.choices && raw.choices[0] && raw.choices[0].message && raw.choices[0].message.tool_calls
      if (Array.isArray(tcs) && tcs.length > 0) return tcs
    }
  }
  return []
}

/**
 * DeepSeek 直连 — OpenAI 兼容格式，绕过 TokenHub 限流
 * 并发上限 2500（flash） / 500（pro），429 几乎不会触发
 * 文档: https://api-docs.deepseek.com/zh-cn/
 */
async function callChatDirect(messages, opts = {}) {
  const { responseFormat, maxTokens, temperature, timeoutMs } = opts
  const axios = require('axios')
  const apiKey = process.env[AI.DIRECT_API_KEY_ENV]
  if (!apiKey) {
    const err = new Error('缺少 ' + AI.DIRECT_API_KEY_ENV + ' 环境变量')
    err.code = 'missing_api_key'
    throw err
  }

  const reqOpts = {
    // 强制使用 DIRECT_MODEL，忽略上层传入的 model（TokenHub 的 hy3 不适用 DeepSeek API）
    model: AI.DIRECT_MODEL,
    messages,
    stream: false,
    // DeepSeek-V4-Flash 默认开启 thinking 模式，思考消耗大量 token 导致 content 为空（ai_empty）
    // OCR 提取是结构化任务，不需要深度思考，关闭 thinking 模式
    // 文档: https://api-docs.deepseek.com/guides/thinking_mode
    thinking: { type: 'disabled' }
  }
  if (responseFormat) reqOpts.response_format = responseFormat
  if (maxTokens) reqOpts.max_tokens = maxTokens
  if (temperature != null) reqOpts.temperature = temperature

  const timeout = timeoutMs || 30000
  try {
    const res = await axios.post(AI.DIRECT_BASE_URL + '/chat/completions', reqOpts, {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      timeout: timeout,
      validateStatus: function () { return true }
    })

    if (res.status === 429) {
      const err = new Error('RATE_LIMIT')
      err.code = '429'
      err.statusCode = 429
      throw err
    }

    if (res.status < 200 || res.status >= 300) {
      var errDetail = 'status=' + res.status
      if (res.data) {
        if (res.data.error && res.data.error.message) errDetail += ' msg=' + res.data.error.message
        else errDetail += ' body=' + JSON.stringify(res.data).substring(0, 500)
      }
      console.error('[ai-client callChatDirect] non-2xx:', errDetail, '| req model:', reqOpts.model, '| msgs:', messages.length)
      const err = new Error(errDetail)
      err.code = res.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST'
      throw err
    }

    // 结构守卫：DeepSeek 偶发返回空 choices 或异常 body，直接解构会 TypeError
    if (!res.data || !Array.isArray(res.data.choices) || res.data.choices.length === 0 || !res.data.choices[0] || !res.data.choices[0].message) {
      console.error('[ai-client callChatDirect] 异常响应结构: choices missing, status=' + res.status)
      const err = new Error('ai_format')
      err.code = 'ai_format'
      throw err
    }
    const content = (res.data.choices[0].message.content || '').trim()
    if (!content) {
      const err = new Error('ai_empty')
      err.code = 'ai_empty'
      throw err
    }

    return {
      text: content,
      usage: res.data.usage || {}
    }
  } catch (e) {
    if (e.code === '429' || e.code === 'ai_empty' || e.code === 'missing_api_key' || e.code === 'ERR_BAD_REQUEST' || e.code === 'ERR_BAD_RESPONSE') throw e
    if (e.code === 'ECONNABORTED') {
      const err = new Error('CHAT_TIMEOUT')
      err.code = 'CHAT_TIMEOUT'
      throw err
    }
    throw e
  }
}

module.exports = { callThink, callChat, callChatWithTools, callChatDirect }
