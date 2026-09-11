/**
 * tool-orchestration 测试（单通道 v10，2026-08-29 改造）
 *
 * 覆盖：空输入、无 toolCalls、写入类工具确认卡（write_confirm）、addFact 免确认、
 *       summary 拼接、429 退避、AI 失败降级、policyFactSplitter 集成
 *
 * 单通道语义（相对 v9 双通道的变化）：
 *   - 无 intent/aText 协议参数；AI 一次 function calling 一步到位
 *   - 写入成员/财务/保单/新建家庭类工具 → 不 dispatch，返回 pending_confirms（write_confirm）
 *   - addFact → 免确认直接 dispatch + 回流
 *   - 无 toolCalls → cleanText = phase1.text（不再退化为 auditText）
 */
jest.mock('wx-server-sdk', () => ({ database: () => ({}) }), { virtual: true })

// mock ai-client / ai-gateway，让 orchestrate 的 AI 调用可控
const mockCallChatWithTools = jest.fn()
const mockSafeCallChatWithTools = jest.fn()
const mockCallChat = jest.fn()
const mockSafeCallChat = jest.fn()
const mockCallChatWithToolsDirect = jest.fn()
jest.mock('../cloudfunctions/conversationAI/_shared/ai-client', () => ({
  callChatWithTools: (...args) => mockCallChatWithTools(...args),
  callChatWithToolsDirect: (...args) => mockCallChatWithToolsDirect(...args),
  callChat: (...args) => mockCallChat(...args)
}))
jest.mock('../cloudfunctions/conversationAI/_shared/ai-gateway', () => ({
  safeCallChatWithTools: (...args) => mockSafeCallChatWithTools(...args),
  safeCallChat: (...args) => mockSafeCallChat(...args)
}))
// ② 默认执行+撤销：mock undo-store 与快照层，让 A 类工具执行可控
const mockCreateUndo = jest.fn().mockResolvedValue('ud_test')
jest.mock('../cloudfunctions/conversationAI/undo-store', () => ({
  createUndo: (...args) => mockCreateUndo(...args),
  findPending: jest.fn(),
  updateStatus: jest.fn()
}))
jest.mock('../cloudfunctions/conversationAI/_shared/memberRepo', () => ({
  snapshotFinance: jest.fn().mockResolvedValue({ _id: 'fin_1', annual_income: 100000 }),
  snapshotMember: jest.fn().mockResolvedValue({ _id: 'mem_1', member_id: 'mem_1', name: '张三', age: 30 }),
  restoreFinance: jest.fn().mockResolvedValue({ code: 200 }),
  restoreMember: jest.fn().mockResolvedValue({ code: 200 })
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
    // P2-L1：生产路径（index.js 传入）stateCache 才是状态块失效目标——fixture 补 stateCache 使断言覆盖生产路径
    stateCache: { get: jest.fn().mockReturnValue(null), invalidate: jest.fn() },
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

describe('orchestrate - 无 toolCalls（纯问答）', () => {
  test('无 toolCalls → cleanText = phase1.text', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({ text: 'AI 回复', toolCalls: [] })
    const args = makeBaseArgs()
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('AI 回复')
    expect(r.toolResults).toEqual([])
    expect(args.dispatch).not.toHaveBeenCalled()
  })

  test('phase1.text 为空 → cleanText 为空字符串', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({ text: '', toolCalls: [] })
    const args = makeBaseArgs()
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('')
  })

  test('context 从 ctxCache 取', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({ text: 'ok', toolCalls: [] })
    const args = makeBaseArgs()
    await orchestrate(args)
    expect(args.ctxCache.get).toHaveBeenCalledWith('fam_001:op_test')
  })
})

