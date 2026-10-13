/**
 * ai-accounting 测试（架构审查候选 3）
 *
 * 被测对象：cloudfunctions/_shared/ai-accounting.js —— AI 用量记账唯一事实源
 *   calcTokenUsage  定价（原 ai-gateway 内联，纯搬运）
 *   bumpAgentTokens 配额累加（原 ai-gateway 内联，纯搬运）
 *   recordAIUsage   组合：算价 → 按状态计配额 → 写 agent_logs
 *
 * 为什么单独测：此前「算价→计配额→写日志」在 ai-gateway 与直连通道各写一遍、靠人工对齐口径，
 * 2026-09-12 才发现直连既不写 agent_logs 也不计配额（对话最高频 → 最大漏账口）。
 * 现该序列只有一个实现，本文件是它的行为护栏；tool-orchestration.test.js 只断言"委托参数正确"。
 *
 * 关键不变量：
 *   1. cost 必须与 currency 同时落库 —— hy3 是 USD、deepseek-* 是 CNY，缺 currency 时跨模型
 *      求和会静默把两种货币当同一种（config.PRICING 有专门警告，此前 currency 算了却没入库）。
 *   2. 仅成功计入配额，但**失败也写日志留痕**（失败调用已消耗输入 token，不记则成本系统性低估）。
 */
jest.mock('wx-server-sdk', () => ({
  init: jest.fn(),
  database: () => ({}),
  DYNAMIC_CURRENT_ENV: 'env-mock'
}), { virtual: true })

const { makeMemoryDb } = require('./helpers/memory-db')
const { calcTokenUsage, bumpAgentTokens, recordAIUsage } = require('../cloudfunctions/_shared/ai-accounting')

describe('calcTokenUsage — 分模型定价', () => {
  test('命中 PRICING：拆「输入未命中 / 缓存命中 / 输出」三段，并带 currency', () => {
    // deepseek-flash: in 1 / out 4（元每百万）
    const t = calcTokenUsage({ prompt_tokens: 1000000, completion_tokens: 1000000 }, 'deepseek-flash')
    expect(t).toMatchObject({ input: 1000000, output: 1000000, total: 2000000, cost: 5, currency: 'CNY' })
  })

  test('缓存命中部分按缓存价计（0.02 vs 1，差 50 倍，不能混算）', () => {
    const t = calcTokenUsage(
      { prompt_tokens: 1000000, prompt_cache_hit_tokens: 1000000, completion_tokens: 0 },
      'deepseek-flash'
    )
    expect(t.cost).toBeCloseTo(0.02, 6)
  })

  test('hy3 计价单位是美元（跨模型求和必须按 currency 分组）', () => {
    const t = calcTokenUsage({ prompt_tokens: 1000000, completion_tokens: 1000000 }, 'hy3')
    expect(t.cost).toBe(8)
    expect(t.currency).toBe('USD')
  })

  test('未命中模型回落 COST_PER_1K 旧口径（防存量看板断层）', () => {
    const t = calcTokenUsage({ prompt_tokens: 1000, completion_tokens: 1000 }, 'unknown-model')
    expect(t.cost).toBeCloseTo(0.008, 6)
    expect(t.currency).toBe('CNY')
  })

  test('usage 缺失/空对象安全（不产生 NaN）', () => {
    expect(calcTokenUsage({}, 'deepseek-flash')).toMatchObject({ input: 0, output: 0, total: 0, cost: 0 })
    expect(calcTokenUsage({ prompt_tokens: 10 }, 'deepseek-flash').total).toBe(10)
  })
})

describe('bumpAgentTokens — 用户月度配额', () => {
  // 2026-09-22 全面审计 P1-2：配额改为「按 quota_period 自然月判定」，累加前先按本月条件定位。
  const thisMonth = () => { const d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) }
  const lastMonth = () => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) }

  test('本月已建档：原子累加，只加不减', async () => {
    const store = { agents: [{ _id: 'a1', openid: 'o1', _openid: 'o1', token_used_monthly: 100, token_used_total: 500, quota_period: thisMonth() }] }
    await bumpAgentTokens(makeMemoryDb(store), 'o1', 50)
    expect(store.agents[0].token_used_monthly).toBe(150)
    expect(store.agents[0].token_used_total).toBe(550)
  })

  // 2026-09-22 全面审计 P1-2（契约锁定）：原实现只 _.inc、全仓无月度重置 → 上月用满的用户本月
  // 仍被 checkMonthlyQuota 以「本月已达上限」永久拒绝（且 message 说的『本月』永不到来）。
  // 存量文档（无 quota_period）同样走 reset 分支，从而自动解封历史被封用户。
  test('上月已建档 / 存量文档（无 quota_period）：本月计数重置为本次用量', async () => {
    const last = { agents: [{ _id: 'a1', openid: 'o1', _openid: 'o1', token_used_monthly: 30000, token_used_total: 30000, quota_period: lastMonth() }] }
    await bumpAgentTokens(makeMemoryDb(last), 'o1', 120)
    expect(last.agents[0].token_used_monthly).toBe(120)
    expect(last.agents[0].token_used_total).toBe(30120)   // 总量只加不减
    expect(last.agents[0].quota_period).toBe(thisMonth())

    const legacy = { agents: [{ _id: 'a2', openid: 'o2', _openid: 'o2', token_used_monthly: 99999, token_used_total: 99999 }] }
    await bumpAgentTokens(makeMemoryDb(legacy), 'o2', 30)
    expect(legacy.agents[0].token_used_monthly).toBe(30)
  })

  test('未建档：命中 0 条则补建文档（原实现静默丢弃 → 配额虚高）', async () => {
    const store = {}
    await bumpAgentTokens(makeMemoryDb(store), 'o2', 70)
    expect(store.agents).toHaveLength(1)
    expect(store.agents[0]).toMatchObject({ openid: 'o2', token_used_monthly: 70, token_used_total: 70 })
  })

  test('守卫：无 db / 无 openid / 非正数 → 静默不动作，不抛错', async () => {
    const store = {}
    const db = makeMemoryDb(store)
    await expect(bumpAgentTokens(null, 'o1', 10)).resolves.toBeUndefined()
    await expect(bumpAgentTokens(db, '', 10)).resolves.toBeUndefined()
    await expect(bumpAgentTokens(db, 'o1', 0)).resolves.toBeUndefined()
    expect(store.agents || []).toHaveLength(0)
  })
})

