/**
 * tool-orchestration 测试
 * 架构审计第 13 轮候选 #4：补单测
 *
 * 覆盖：空输入、无 toolCalls、有 toolCalls、summary 拼接、429 退避、AI 失败降级
 */
jest.mock('wx-server-sdk', () => ({ database: () => ({}) }), { virtual: true })

// mock ai-client / ai-gateway，让 orchestrate 的 AI 调用可控
const mockCallChatWithTools = jest.fn()
const mockSafeCallChatWithTools = jest.fn()
jest.mock('../cloudfunctions/conversationAI/_shared/ai-client', () => ({
  callChatWithTools: (...args) => mockCallChatWithTools(...args)
}))
jest.mock('../cloudfunctions/conversationAI/_shared/ai-gateway', () => ({
  safeCallChatWithTools: (...args) => mockSafeCallChatWithTools(...args)
}))

const { orchestrate } = require('../cloudfunctions/conversationAI/tool-orchestration')

beforeEach(() => {
  jest.clearAllMocks()
})

function makeBaseArgs(overrides = {}) {
  return {
    familyId: 'fam_001',
    openid: 'op_test',
    sid: 'sess_001',
    userText: '我有重疾险',
    auditText: '初始审计文本',
    dispatch: jest.fn(),
    ctxCache: { get: jest.fn().mockReturnValue('ctx 内容'), invalidate: jest.fn() },
    toolDefs: [{ name: 'addFact' }],
    toolSummaries: { addFact: (tr) => `已添加事实：${tr.result && tr.result.data && tr.result.data.factId}` },
    buildAdvisorSystemPrompt: () => 'system prompt',
    ...overrides
  }
}

describe('orchestrate - 空输入', () => {
  test('userText 为空 → 返回 auditText，不调 AI', async () => {
    const args = makeBaseArgs({ userText: '' })
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('初始审计文本')
    expect(r.suggestions).toEqual([])
    expect(r.pending_confirms).toEqual([])
    expect(r.toolResults).toEqual([])
    expect(mockSafeCallChatWithTools).not.toHaveBeenCalled()
  })

  test('auditText 也为空 → cleanText 为空字符串', async () => {
    const args = makeBaseArgs({ userText: '', auditText: '' })
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('')
  })

  test('auditText 未传 → 退化为空字符串', async () => {
    const args = makeBaseArgs({ userText: '', auditText: undefined })
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('')
  })
})

describe('orchestrate - 无 toolCalls', () => {
  test('无 toolCalls → cleanText 退化为 auditText（源代码行为：if 块跳过，不更新 cleanText）', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({ text: 'AI 回复', toolCalls: [] })
    const args = makeBaseArgs()
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('初始审计文本')
    expect(r.toolResults).toEqual([])
    expect(args.dispatch).not.toHaveBeenCalled()
  })

  test('phase1.text 为空 → 退化为 auditText', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({ text: '', toolCalls: [] })
    const args = makeBaseArgs()
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('初始审计文本')
  })

  test('context 从 ctxCache 取', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({ text: 'ok', toolCalls: [] })
    const args = makeBaseArgs()
    await orchestrate(args)
    expect(args.ctxCache.get).toHaveBeenCalledWith('fam_001')
  })
})

