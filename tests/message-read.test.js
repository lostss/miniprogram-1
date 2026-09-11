/**
 * message-read 单元测试 — getFamilyHistory（append-only 增量记忆，2026-08-30）
 *
 * 覆盖：全量历史升序读取、after 压缩游标过滤、内部指令消息替换、limit、错误吞并返回 []
 */
const { getFamilyHistory, getLatestAssistantMsg } = require('../cloudfunctions/conversationAI/_shared/message-read')

function makeChain(data) {
  let whereArg = null
  const chain = {
    get: jest.fn(() => {
      let rows = data || []
      if (whereArg && whereArg.created_at && whereArg.created_at.$gt) {
        rows = rows.filter(r => new Date(r.created_at) > whereArg.created_at.$gt)
      }
      // 模拟 orderBy('created_at', 'desc')（真实 DB 行为），getFamilyHistory 内部 reverse 恢复升序
      rows = rows.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      return Promise.resolve({ data: rows })
    })
  }
  chain.limit = jest.fn(() => chain)
  chain.orderBy = jest.fn(() => chain)
  chain.where = jest.fn(w => { whereArg = w; return chain })
  return chain
}

function makeDb({ data, withCommand = true } = {}) {
  const chain = makeChain(data)
  const db = { collection: jest.fn(() => chain) }
  if (withCommand) db.command = { gt: jest.fn(v => ({ $gt: v })) }
  return db
}

const MSG = (role, content, created_at) => ({ role, content, created_at, _openid: 'op1', family_id: 'f1' })

describe('getFamilyHistory', () => {
  test('读全量历史，按 role 归一化 + content 截断 500', async () => {
    const db = makeDb({ data: [
      MSG('user', '你好', new Date('2026-01-01')),
      MSG('assistant', 'x'.repeat(900), new Date('2026-01-02'))
    ] })
    const hist = await getFamilyHistory(db, 'f1', 'op1')
    expect(hist).toHaveLength(2)
    expect(hist[0]).toEqual({ role: 'user', content: '你好' })
    expect(hist[1].role).toBe('assistant')
    expect(hist[1].content.length).toBe(500)
  })

  test('after 压缩游标 → 注入 created_at 条件 + 只读游标后消息', async () => {
    const db = makeDb({ data: [
      MSG('user', '压缩前旧消息', new Date('2026-01-01')),
      MSG('user', '压缩后新消息', new Date('2026-02-01'))
    ] })
    const hist = await getFamilyHistory(db, 'f1', 'op1', { after: new Date('2026-01-15') })
    expect(hist.map(h => h.content)).toEqual(['压缩后新消息'])
    const where = db.collection().where.mock.calls[0][0]
    expect(where.family_id).toBe('f1')
    expect(where._openid).toBe('op1')
    expect(where.created_at).toEqual({ $gt: new Date('2026-01-15') })
  })

  test('内部指令消息（CONFIRM/UNDO）替换为可读占位', async () => {
    const db = makeDb({ data: [
      MSG('user', '{CONFIRM:pc_1}', new Date('2026-01-01')),
      MSG('user', '{UNDO:ud_2}', new Date('2026-01-02')),
      MSG('user', '普通消息', new Date('2026-01-03'))
    ] })
    const hist = await getFamilyHistory(db, 'f1', 'op1')
    expect(hist[0].content).toBe('（用户操作了界面按钮）')
    expect(hist[1].content).toBe('（用户操作了界面按钮）')
    expect(hist[2].content).toBe('普通消息')
  })

  test('limit 传递 + desc 查询后反转（保最新）', async () => {
    const db = makeDb({ data: [
      MSG('user', 'old', new Date('2026-01-01')),
      MSG('user', 'new', new Date('2026-02-01'))
    ] })
    const hist = await getFamilyHistory(db, 'f1', 'op1', { limit: 800 })
    const chain = db.collection()
    expect(chain.orderBy).toHaveBeenCalledWith('created_at', 'desc')
    expect(chain.limit).toHaveBeenCalledWith(800)
    // 反转后仍按时间正序（old → new）
    expect(hist.map(h => h.content)).toEqual(['old', 'new'])
  })

  test('无 after → 不加 created_at 条件', async () => {
    const db = makeDb({ data: [] })
    await getFamilyHistory(db, 'f1', 'op1')
    const where = db.collection().where.mock.calls[0][0]
    expect(where.created_at).toBeUndefined()
  })

  test('读取失败 → 吞错返回 []（不阻断主流程）', async () => {
    const chain = { get: jest.fn(() => Promise.reject(new Error('db down'))) }
    chain.limit = jest.fn(() => chain)
    chain.orderBy = jest.fn(() => chain)
    chain.where = jest.fn(() => chain)
    const db = { collection: jest.fn(() => chain) }
    const hist = await getFamilyHistory(db, 'f1', 'op1')
    expect(hist).toEqual([])
  })
})

describe('getLatestAssistantMsg（回归）', () => {
  test('取最近 assistant 消息', async () => {
    const db = makeDb({ data: [{ role: 'assistant', content: '最近回复', suggestions: [] }] })
    const msg = await getLatestAssistantMsg(db, 'f1', 'op1')
    expect(msg).toMatchObject({ role: 'assistant', content: '最近回复' })
  })
})