describe('recordAIUsage — 组合：算价 → 按状态计配额 → 写 agent_logs', () => {
  function storeWithAgent() {
    return { agents: [{ _id: 'a1', openid: 'o1', _openid: 'o1', token_used_monthly: 0, token_used_total: 0 }] }
  }

  test('成功调用：计配额 + 落库 tokens/cost/currency，返回 logId', async () => {
    const store = storeWithAgent()
    const logId = await recordAIUsage(makeMemoryDb(store), {
      openid: 'o1', familyId: 'f1', sessionId: 's1',
      action: 'conversation_tools', model: 'deepseek-flash',
      usage: { prompt_tokens: 1000000, completion_tokens: 1000000 }
    })

    expect(store.agents[0].token_used_monthly).toBe(2000000)
    expect(store.agent_logs).toHaveLength(1)
    expect(store.agent_logs[0]).toMatchObject({
      action: 'conversation_tools',
      model: 'deepseek-flash',
      status: 'success',
      family_id: 'f1',
      sessionId: 's1',
      cost: 5,
      currency: 'CNY'
    })
    expect(store.agent_logs[0].tokens).toMatchObject({ input: 1000000, output: 1000000, total: 2000000 })
    expect(typeof logId).toBe('string')
  })

  test('失败调用：不计配额，但仍写日志留痕（带已消耗 usage）', async () => {
    const store = storeWithAgent()
    await recordAIUsage(makeMemoryDb(store), {
      openid: 'o1', action: 'conversation_tools', model: 'deepseek-flash',
      usage: { prompt_tokens: 800 }, status: 'fail',
      error: { code: 'AI_CALL_FAIL', message: '直连超时' }
    })

    expect(store.agents[0].token_used_monthly).toBe(0)
    expect(store.agent_logs).toHaveLength(1)
    expect(store.agent_logs[0]).toMatchObject({ status: 'fail' })
    expect(store.agent_logs[0].error).toMatchObject({ code: 'AI_CALL_FAIL' })
    // 失败也记 tokens：否则失败调用的输入消耗被系统性丢弃，成本低估 + 异常率无据
    expect(store.agent_logs[0].tokens).toMatchObject({ total: 800 })
  })

  test('countQuota:false → 只写日志不计配额', async () => {
    const store = storeWithAgent()
    await recordAIUsage(makeMemoryDb(store), {
      openid: 'o1', action: 'blocked_probe', model: 'deepseek-flash',
      usage: { prompt_tokens: 100 }, countQuota: false
    })
    expect(store.agents[0].token_used_monthly).toBe(0)
    expect(store.agent_logs).toHaveLength(1)
  })

  test('skipLog:true → 只计配额不写日志（对齐 ai-gateway 的 ctx.skipLog）', async () => {
    const store = storeWithAgent()
    const logId = await recordAIUsage(makeMemoryDb(store), {
      openid: 'o1', action: 'conversation_tools', model: 'deepseek-flash',
      usage: { prompt_tokens: 1000000 }, skipLog: true
    })
    expect(store.agents[0].token_used_monthly).toBe(1000000)
    expect(store.agent_logs || []).toHaveLength(0)
    expect(logId).toBeNull()
  })

  test('缺 action → 不写日志（logAI 必填守卫），配额仍累计', async () => {
    const store = storeWithAgent()
    await recordAIUsage(makeMemoryDb(store), { openid: 'o1', model: 'deepseek-flash', usage: { prompt_tokens: 1000000 } })
    expect(store.agents[0].token_used_monthly).toBe(1000000)
    expect(store.agent_logs || []).toHaveLength(0)
  })

  test('hy3 调用日志带 USD 标记（两类货币必须可区分）', async () => {
    const store = storeWithAgent()
    await recordAIUsage(makeMemoryDb(store), {
      openid: 'o1', action: 'report_generate', model: 'hy3',
      usage: { prompt_tokens: 1000000, completion_tokens: 1000000 }
    })
    expect(store.agent_logs[0]).toMatchObject({ cost: 8, currency: 'USD' })
  })

  test('DB 不可用（logAI 内部吞咽）不抛错', async () => {
    await expect(recordAIUsage(null, {
      openid: 'o1', action: 'conversation_tools', model: 'deepseek-flash', usage: { prompt_tokens: 10 }
    })).resolves.toBeNull()
  })
})
