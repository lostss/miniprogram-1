/**
 * callChatWithToolsDirect（DeepSeek 直连 function calling）— P2-D 兜底通道
 * hy3/hunyuan-exp 工具遵从差，写声称重试时切 DeepSeek 直连（OpenAI 兼容）。
 * 覆盖：成功提取 tool_calls、429、缺 key、异常响应结构。
 */
jest.mock('wx-server-sdk', () => ({ init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock', database: jest.fn() }))
jest.mock('@cloudbase/node-sdk', () => ({
  init: jest.fn(function () {
    return {
      ai: function () { return { createModel: function () { return { generateText: jest.fn() } } } },
      database: function () { return { collection: jest.fn() } }
    }
  })
}))
jest.mock('axios', () => ({ post: jest.fn() }), { virtual: true })

const axios = require('axios')
const aiClient = require('../cloudfunctions/conversationAI/_shared/ai-client')

const TOOLS = [{ type: 'function', function: { name: 'updateFinances', parameters: { type: 'object' } } }]
const MSGS = [{ role: 'user', content: '修改家庭收入为35万' }]

describe('callChatWithToolsDirect（DeepSeek 直连 function calling）', function () {
  beforeEach(function () {
    jest.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = 'sk-test'
  })

  test('成功：提取 tool_calls 与 content，请求体符合 OpenAI 兼容格式', async function () {
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        choices: [{
          message: {
            content: '好的',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'updateFinances', arguments: '{"annual_income":350000}' } }]
          }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
    })
    const out = await aiClient.callChatWithToolsDirect(MSGS, TOOLS, { maxTokens: 1200 })
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls[0].function.name).toBe('updateFinances')
    expect(out.text).toBe('好的')
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/chat/completions'),
      expect.objectContaining({ model: 'deepseek-flash', messages: MSGS, tools: TOOLS, max_tokens: 1200, stream: false }),
      expect.anything()
    )
  })

  test('429：抛出 RATE_LIMIT', async function () {
    axios.post.mockResolvedValue({ status: 429, data: {} })
    await expect(aiClient.callChatWithToolsDirect(MSGS, TOOLS, {})).rejects.toMatchObject({ code: '429' })
  })

  test('缺 DEEPSEEK_API_KEY：抛出 missing_api_key，不发请求', async function () {
    delete process.env.DEEPSEEK_API_KEY
    await expect(aiClient.callChatWithToolsDirect(MSGS, TOOLS, {})).rejects.toMatchObject({ code: 'missing_api_key' })
    expect(axios.post).not.toHaveBeenCalled()
  })

  test('异常响应结构：choices 缺失 → ai_format', async function () {
    axios.post.mockResolvedValue({ status: 200, data: { choices: [] } })
    await expect(aiClient.callChatWithToolsDirect(MSGS, TOOLS, {})).rejects.toMatchObject({ code: 'ai_format' })
  })
})