describe('orchestrate - addFact（免确认直接执行）', () => {
  test('addFact 成功 → dispatch + toolResults + 成功回流', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'addFact', arguments: '{"predicate":"拥有保障","objectValue":"重疾险","confidence":0.9}' }
      }]
    })
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { factId: 'f1' } })
    // 成功回流：写类工具成功 → 工具结果回流生成最终回复
    mockSafeCallChat.mockResolvedValue({ text: '已为您记录事实：拥有保障-重疾险（高置信）。' })
    const args = makeBaseArgs({ dispatch })
    const r = await orchestrate(args)
    expect(dispatch).toHaveBeenCalledWith('addFact', expect.objectContaining({
      familyId: 'fam_001', predicate: '拥有保障', confidence: 0.9
    }), 'op_test')
    // addFact 免确认：无 write_confirm 确认卡
    expect(r.pending_confirms).toEqual([])
    expect(r.toolResults).toHaveLength(1)
    expect(r.toolResults[0]).toMatchObject({ toolName: 'addFact', success: true })
    expect(mockSafeCallChat).toHaveBeenCalled()
    expect(r.cleanText).toBe('已为您记录事实：拥有保障-重疾险（高置信）。')
    expect(args.stateCache.invalidate).toHaveBeenCalledWith('state:fam_001:op_test')
  })

  test('addFact 低置信度 → 默认执行+撤销（② 不再弹确认卡，undo 兜底）', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'addFact', arguments: '{"predicate":"备注","objectValue":"想加保","confidence":0.3}' }
      }]
    })
    mockSafeCallChat.mockResolvedValue({ text: '已记录备注：想加保。' })
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { factId: 'f_pending' } })
    const args = makeBaseArgs({ dispatch })
    const r = await orchestrate(args)
    // 无确认卡/无建议，直接执行并携带 undo
    expect(r.suggestions).toEqual([])
    expect(r.pending_confirms).toEqual([])
    expect(r.toolResults).toHaveLength(1)
    expect(r.toolResults[0].undo).toMatchObject({ opId: 'ud_test' })
    expect(r.cleanText).toBe('已记录备注：想加保。')
  })

  test('addFact dispatch 失败 → P2.5 失败回流 AI 再生成', async () => {
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
    expect(r.cleanText).toBe('抱歉，记录失败，原因是 DB down。请稍后重试。')
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
})

describe('orchestrate - A 类默认执行+撤销 / B 类确认卡（② 2026-08-30）', () => {
  function financeToolCall() {
    return {
      text: '已为您更新家庭财务',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'updateFinances', arguments: '{"annual_income":250000,"total_debt":200000}' }
      }]
    }
  }

  test('updateFinances（A 类）→ 默认执行：dispatch + undo，无确认卡', async () => {
    mockSafeCallChatWithTools.mockResolvedValue(financeToolCall())
    mockSafeCallChat.mockResolvedValue({ text: '已更新家庭年收入为 25 万。' })
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { action: 'updated' } })
    const toolDefs = [{
      function: {
        name: 'updateFinances',
        parameters: {
          type: 'object',
          properties: { annual_income: { type: 'number' }, total_debt: { type: 'number' } }
        }
      }
    }]
    const args = makeBaseArgs({ dispatch, toolDefs })
    const r = await orchestrate(args)
    // 默认执行：dispatch 调用 + 无确认卡
    expect(dispatch).toHaveBeenCalledWith('updateFinances', expect.objectContaining({ annual_income: 250000, total_debt: 200000, familyId: 'fam_001' }), 'op_test')
    expect(r.pending_confirms).toEqual([])
    expect(r.suggestions).toEqual([])
    expect(r.toolResults).toHaveLength(1)
    expect(r.toolResults[0]).toMatchObject({ toolName: 'updateFinances', success: true, undo: { opId: 'ud_test' } })
    // 成功回流生成最终回复
    expect(r.cleanText).toBe('已更新家庭年收入为 25 万。')
    expect(args.stateCache.invalidate).toHaveBeenCalledWith('state:fam_001:op_test')
  })

  test('upsertMember（A 类）→ 默认执行：dispatch + undo', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'OK',
      toolCalls: [{ type: 'function', id: 'tc_1', function: { name: 'upsertMember', arguments: '{"memberName":"张三","data":{"age":40}}' } }]
    })
    mockSafeCallChat.mockResolvedValue({ text: '已更新成员张三。' })
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { memberId: 'mem_1', action: 'updated' } })
    const toolDefs = [{
      function: { name: 'upsertMember', parameters: { type: 'object', properties: { memberName: { type: 'string' }, data: { type: 'object' } } } }
    }]
    const args = makeBaseArgs({ dispatch, toolDefs })
    const r = await orchestrate(args)
    expect(dispatch).toHaveBeenCalledWith('upsertMember', expect.objectContaining({ memberName: '张三', familyId: 'fam_001' }), 'op_test')
    expect(r.pending_confirms).toEqual([])
    expect(r.toolResults[0].undo).toMatchObject({ opId: 'ud_test' })
  })

  test('addPolicy / updatePolicy / createFamily（B 类）→ 仍走确认卡', async () => {
    const cases = [
      { name: 'addPolicy', args: '{"product_name":"康宁","sum_assured":500000,"insured_name":"张三"}' },
      { name: 'updatePolicy', args: '{"product_name":"康宁","data":{"sum_assured":600000}}' },
      { name: 'createFamily', args: '{"family_name":"李四家庭"}' }
    ]
    for (const c of cases) {
      mockSafeCallChatWithTools.mockResolvedValue({
        text: 'OK',
        toolCalls: [{ type: 'function', id: 'tc_x', function: { name: c.name, arguments: c.args } }]
      })
      const dispatch = jest.fn()
      const r = await orchestrate(makeBaseArgs({ dispatch }))
      expect(dispatch).not.toHaveBeenCalled()
      expect(r.pending_confirms).toHaveLength(2)
      expect(r.pending_confirms[0].toolName).toBe(c.name)
      expect(r.pending_confirms[0].type).toBe('write_confirm')
      expect(r.pending_confirms[1]).toMatchObject({ action: 'KEEP', type: 'write_confirm' })
    }
  })

  test('A 类默认执行 + B 类确认卡混合', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: '安排中',
      toolCalls: [
        { type: 'function', id: 'tc_1', function: { name: 'updateFinances', arguments: '{"annual_income":300000}' } },
        { type: 'function', id: 'tc_2', function: { name: 'addPolicy', arguments: '{"product_name":"康宁","insured_name":"张三"}' } }
      ]
    })
    mockSafeCallChat.mockResolvedValue({ text: '已更新家庭财务。' })
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { action: 'updated' } })
    const toolDefs = [
      { function: { name: 'updateFinances', parameters: { type: 'object', properties: {} } } },
      { function: { name: 'addPolicy', parameters: { type: 'object', properties: {} } } }
    ]
    const args = makeBaseArgs({ dispatch, toolDefs })
    const r = await orchestrate(args)
    // updateFinances 已默认执行（含 undo）
    expect(dispatch).toHaveBeenCalledWith('updateFinances', expect.objectContaining({ familyId: 'fam_001' }), 'op_test')
    expect(r.toolResults).toHaveLength(1)
    expect(r.toolResults[0].undo).toBeDefined()
    // addPolicy 进确认卡
    const wc = r.pending_confirms.filter(pc => pc.type === 'write_confirm' && pc.action === 'CONFIRM')
    expect(wc).toHaveLength(1)
    expect(wc[0].toolName).toBe('addPolicy')
  })
})

