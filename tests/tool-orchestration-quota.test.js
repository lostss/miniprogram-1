/**
 * 直连通道的月度配额预检 — 2026-09-28 dsh 会话复审（审计项②）
 *
 * 事故形态：`_recordDirectUsage` 只**事后记账**，而 phase1 直连是对话**最高频**路径 ——
 * trial 的 30000 token 用满后照样无限对话（只有落到通道 2 的请求才会被网关拦下）。
 *
 * 本套件**真实调用** `_callPhase1`（不是源码文本断言）：断言配额耗尽时直连函数
 * **一次都没被调用**，且结果来自通道 2（ai-gateway，那里必查配额）。
 */
jest.mock('wx-server-sdk', () => ({ init: jest.fn(), database: () => ({}), DYNAMIC_CURRENT_ENV: 'env-mock' }), { virtual: true })

const mockDirect = jest.fn()
const mockGateway = jest.fn()
jest.mock('../cloudfunctions/conversationAI/_shared/ai-client', () => ({
  callChatWithTools: jest.fn(),
  callChatWithToolsDirect: (...args) => mockDirect(...args)
}))
jest.mock('../cloudfunctions/conversationAI/_shared/ai-gateway', () => ({
  safeCallChatWithTools: (...args) => mockGateway(...args)
}))
jest.mock('../cloudfunctions/conversationAI/_shared/ai-accounting', () => ({
  recordAIUsage: jest.fn().mockResolvedValue('log_x'),
  calcTokenUsage: jest.fn(() => ({ input: 0, output: 0, total: 0, cost: 0, currency: 'CNY' })),
  bumpAgentTokens: jest.fn()
}))

const mockQuota = jest.fn()
jest.mock('../cloudfunctions/conversationAI/_shared/guard', () => ({
  checkMonthlyQuota: (...args) => mockQuota(...args)
}))

const { _callPhase1, _directQuotaAllowed } = require('../cloudfunctions/conversationAI/tool-orchestration')

const CTX = { openid: 'o1', familyId: 'f1' }
const MSGS = [{ role: 'user', content: '帮我看下缺口' }]
const DEFS = []

describe('_callPhase1 直连前的月度配额预检', () => {
  beforeEach(() => {
    mockDirect.mockReset()
    mockGateway.mockReset()
    mockQuota.mockReset()
  })

  test('配额耗尽 → 直连一次都不调用，结果来自通道 2（网关会拦并给出可操作原因）', async () => {
    mockQuota.mockResolvedValue({ allowed: false, reason: '本月 AI 用量已达上限' })
    mockGateway.mockResolvedValue({ text: '本月 AI 用量已达上限', toolCalls: [], usage: {}, blocked: { code: 'QUOTA_LIMIT' } })
    const r = await _callPhase1(MSGS, DEFS, CTX, 'sid1')
    expect(mockDirect).not.toHaveBeenCalled()
    expect(mockGateway).toHaveBeenCalledTimes(1)
    expect(r.blocked.code).toBe('QUOTA_LIMIT')
  })

  test('配额允许 → 正常走直连，不触碰通道 2', async () => {
    mockQuota.mockResolvedValue({ allowed: true })
    const direct = { text: '直连结果', toolCalls: [{ id: 't1', type: 'function', function: { name: 'queryPolicies', arguments: '{}' } }], usage: {} }
    mockDirect.mockResolvedValue(direct)
    const r = await _callPhase1(MSGS, DEFS, CTX, 'sid2')
    expect(r).toBe(direct)
    expect(mockGateway).not.toHaveBeenCalled()
  })

  test('预检自身失败（DB 异常）→ 放行，不阻断对话', async () => {
    mockQuota.mockRejectedValue(new Error('db down'))
    mockDirect.mockResolvedValue({ text: 'x', toolCalls: [{ id: 't1', type: 'function', function: { name: 'queryFacts', arguments: '{}' } }], usage: {} })
    await _callPhase1(MSGS, DEFS, CTX, 'sid3')
    expect(mockDirect).toHaveBeenCalledTimes(1)
    expect(mockGateway).not.toHaveBeenCalled()
  })

  test('_directQuotaAllowed：仅显式 allowed===false 视为耗尽（缺字段/未建档一致放行）', async () => {
    mockQuota.mockResolvedValue({})
    expect((await _directQuotaAllowed(CTX)).allowed).toBe(true)
    mockQuota.mockResolvedValue({ allowed: true })
    expect((await _directQuotaAllowed(CTX)).allowed).toBe(true)
    mockQuota.mockResolvedValue({ allowed: false, reason: 'R' })
    const r = await _directQuotaAllowed(CTX)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('R')
  })
})
