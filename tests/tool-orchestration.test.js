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
const mockCallChat = jest.fn()
const mockSafeCallChat = jest.fn()
jest.mock('../cloudfunctions/conversationAI/_shared/ai-client', () => ({
  callChatWithTools: (...args) => mockCallChatWithTools(...args),
  callChat: (...args) => mockCallChat(...args)
}))
jest.mock('../cloudfunctions/conversationAI/_shared/ai-gateway', () => ({
  safeCallChatWithTools: (...args) => mockSafeCallChatWithTools(...args),
  safeCallChat: (...args) => mockSafeCallChat(...args)
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
    buildToolSystemPrompt: () => 'system prompt',
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
    expect(args.ctxCache.get).toHaveBeenCalledWith('fam_001:op_test')
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
    // v9.3 成功回流：写类工具成功 → 工具结果回流 B 生成最终回复
    mockSafeCallChat.mockResolvedValue({ text: '已为您记录事实：拥有保障-重疾险（高置信）。' })
    const args = makeBaseArgs({ dispatch })
    const r = await orchestrate(args)
    expect(dispatch).toHaveBeenCalledWith('addFact', expect.objectContaining({
      familyId: 'fam_001', predicate: '拥有保障', confidence: 0.9
    }), 'op_test')
    expect(r.toolResults).toHaveLength(1)
    expect(r.toolResults[0]).toMatchObject({ toolName: 'addFact', success: true })
    // 成功回流：cleanText = B 基于工具结果生成的最终回复（含 summary 句回流）
    expect(mockSafeCallChat).toHaveBeenCalled()
    expect(r.cleanText).toBe('已为您记录事实：拥有保障-重疾险（高置信）。')
    // 数据变更后失效缓存
    expect(args.ctxCache.invalidate).toHaveBeenCalledWith('fam_001:op_test')
  })

  test('dispatch 失败 → P2.5 失败回流 AI 再生成（错误解释覆盖模板）', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'addFact', arguments: '{"predicate":"备注","objectValue":"x"}' }
      }]
    })
    mockSafeCallChat.mockResolvedValue({ text: '抱歉，记录失败，原因是 DB down。请稍后重试。' })
    const dispatch = jest.fn().mockRejectedValue(new Error('DB down'))
    const args = makeBaseArgs({ dispatch })
    const r = await orchestrate(args)
    expect(r.toolResults[0].success).toBe(false)
    expect(r.toolResults[0].error).toBe('DB down')
    // P2.5 回流：cleanText = 再生成文本
    expect(r.cleanText).toBe('抱歉，记录失败，原因是 DB down。请稍后重试。')
    // 再生成消息含 tool 结果（失败详情 JSON）
    const refineMsgs = mockSafeCallChat.mock.calls[0][0]
    const toolMsg = refineMsgs.find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(JSON.parse(toolMsg.content).error).toBe('DB down')
  })

  test('P2.5 再生成失败 → 回退模板拼接（不抛异常）', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'addFact', arguments: '{"predicate":"备注","objectValue":"x"}' }
      }]
    })
    mockSafeCallChat.mockRejectedValue(new Error('timeout'))
    const dispatch = jest.fn().mockRejectedValue(new Error('DB down'))
    const args = makeBaseArgs({ dispatch })
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('AI 回复')
    expect(r.toolResults[0].success).toBe(false)
  })

  test('L3 参数校验失败 → 不调 dispatch，P2.5 回流 AI 修正', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'addFact', arguments: '{"predicate":"拥有保障","objectValue":"重疾险"}' }
      }]
    })
    mockSafeCallChat.mockResolvedValue({ text: '缺少必填字段 subjectName，请补充后重试。' })
    // 带 parameters 定义的 addFact（subjectName 必填）；userText 命中事实意图保证 addFact 留在候选集
    const toolDefs = [{
      function: {
        name: 'addFact',
        parameters: {
          type: 'object',
          properties: {
            predicate: { type: 'string', enum: ['拥有保障', '备注'] },
            objectValue: { type: 'string' },
            subjectName: { type: 'string' }
          },
          required: ['predicate', 'objectValue', 'subjectName']
        }
      }
    }]
    const dispatch = jest.fn()
    const args = makeBaseArgs({ dispatch, toolDefs, userText: '记一下谢敏职业' })
    const r = await orchestrate(args)
    expect(dispatch).not.toHaveBeenCalled()
    expect(r.toolResults[0].success).toBe(false)
    expect(r.toolResults[0].validation).toBe(true)
    expect(r.cleanText).toBe('缺少必填字段 subjectName，请补充后重试。')
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

  test('toolSummaries 中无对应工具 → summary 跳过该工具（unknownTool 成功回流失败回退模板）', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'unknownTool', arguments: '{}' }
      }]
    })
    // unknownTool 成功 → 触发成功回流；回流失败回退初始文本（aText 未传 → auditText）
    mockSafeCallChat.mockRejectedValue(new Error('refine down'))
    const dispatch = jest.fn().mockResolvedValue({ code: 200 })
    const args = makeBaseArgs({ dispatch, toolSummaries: {} })
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('初始审计文本')
  })
})

