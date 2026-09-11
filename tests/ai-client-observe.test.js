/**
 * ai-client 调用级观测（重构审计 #3）
 * 验证 _withObserve 在成功/失败路径各记一条观测（status/tokens/duration），失败时异常继续上抛，
 * purpose 透传，且无 observer 时默认写 operation_logs 不抛错。
 */
jest.mock('wx-server-sdk', () => ({ init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock', database: jest.fn() }))
jest.mock('@cloudbase/node-sdk', () => {
  const generateText = jest.fn()
  return {
    __generateText: generateText,
    init: jest.fn(function () {
      return {
        ai: function () { return { createModel: function () { return { generateText: generateText } } } },
        database: jest.fn(function () { return { collection: jest.fn() } })
      }
    })
  }
})

const tcbMock = require('@cloudbase/node-sdk')
const aiClient = require('../cloudfunctions/_shared/ai-client')

describe('ai-client 调用级观测', function () {
  beforeEach(function () { jest.clearAllMocks() })

  test('callChat 成功：observer 收到 ok + tokens + duration', function () {
    tcbMock.__generateText.mockResolvedValue({ text: ' hi ', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    const observer = jest.fn()
    aiClient.setAiObserver(observer)
    return aiClient.callChat([{ role: 'user', content: 'hi' }]).then(function (out) {
      expect(out.text).toBe('hi')
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({
        purpose: 'chat', model: 'hy3', status: 'ok',
        tokens: { prompt: 10, completion: 5, total: 15 }
      }))
      expect(observer.mock.calls[0][0].duration_ms).toBeGreaterThanOrEqual(0)
    })
  })

  test('callChat 失败：observer 收到错误码且异常继续上抛', function () {
    const err = new Error('RATE_LIMIT'); err.code = '429'
    tcbMock.__generateText.mockRejectedValue(err)
    const observer = jest.fn()
    aiClient.setAiObserver(observer)
    return aiClient.callChat([{ role: 'user', content: 'hi' }]).catch(function (e) {
      expect(e).toBe(err)
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ status: '429', purpose: 'chat' }))
    })
  })

  test('purpose 透传：opts.purpose 覆盖默认', function () {
    tcbMock.__generateText.mockResolvedValue({ text: 'ok', usage: {} })
    const observer = jest.fn()
    aiClient.setAiObserver(observer)
    return aiClient.callChat([], { purpose: 'deep_analysis' }).then(function () {
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'deep_analysis' }))
    })
  })

  test('callChatWithTools 成功：observer 收到 chat_tools 观测', function () {
    tcbMock.__generateText.mockResolvedValue({ text: 'ok', usage: { total_tokens: 100 }, messages: [] })
    const observer = jest.fn()
    aiClient.setAiObserver(observer)
    return aiClient.callChatWithTools([], []).then(function (out) {
      expect(out.text).toBe('ok')
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({
        purpose: 'chat_tools',
        tokens: expect.objectContaining({ total: 100 })
      }))
    })
  })

  test('openid 透传：opts.openid → observer payload（观测归因修复 2026-09-05）', function () {
    tcbMock.__generateText.mockResolvedValue({ text: 'ok', usage: {} })
    const observer = jest.fn()
    aiClient.setAiObserver(observer)
    return aiClient.callChat([], { openid: 'op_test' }).then(function () {
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ openid: 'op_test' }))
    })
  })

  test('无 observer：默认写 operation_logs 失败静默，不干扰主流程', function () {
    // 未注册 observer → 默认走 tcb.database().collection().add()（jest 下 mock 为空实现，add 未定义 → 异常被吞）
    tcbMock.__generateText.mockResolvedValue({ text: 'ok', usage: {} })
    return expect(aiClient.callChat([], {})).resolves.toBeTruthy()
  })
})