describe('orchestrate - 有 toolCalls', () => {
  test('成功 dispatch → toolResults + summary 拼接', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'addFact', arguments: '{"predicate":"拥有保障","objectValue":"重疾险","confidence":0.9}' }
      }]
    })
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { factId: 'f1' } })
    const args = makeBaseArgs({ dispatch })
    const r = await orchestrate(args)
    expect(dispatch).toHaveBeenCalledWith('addFact', expect.objectContaining({
      familyId: 'fam_001', predicate: '拥有保障', confidence: 0.9
    }), 'op_test')
    expect(r.toolResults).toHaveLength(1)
    expect(r.toolResults[0]).toMatchObject({ toolName: 'addFact', success: true })
    // summary 拼接到 cleanText
    expect(r.cleanText).toContain('AI 回复')
    expect(r.cleanText).toContain('已添加事实：f1')
    // 数据变更后失效缓存
    expect(args.ctxCache.invalidate).toHaveBeenCalledWith('fam_001')
  })

  test('dispatch 失败 → toolResults.success=false，summary 跳过', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'addFact', arguments: '{}' }
      }]
    })
    const dispatch = jest.fn().mockRejectedValue(new Error('DB down'))
    const args = makeBaseArgs({ dispatch })
    const r = await orchestrate(args)
    expect(r.toolResults[0].success).toBe(false)
    expect(r.toolResults[0].error).toBe('DB down')
    // summary 不包含失败的工具
    expect(r.cleanText).toBe('AI 回复')
  })

  test('arguments 非法 JSON → 退化为空对象，仍调 dispatch', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'addFact', arguments: 'not-json' }
      }]
    })
    const dispatch = jest.fn().mockResolvedValue({ code: 200 })
    const args = makeBaseArgs({ dispatch })
    await orchestrate(args)
    expect(dispatch).toHaveBeenCalledWith('addFact', expect.objectContaining({ familyId: 'fam_001' }), 'op_test')
  })

  test('有 pending suggestions 时 → cleanText 不拼 summary（只保留 phase1 文本）', async () => {
    // 低置信度 addFact 会触发 suggestion
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'addFact', arguments: '{"predicate":"备注","objectValue":"想加保","confidence":0.3}' }
      }]
    })
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { factId: 'f_pending' } })
    const args = makeBaseArgs({ dispatch })
    const r = await orchestrate(args)
    expect(r.suggestions).toHaveLength(1)
    expect(r.pending_confirms).toHaveLength(1)
    // hasPending=true → cleanText 只保留 phase1 文本
    expect(r.cleanText).toBe('AI 回复')
    expect(r.cleanText).not.toContain('已添加事实')
  })

  test('toolSummaries 中无对应工具 → summary 跳过该工具', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'unknownTool', arguments: '{}' }
      }]
    })
    const dispatch = jest.fn().mockResolvedValue({ code: 200 })
    const args = makeBaseArgs({ dispatch, toolSummaries: {} })
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('AI 回复')
  })
})

describe('orchestrate - 429 退避', () => {
  test('首次 429 → 重试成功（重试后无 toolCalls，cleanText 退化为 auditText）', async () => {
    const err429 = new Error('429 Too Many Requests')
    mockSafeCallChatWithTools
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce({ text: '重试成功', toolCalls: [] })
    const args = makeBaseArgs()
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('初始审计文本')
    expect(mockSafeCallChatWithTools).toHaveBeenCalledTimes(2)
  })

  test('连续 3 次 429 → 抛出被捕获，返回 auditText', async () => {
    const err429 = new Error('429 Too Many Requests')
    mockSafeCallChatWithTools.mockRejectedValue(err429)
    const args = makeBaseArgs()
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('初始审计文本')
    expect(r.toolResults).toEqual([])
    expect(mockSafeCallChatWithTools).toHaveBeenCalledTimes(3)
  })

  test('非 429 错误 → 不重试，直接抛出被捕获', async () => {
    mockSafeCallChatWithTools.mockRejectedValue(new Error('500 Internal'))
    const args = makeBaseArgs()
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('初始审计文本')
    expect(mockSafeCallChatWithTools).toHaveBeenCalledTimes(1)
  })
})

describe('orchestrate - policyFactSplitter 集成', () => {
  test('userText 含保障描述 → coverageHint 注入到 system 消息', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({ text: 'ok', toolCalls: [] })
    const args = makeBaseArgs({ userText: '我有重疾险50万，还有医疗险' })
    await orchestrate(args)
    const messagesArg = mockSafeCallChatWithTools.mock.calls[0][0]
    const systemContent = messagesArg[0].content
    expect(systemContent).toContain('规则预提取的保障')
    expect(systemContent).toContain('重疾险')
  })

  test('userText 无保障关键词 → coverageHint 仍注入（fallback 整块成一条，confidence 降一档）', async () => {
    // policyFactSplitter 源代码保证：非空文本永远至少生成 1 条 fact（无 cat 匹配时整块降档 push）
    mockSafeCallChatWithTools.mockResolvedValue({ text: 'ok', toolCalls: [] })
    const args = makeBaseArgs({ userText: '今天天气不错' })
    await orchestrate(args)
    const systemContent = mockSafeCallChatWithTools.mock.calls[0][0][0].content
    expect(systemContent).toContain('规则预提取的保障')
    // 但不含保额信息（_extractAmount 找不到数字）
    expect(systemContent).not.toContain('保额')
  })
})
