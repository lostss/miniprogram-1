/**
 * ai-client.js v4.1 — hy3-preview（hunyuan-exp 分组）+ hy3 流式协议
 */
const tcb = require('@cloudbase/node-sdk')
const { AI, ENV_ID } = require('./config')

// 模型名常量 — 切换推理模型只需改 config.js
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

// ---- AI 调用级观测（重构审计 #3：统一出口计量，写入 operation_logs） ----
// 每次 AI 调用记录 { purpose, model, status, tokens, duration_ms }，失败时 status=错误码。
// 默认写 operation_logs（fire-and-forget）；函数入口可用 setAiObserver 覆盖自定义写路径。
let _observer = null
function setAiObserver(fn) { _observer = fn }

let _db = null
function _getDb() {
  if (!_db) {
    try { _db = tcb.init({ env: ENV_ID, timeout: AI.SDK_TIMEOUT }).database() } catch (e) { _db = null }
  }
  return _db
}

function _defaultObserve(payload) {
  const db = _getDb()
  if (!db) return null
  // 观测统一修复（2026-09-05）：补 _openid 归因——原直写无 _openid，任何按用户核算 AI 成本的看板都会漏这一路
  return db.collection('operation_logs').add({ data: Object.assign({ logAction: 'ai_call', _openid: (payload && payload.openid) || '', created_at: new Date() }, payload) })
}

function _observe(payload) {
  try {
    const fn = _observer || _defaultObserve
    const p = fn(payload)
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch (e) { /* 观测失败静默，不影响主流程 */ }
}

function _tokens(usage) {
  usage = usage || {}
  return { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, total: usage.total_tokens || 0 }
}

// 统一包装：计时 + 成功(usage)/失败(error code) 各记一条（done 防双记）
// openid 由调用方经 opts.openid 注入（ai-gateway mergedOpts 或裸直连调用方），观测落库可归因
function _withObserve(purpose, reqModel, fn, openid) {
  const start = Date.now()
  let done = false
  const emit = function (status, usage) {
    if (done) return
    done = true
    _observe({ purpose: purpose, model: reqModel, status: status, tokens: _tokens(usage), duration_ms: Date.now() - start, openid: openid || '' })
  }
  return fn().then(function (v) { emit('ok', v.usage); return v }).catch(function (e) { emit(e.code || 'ai_error'); throw e })
}

/**
 * 用户面非流式响应 — 用 generateText 获取准确的 usage
 * opts.model / opts.temperature / opts.timeoutMs 覆盖默认值
 */
async function callChat(messages, opts = {}) {
  const { responseFormat, maxTokens, model: modelOverride, temperature, timeoutMs, purpose, openid, enableThinking } = opts
  const reqOpts = {
    model: modelOverride || CHAT_MODEL,
    messages
  }
  if (responseFormat) reqOpts.response_format = responseFormat
  if (maxTokens) reqOpts.max_tokens = maxTokens
  if (temperature != null) reqOpts.temperature = temperature
  // hy3 实测（2026-09-09）：默认参数下长任务只输出空对象 text='{"": ""}'（completion 6 tokens，
  // 线上报告场景 output 1275 tokens 全被 reasoning 吃掉 → JSON 解析失败）；
  // 显式 enable_thinking:false 才正常产出完整内容（同一 prompt 实测 1260 tokens / 11.7s）。
  // thinking:{type:'disabled'} 对 hy3 无效。仅按调用方显式指定透传，不改变对话链路默认行为。
  if (enableThinking !== undefined) reqOpts.enable_thinking = enableThinking
  const model = _createModel()

  // 超时保护：与 callThink 同样用 Promise.race，超时抛错交由上层处理
  const callPromise = _withObserve(purpose || 'chat', reqOpts.model, () =>
    model.generateText(reqOpts).then(res => ({
      text: (res.text || '').trim(),
      usage: res.usage || {}
    })), openid
  )

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
  const { maxTokens, purpose, openid } = opts || {}
  const reqOpts = {
    model: CHAT_MODEL,
    messages,
    tools,
    temperature: 0.3,
    maxSteps: 1 // 只取模型首轮决策（tool_calls），不自动执行
  }
  if (maxTokens) reqOpts.max_tokens = maxTokens
  const res = await _withObserve(purpose || 'chat_tools', reqOpts.model, () => model.generateText(reqOpts), openid)
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
 * DeepSeek 直连 function calling（OpenAI 兼容）— P2-D（2026-08-29）：
 * hy3/hunyuan-exp 工具遵从差（"修改家庭收入"两轮实测均不输出 tool_calls），
 * 写声称重试 / 主通道优先（① 2026-08-30）时兜底用。
 * 返回 { text, toolCalls, usage }；缺 key / 网络错误抛错由上层降级。
 */
async function callChatWithToolsDirect(messages, tools, opts = {}) {
  const { maxTokens, temperature, timeoutMs, purpose, openid } = opts || {}
  const axios = require('axios')
  const apiKey = process.env[AI.DIRECT_API_KEY_ENV]
  if (!apiKey) {
    const err = new Error('缺少 ' + AI.DIRECT_API_KEY_ENV + ' 环境变量')
    err.code = 'missing_api_key'
    throw err
  }
  const reqOpts = {
    model: AI.DIRECT_MODEL,
    messages,
    tools,
    stream: false,
    thinking: { type: 'disabled' } // 工具决策是结构化任务，不需要深度思考
  }
  if (maxTokens) reqOpts.max_tokens = maxTokens
  if (temperature != null) reqOpts.temperature = temperature
  const timeout = timeoutMs || 30000
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
    if (res.data && res.data.error && res.data.error.message) errDetail += ' msg=' + res.data.error.message
    else if (res.data) errDetail += ' body=' + JSON.stringify(res.data).substring(0, 500)
    console.error('[ai-client callChatWithToolsDirect] non-2xx:', errDetail, '| msgs:', (messages || []).length, '| tools:', (tools || []).length)
    const err = new Error(errDetail)
    err.code = res.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST'
    throw err
  }
  // 结构守卫：DeepSeek 偶发空 choices / 异常 body
  if (!res.data || !Array.isArray(res.data.choices) || res.data.choices.length === 0 || !res.data.choices[0] || !res.data.choices[0].message) {
    console.error('[ai-client callChatWithToolsDirect] 异常响应结构: choices missing, status=' + res.status)
    const err = new Error('ai_format')
    err.code = 'ai_format'
    throw err
  }
  const msg = res.data.choices[0].message
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  return _withObserve(purpose || 'chat_tools_direct', AI.DIRECT_MODEL, () => Promise.resolve({
    text: (msg.content || '').trim(),
    toolCalls,
    usage: res.data.usage || {}
  }), openid)
}

/**
 * DeepSeek 直连 — OpenAI 兼容格式，绕过 TokenHub 限流
 * 并发上限 2500（flash） / 500（pro），429 几乎不会触发
 * 文档: https://api-docs.deepseek.com/zh-cn/
 */
async function callChatDirect(messages, opts = {}) {
  const { responseFormat, maxTokens, temperature, timeoutMs, purpose, openid } = opts
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

    return _withObserve(purpose || 'direct', AI.DIRECT_MODEL, () => Promise.resolve({
      text: content,
      usage: res.data.usage || {}
    }), openid)
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

module.exports = { callChat, callChatWithTools, callChatWithToolsDirect, callChatDirect, setAiObserver }