describe('orchestrate - 查询类/触发类工具（直接执行 + 回流）', () => {
  test('queryPolicies 成功 → 回流携带精简数据', async () => {
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
    const args = makeBaseArgs({ dispatch, toolDefs })
    const r = await orchestrate(args)
    expect(r.toolResults[0].success).toBe(true)
    expect(mockSafeCallChat).toHaveBeenCalled()
    const toolMsg = mockSafeCallChat.mock.calls[0][0].find(m => m.role === 'tool')
    expect(toolMsg.content).toContain('查询结果')
    expect(toolMsg.content).toContain('多倍保障')
    expect(r.cleanText).toBe('该家庭共 2 张保单：\n- 多倍保障重疾（李牧云，20万）\n- 康爱无忧（李阳勇，10万）')
  })

  test('triggerAnalysis → 直接执行，不回流（REFLOW_SKIP），cleanText = phase1 文本', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: '已触发分析',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'triggerAnalysis', arguments: '{}' }
      }]
    })
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { ok: true, triggered: true } })
    const toolDefs = [{ function: { name: 'triggerAnalysis', parameters: { type: 'object', properties: {}, required: [] } } }]
    const args = makeBaseArgs({ dispatch, toolDefs })
    const r = await orchestrate(args)
    expect(r.toolResults[0].success).toBe(true)
    expect(mockSafeCallChat).not.toHaveBeenCalled()
    expect(r.cleanText).toBe('已触发分析')
  })

  test('toolSummaries 中无对应工具 → summary 跳过该工具（回流失败回退 phase1 文本）', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({
      text: 'AI 回复',
      toolCalls: [{
        type: 'function',
        id: 'tc_1',
        function: { name: 'unknownTool', arguments: '{}' }
      }]
    })
    mockSafeCallChat.mockRejectedValue(new Error('refine down'))
    const dispatch = jest.fn().mockResolvedValue({ code: 200 })
    const args = makeBaseArgs({ dispatch, toolSummaries: {} })
    const r = await orchestrate(args)
    // 回流失败 → 回退 phase1 文本（不再有 A 断言）
    expect(r.cleanText).toBe('AI 回复')
  })
})

