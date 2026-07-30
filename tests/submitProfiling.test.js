/**
 * submitProfiling handler — DB + AI mock 三层测试
 */
var mockStore = { families: [], facts: [], agent_logs: [], operation_logs: [] }

jest.mock('wx-server-sdk', function() {
  var mockDb = {
    collection: jest.fn(function(name) {
      var rows = mockStore[name] || []
      var q = function() { return {
        where: jest.fn(function() { return q() }),
        field: jest.fn(function() { return q() }),
        limit: jest.fn(function() { return q() }),
        get: jest.fn(function() { return Promise.resolve({ data: rows }) }),
        update: jest.fn(function() { return Promise.resolve({ stats: { updated: 1 } }) }),
        add: jest.fn(function(data) { var id = 'mock_' + Date.now(); rows.push({ _id: id, ...data }); return Promise.resolve({ _id: id }) }),
        doc: jest.fn(function(id) { return {
          get: jest.fn(function() { return Promise.resolve({ data: rows.find(function(r) { return r._id === id }) || null }) }),
          update: jest.fn(function() { return Promise.resolve({ stats: { updated: 1 } }) })
        }})
      }}
      return q()
    }),
    command: { neq: function(v) { return { $ne: v } }, push: function(v) { return { $push: v } }, serverDate: function() { return new Date('2026-01-01') } }
  }
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockDb }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid' } }),
    callFunction: jest.fn(function() { return Promise.resolve({ result: { code: 200 } }) })
  }
})

// Mock AI gateway — 返回空JSON，不实际调AI
jest.mock('../cloudfunctions/dataWrite/_shared/ai-gateway', function() {
  return {
    safeCallChat: jest.fn(function() {
      return Promise.resolve({ text: '{"members":[]}', usage: { total_tokens: 10 }, logId: null })
    }),
    safeCallThink: jest.fn()
  }
})

jest.mock('../cloudfunctions/dataWrite/_shared/ai-client', function() {
  return {
    callChat: jest.fn(function() {
      return Promise.resolve({ text: '{"members":[]}', usage: { total_tokens: 10 } })
    }),
    callAIWithRetry: jest.fn(function() {
      return Promise.resolve({ text: '{}', usage: {} })
    }),
    callHunyuan: jest.fn(function() {
      return Promise.resolve({ text: '{}', usage: {} })
    })
  }
})

jest.mock('../cloudfunctions/dataWrite/_shared/config', function() {
  return {
    AI_TIMEOUT: { OCR: 20000, CHAT: 30000 },
    COST_PER_1K: 0.004,
    UPDATE: { DEBOUNCE_MS: 300000 },
    SECURITY: { MAX_INPUT: 16000, RATE_LIMIT_WINDOW_MS: 60000, RATE_LIMIT_MAX: 60, CONTENT_AUDIT_TRUNCATE: 5000 },
    REPORT_THROTTLE_MS: 30000,
    REPORT_KEEP_VERSIONS: 3
  }
})

var dataWrite = require('../cloudfunctions/dataWrite/index')

describe('submitProfiling (mock DB+AI)', function() {
  beforeEach(function() {
    mockStore = { families: [], facts: [], agent_logs: [], operation_logs: [] }
  })

  test('缺少 familyId 返回 400', function() {
    return dataWrite.main({ action: 'submitProfiling' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('缺少 members 返回 400', function() {
    return dataWrite.main({ action: 'submitProfiling', familyId: 'f1' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('提交标准字段返回 200', function() {
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', members: [{ member_id: 'm1', name: '张三' }], engagement_stage: 'profiling' })
    return dataWrite.main({
      action: 'submitProfiling', familyId: 'f1',
      members: [{ memberId: 'm1', name: '张三', standardFields: [{ key: 'gender', value: '男' }] }]
    }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.standardWritten).toBe(1)
    })
  })
})
