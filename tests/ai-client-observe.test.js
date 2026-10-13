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

  test('失败路径也带 usage：err.usage 透传到观测 tokens（成本低估修复 2026-09-12）', function () {
    const observer = jest.fn()
    aiClient.setAiObserver(observer)
    const err = new Error('ai_empty')
    err.code = 'ai_empty'
    // 直连通道在 content 为空时其实已拿到 res.data.usage，改后挂在 err.usage 上供记账
    err.usage = { prompt_tokens: 700, completion_tokens: 0, total_tokens: 700 }
    tcbMock.__generateText.mockRejectedValue(err)
    return aiClient.callChat([]).catch(function (e) {
      expect(e).toBe(err)
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({
        status: 'ai_empty',
        tokens: { prompt: 700, completion: 0, total: 700 }
      }))
    })
  })

  test('无 observer：默认写 operation_logs 失败静默，不干扰主流程', function () {
    // 未注册 observer → 默认走 wx-server-sdk 的 cloud.database()（2026-09-12 从 @cloudbase/node-sdk 换回，
    // 见下一条回归用例）；此处 database mock 返回 undefined → _getDb 返回 falsy → 观测静默跳过
    aiClient.setAiObserver(null)
    tcbMock.__generateText.mockResolvedValue({ text: 'ok', usage: {} })
    return expect(aiClient.callChat([], {})).resolves.toBeTruthy()
  })

  test('默认 observer：写 operation_logs 且业务字段平铺（回归：曾整包嵌进 data 子对象）', async function () {
    // 2026-09-12 实证根因：@cloudbase/node-sdk 的 add({ data }) 会把业务字段整体写进 `data` 子对象
    // （文档形如 {_id, data:{logAction,purpose,tokens,_openid,created_at}}），导致按顶层字段的任何查询
    // 命中 0、_openid 归因与 TTL 失效——线上 142 条 ai_call 观测即为该形态。改用 wx-server-sdk 后
    // add({ data }) 语义与项目其他写入一致。本用例锁死"字段必须在顶层"。
    const cloud = require('wx-server-sdk')
    const add = jest.fn(() => Promise.resolve({ id: 'log_1' }))
    cloud.database.mockReturnValue({ collection: jest.fn(() => ({ add })) })
    aiClient.setAiObserver(null)
    tcbMock.__generateText.mockResolvedValue({ text: 'ok', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })

    await aiClient.callChat([], { purpose: 'observe_probe', openid: 'op1' })

    expect(add).toHaveBeenCalledTimes(1)
    const doc = add.mock.calls[0][0].data
    expect(doc.logAction).toBe('ai_call')
    expect(doc.purpose).toBe('observe_probe')
    expect(doc._openid).toBe('op1')
    expect(doc.tokens).toEqual({ prompt: 3, completion: 2, total: 5 })
    expect(doc.created_at).toBeInstanceOf(Date)
    // 关键回归断言：不得出现 { data: {...} } 的嵌套外壳
    expect(doc.data).toBeUndefined()
  })
})