describe('orchestrate - 429 退避', () => {
  test('首次 429 → 重试成功（重试后无 toolCalls，cleanText = phase1.text）', async () => {
    const err429 = new Error('429 Too Many Requests')
    mockSafeCallChatWithTools
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce({ text: '重试成功', toolCalls: [] })
    const args = makeBaseArgs()
    const r = await orchestrate(args)
    expect(r.cleanText).toBe('重试成功')
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

  test('userText 非保障陈述（问候/收入）→ coverageHint 不注入', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({ text: 'ok', toolCalls: [] })
    const args = makeBaseArgs({ userText: '家庭连收入25万' })
    await orchestrate(args)
    const systemContent = mockSafeCallChatWithTools.mock.calls[0][0][0].content
    expect(systemContent).not.toContain('规则预提取的保障')
  })
})

describe('orchestrate - 写声称但无 toolCalls（P2-D 假更新防御）', () => {
  // 线上实测（2026-08-29）：hy3 对"修改家庭收入"未调 updateFinances，却回复
  // "已为您安排更新…(系统将展示确认卡,您确认后正式写入)" → toolResults=[] 无确认卡，
  // 代理人以为已修改实际未写入。本组用例覆盖：写声称 + 无工具调用 → 强指令重试兜底。
  test('声称已安排修改但未调工具 → 强指令重试成功 → 生成确认卡', async () => {
    // 主通道直连（①）：写声称但无 tool_calls
    mockCallChatWithToolsDirect.mockResolvedValueOnce({
      text: '已为您安排更新:家庭年收入由 **5万** 调整为 **35万**。\n\n(系统将展示确认卡,您确认后正式写入。)',
      toolCalls: []
    })
    // 强指令重试（_retryForceToolCall 通道1直连）：正常输出 updateFinances 工具调用
    mockCallChatWithToolsDirect.mockResolvedValueOnce({
      text: '安排中',
      toolCalls: [{ type: 'function', id: 'tc_r', function: { name: 'updateFinances', arguments: '{"annual_income":350000}' } }]
    })
    const dispatch = jest.fn().mockResolvedValue({ code: 200, data: { action: 'updated' } })
    mockSafeCallChat.mockResolvedValue({ text: '已更新家庭年收入为 35 万。' })
    const args = makeBaseArgs({ userText: '修改家庭收入为35万', dispatch })
    const r = await orchestrate(args)
    // phase1 直连 1 次 + 强指令重试直连 1 次
    expect(mockCallChatWithToolsDirect).toHaveBeenCalledTimes(2)
    // 第 2 次（重试）system 消息含强制提示
    const retrySystem = mockCallChatWithToolsDirect.mock.calls[1][0][0].content
    expect(retrySystem).toContain('必须调用对应工具')
    // 重试返回工具调用 → updateFinances 默认执行（②）：dispatch + undo，无确认卡
    expect(dispatch).toHaveBeenCalledWith('updateFinances', expect.objectContaining({ annual_income: 350000, familyId: 'fam_001' }), 'op_test')
    expect(r.pending_confirms).toEqual([])
    expect(r.toolResults).toHaveLength(1)
    expect(r.toolResults[0].undo).toMatchObject({ opId: 'ud_test' })
  })

  test('声称已修改 + 直连与 hy3 重试均无工具调用 → 诚实失败提示，不生成确认卡', async () => {
    const fake = {
      text: '已为您安排更新:家庭年收入调整为35万。\n\n(系统将展示确认卡,您确认后正式写入。)',
      toolCalls: []
    }
    // phase1 直连：写声称无工具
    mockCallChatWithToolsDirect.mockResolvedValueOnce(fake)
    // 强指令重试通道1（直连）：仍无工具
    mockCallChatWithToolsDirect.mockResolvedValueOnce({ text: '抱歉，我无法直接修改数据。', toolCalls: [] })
    // 强指令重试通道2（hy3）：也无工具
    mockSafeCallChatWithTools.mockResolvedValue({ text: '抱歉，无法修改。', toolCalls: [] })
    const args = makeBaseArgs({ userText: '修改家庭收入为35万' })
    const r = await orchestrate(args)
    // phase1 直连 1 次 + 重试直连 1 次
    expect(mockCallChatWithToolsDirect).toHaveBeenCalledTimes(2)
    expect(r.cleanText).toContain('未能完成')
    expect(r.pending_confirms).toEqual([])
    expect(r.toolResults).toEqual([])
  })

  test('纯问答（无写声称）→ 不触发重试，正常返回', async () => {
    mockSafeCallChatWithTools.mockResolvedValue({ text: '当前家庭年收入为25万元，由李阳勇承担。', toolCalls: [] })
    const args = makeBaseArgs({ userText: '我们家的收入是多少' })
    const r = await orchestrate(args)
    expect(mockSafeCallChatWithTools).toHaveBeenCalledTimes(1)
    expect(r.cleanText).toContain('25万')
    expect(r.pending_confirms).toEqual([])
  })
})
