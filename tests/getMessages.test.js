/**
 * queryMessages 云函数单元测试
 * 测试：参数校验、分页查询、mode=latest、before 分页、失败分支
 * （原 getMessages 已重命名为 queryMessages；生产链式调用 where(...).orderBy(...).limit(...).get()）
 */

var mockMessages = []
var mockQueryError = null // 2026-09-11 全面审计 P1-1：查询失败开关（验证"读失败不返回空集"）

jest.mock('wx-server-sdk', function() {
  // 链式 mock：where → orderBy → limit → get；where 也直接接 get（无 orderBy 路径）
  var buildChain = function() {
    var chain = {
      get: jest.fn(function() {
        if (mockQueryError) return Promise.reject(new Error(mockQueryError))
        return Promise.resolve({ data: mockMessages.slice() })
      })
    }
    chain.limit = jest.fn(function() { return chain })
    chain.orderBy = jest.fn(function() { return chain })
    chain.where = jest.fn(function() { return chain })
    chain.field = jest.fn(function() { return chain })
    return chain
  }
  var mockDb = {
    collection: jest.fn(function() { return buildChain() }),
    command: { lt: jest.fn(function(v) { return { $lt: v } }) }
  }
  return {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockDb }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid', APPID: 'mock_appid' } })
  }
})

var dataQuery = require('../cloudfunctions/dataQuery/index')

describe('queryMessages (via dataQuery) 云函数', function() {

  beforeEach(function() {
    mockMessages = []
    mockQueryError = null
  })

  test('缺少 familyId 返回 400', function() {
    return dataQuery.main({ action: 'queryMessages' }).then(function(res) {
      expect(res.code).toBe(400)
      expect(res.msg).toContain('familyId')
    })
  })

  test('mode=latest 获取最近消息', function() {
    mockMessages = [
      { role: 'user', content: '你好', timestamp: 1 },
      { role: 'assistant', content: '你好，有什么可以帮您', timestamp: 2 }
    ]
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001', mode: 'latest', limit: 5 }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.messages.length).toBe(2)
    })
  })

  test('before 分页获取', function() {
    mockMessages = [
      { role: 'assistant', content: '之前消息', timestamp: 100 }
    ]
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001', before: '2026-05-01T00:00:00Z', limit: 10 }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.messages.length).toBe(1)
    })
  })

  test('全量获取（无 mode 和 before）', function() {
    mockMessages = [
      { role: 'user', content: 'm1', timestamp: 1 },
      { role: 'assistant', content: 'm2', timestamp: 2 }
    ]
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.messages.length).toBe(2)
    })
  })

  test('空结果返回空数组', function() {
    mockMessages = []
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.messages).toEqual([])
    })
  })

  // 回归：历史消息恢复确认卡（2026-08-29 线上缺失——queryMessages 漏映射 pending_confirms，
  // 导致重新进入对话看不到历史确认卡；history-store 依赖该字段渲染 pendingConfirms）
  test('返回消息保留 pending_confirms（确认卡历史恢复）', function() {
    const pc = [
      { pendingId: 'write_updateFinances_abc123', action: 'CONFIRM', type: 'write_confirm', toolName: 'updateFinances', summary: '年收入:350,000元', target: '家庭财务' },
      { pendingId: 'write_updateFinances_abc123', action: 'KEEP', type: 'write_confirm', toolName: 'updateFinances', summary: '年收入:350,000元', target: '家庭财务' }
    ]
    mockMessages = [
      { role: 'assistant', content: '已为您生成确认卡', pending_confirms: pc, timestamp: 3 }
    ]
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001', mode: 'latest' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.messages[0].pending_confirms).toEqual(pc)
      expect(res.data.messages[0].pending_confirms[0].action).toBe('CONFIRM')
    })
  })

  test('无确认卡的消息返回空数组', function() {
    mockMessages = [{ role: 'assistant', content: '普通回复', timestamp: 1 }]
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001', mode: 'latest' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.messages[0].pending_confirms).toEqual([])
    })
  })

  // P1-L1（2026-09-05）：undoOps 随消息回读——历史恢复撤销入口（此前白名单漏该键 → 按钮永不出现）
  test('返回消息保留 undoOps（历史恢复撤销按钮）', function() {
    mockMessages = [
      { role: 'assistant', content: '已更新家庭财务', undoOps: [{ opId: 'ud_1', summary: '已更新家庭财务', ttlSec: 300 }], timestamp: 4 }
    ]
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001', mode: 'latest' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.messages[0].undoOps).toEqual([{ opId: 'ud_1', summary: '已更新家庭财务', ttlSec: 300 }])
    })
  })

  // 2026-09-11 全面审计 P1-1：原实现带 `.catch(() => ({ data: [] }))`，
  // messages 查询失败被吞成"无历史"，用户以为对话记录丢失（与 policy-read 线上事故同根因）。
  // 修复后读失败必须传播 → 外层 wrapError 返回 500。
  test('messages 查询失败 → 返回 500，不再静默空数组', function() {
    mockQueryError = 'DB connection failed'
    return dataQuery.main({ action: 'queryMessages', familyId: 'fam_001' }).then(function(res) {
      expect(res.code).toBe(500)
      expect(res.data).toBeUndefined()
      expect(res.msg).toContain('失败')
    })
  })
})