describe('orchestrate - intent 协议（v9.2：A 只出工具判定，B function calling 填参数）', () => {
  test('intent 只带 name（新协议）→ 工具预选 + function calling 填参数 + 成功回流', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'updateFinances', arguments: '{"annual_income":250000,"total_debt":200000}' }
      }]
    })
    // v9.3 成功回流：B 基于真实工具结果生成最终回复（覆盖 A 断言）
    mockSafeCallChat.mockResolvedValue({ text: '已为您更新家庭财务：年收入 25 万、负债 20 万。' })
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { ok: true } })
    const toolDefs = [{
      function: {
        name: 'updateFinances',
        parameters: {
          type: 'object',
          properties: { annual_income: { type: 'number' }, total_debt: { type: 'number' } }
        }
      }
    }]
    const args = makeBaseArgs({ dispatch, aText: '已为您更新', intent: [{ name: 'updateFinances' }], toolDefs })
    const r = await orchestrate(args)
    // 预选后只调 safeCallChatWithTools（B function calling），不再走 _dispatchIntentTools 直调
    expect(mockSafeCallChatWithTools).toHaveBeenCalled()
    // 工具 schema 预选：只传 updateFinances（intent 指定）
    const sentDefs = mockSafeCallChatWithTools.mock.calls[0][1]
    expect(sentDefs.map(d => (d.function ? d.function.name : d.name))).toEqual(['updateFinances'])
    // 参数由 B function calling 产出（schema 约束）
    expect(dispatch).toHaveBeenCalledWith('updateFinances', expect.objectContaining({ annual_income: 250000, total_debt: 200000, familyId: 'fam_001' }), 'op_test')
    expect(r.toolResults[0].success).toBe(true)
    // v9.3 成功回流：cleanText = B 基于工具结果生成的最终回复（而非 A 断言）
    expect(mockSafeCallChat).toHaveBeenCalled()
    expect(r.cleanText).toBe('已为您更新家庭财务：年收入 25 万、负债 20 万。')
  })

  test('intent 只带 name + B 产出 toolCalls 为空 → 回退 A 文本（不覆盖）', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({ text: 'B 说点什么', toolCalls: [] })
    const args = makeBaseArgs({ aText: '已为您更新', intent: [{ name: 'updateFinances' }] })
    const r = await orchestrate(args)
    expect(r.toolResults).toEqual([])
    // 无工具调用 → cleanText 保持 A 断言（本轮未真实落库，A 文本原样）
    expect(r.cleanText).toBe('已为您更新')
  })

  test('成功回流排除 triggerAnalysis（fire-and-forget 不回流，保留 A 断言）', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'triggerAnalysis', arguments: '{}' }
      }]
    })
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { ok: true, triggered: true } })
    const toolDefs = [{
      function: { name: 'triggerAnalysis', parameters: { type: 'object', properties: {}, required: [] } }
    }]
    const args = makeBaseArgs({ dispatch, aText: '已触发分析', intent: [{ name: 'triggerAnalysis' }], toolDefs })
    const r = await orchestrate(args)
    expect(r.toolResults[0].success).toBe(true)
    // triggerAnalysis 在 REFLOW_SKIP 中 → 不回流，保留 A 断言
    expect(mockSafeCallChat).not.toHaveBeenCalled()
    expect(r.cleanText).toBe('已触发分析')
  })

  test('queryPolicies 成功 → 回流携带精简数据（B 可组织明细回复）', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'queryPolicies', arguments: '{}' }
      }]
    })
    mockSafeCallChat.mockResolvedValue({ text: '该家庭共 2 张保单：\n- 多倍保障重疾（李牧云，20万）\n- 康爱无忧（李阳勇，10万）' })
    const dispatch = jest.fn().mockResolvedValue({
      code: 200, data: { policies: [
        { product_name: '多倍保障', insurance_category: '重疾险', insured_name: '李牧云', sum_assured: 200000 },
        { product_name: '康爱无忧', insurance_category: '重疾险', insured_name: '李阳勇', sum_assured: 100000 }
      ] }
    })
    const toolDefs = [{ function: { name: 'queryPolicies', parameters: { type: 'object', properties: {} } } }]
    const args = makeBaseArgs({ dispatch, aText: '为您查询该家庭全部保单明细', intent: [{ name: 'queryPolicies' }], toolDefs })
    const r = await orchestrate(args)
    expect(r.toolResults[0].success).toBe(true)
    expect(mockSafeCallChat).toHaveBeenCalled()
    // 回流 tool 消息含查询结果数据（product/insured/sum 字段）
    const toolMsg = mockSafeCallChat.mock.calls[0][0].find(m => m.role === 'tool')
    expect(toolMsg.content).toContain('查询结果')
    expect(toolMsg.content).toContain('多倍保障')
    expect(r.cleanText).toBe('该家庭共 2 张保单：\n- 多倍保障重疾（李牧云，20万）\n- 康爱无忧（李阳勇，10万）')
  })

  test('成功回流失败 → 回退 A 断言文本（不抛异常）', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'updateFinances', arguments: '{"annual_income":250000}' }
      }]
    })
    mockSafeCallChat.mockRejectedValue(new Error('timeout'))
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { ok: true } })
    const toolDefs = [{
      function: {
        name: 'updateFinances',
        parameters: { type: 'object', properties: { annual_income: { type: 'number' } } }
      }
    }]
    const args = makeBaseArgs({ dispatch, aText: '已为您更新', intent: [{ name: 'updateFinances' }], toolDefs })
    const r = await orchestrate(args)
    expect(r.toolResults[0].success).toBe(true)
    // 回流失败 → 回退 A 断言
    expect(r.cleanText).toBe('已为您更新')
  })

  test('intent 带 args（旧协议兼容）→ 直接校验+执行，不走 function calling', async () => {
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { ok: true } })
    const args = makeBaseArgs({ dispatch, aText: '已为您更新', intent: [{ name: 'updateFinances', args: { annual_income: 250000 } }] })
    const r = await orchestrate(args)
    expect(mockSafeCallChatWithTools).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledWith('updateFinances', expect.objectContaining({ annual_income: 250000, familyId: 'fam_001' }), 'op_test')
    expect(r.toolResults[0].success).toBe(true)
    expect(r.cleanText).toBe('已为您更新')
  })

  test('intent 带 args 但参数校验失败 → 不调 dispatch，返回 validation 失败', async () => {
    // 带必填 subjectName 的 addFact schema
    const toolDefs = [{
      function: {
        name: 'addFact',
        parameters: {
          type: 'object',
          properties: { predicate: { type: 'string' }, objectValue: { type: 'string' }, subjectName: { type: 'string' } },
          required: ['predicate', 'objectValue', 'subjectName']
        }
      }
    }]
    const dispatch = jest.fn()
    const args = makeBaseArgs({ dispatch, toolDefs, aText: '已记录', intent: [{ name: 'addFact', args: { predicate: '职业', objectValue: '教师' } }] })
    const r = await orchestrate(args)
    expect(dispatch).not.toHaveBeenCalled()
    expect(r.toolResults[0].success).toBe(false)
    expect(r.toolResults[0].validation).toBe(true)
  })

  test('intent 带 args 执行失败 → P2.5 失败回流覆盖 A 断言文本', async () => {
    mockSafeCallChat.mockResolvedValue({ text: '抱歉，保存失败：成员不存在。请确认成员姓名。' })
    const dispatch = jest.fn().mockRejectedValue(new Error('member not found'))
    const args = makeBaseArgs({ dispatch, aText: '已为您更新', intent: [{ name: 'addFact', args: { predicate: '职业', objectValue: '教师', subjectName: '谢敏' } }] })
    const r = await orchestrate(args)
    expect(r.toolResults[0].success).toBe(false)
    expect(r.cleanText).toBe('抱歉，保存失败：成员不存在。请确认成员姓名。')
  })

  test('intent 为空 → 回退 function calling（safeCallChatWithTools 被调用，全量 schema）', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({ text: 'AI 回复', toolCalls: [] })
    const args = makeBaseArgs({ intent: [] })
    const r = await orchestrate(args)
    expect(mockSafeCallChatWithTools).toHaveBeenCalled()
    expect(r.toolResults).toEqual([])
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
