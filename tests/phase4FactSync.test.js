/**
 * Phase 4 回归测试：
 * - A1：表单事实 source 由 'user' 改为 'user_form'
 * - 高置信度 fact（健康/职业/收入，confidence≥0.8）反向同步回 members
 * 注意：CloudBase add/update 入参包在 { data: {...} } 中，存储记录为 { _id, data: {...} }
 */
var mockStore = { families: [], members: [], facts: [], agent_logs: [], operation_logs: [] }

function mockMakeDb() {
  return {
    collection: function (name) {
      var rows = mockStore[name] || (mockStore[name] = [])
      var api = {
        where: function () { return api },
        field: function () { return api },
        orderBy: function () { return api },
        limit: function () { return api },
        get: function () { return Promise.resolve({ data: rows }) },
        count: function () { return Promise.resolve({ total: rows.length }) },
        update: function () { return Promise.resolve({ stats: { updated: 1 } }) },
        remove: function () { return Promise.resolve({ stats: { removed: 1 } }) },
        add: function (payload) { var id = 'mock_' + Date.now() + Math.random(); var rec = Object.assign({ _id: id }, payload.data ? payload.data : payload); rows.push(rec); return Promise.resolve({ _id: id }) },
        doc: function (id) {
          return {
            get: function () { return Promise.resolve({ data: rows.find(function (r) { return r._id === id }) || null }) },
            update: function (payload) { var rec = rows.find(function (r) { return r._id === id }); if (rec && payload.data) Object.assign(rec, payload.data); return Promise.resolve({ stats: { updated: 1 } }) },
            remove: function () { return Promise.resolve({ stats: { removed: 1 } }) }
          }
        }
      }
      return api
    },
    command: { neq: function (v) { return { $ne: v } }, push: function (v) { return { $push: v } }, serverDate: function () { return new Date('2026-01-01') } }
  }
}

jest.mock('wx-server-sdk', function () {
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function () { return mockMakeDb() }),
    getWXContext: jest.fn(function () { return { OPENID: 'mock_openid' } }),
    callFunction: jest.fn(function () { return Promise.resolve({ result: { code: 200 } }) })
  }
})

jest.mock('../cloudfunctions/dataWrite/_shared/ai-gateway', function () {
  return { safeCallChat: jest.fn(function () { return Promise.resolve({ text: '{"members":[]}', usage: {}, logId: null }) }), safeCallThink: jest.fn() }
})
jest.mock('../cloudfunctions/dataWrite/_shared/ai-client', function () {
  return { callChat: jest.fn(function () { return Promise.resolve({ text: '{}', usage: {} }) }), callAIWithRetry: jest.fn(function () { return Promise.resolve({ text: '{}', usage: {} }) }), callHunyuan: jest.fn(function () { return Promise.resolve({ text: '{}', usage: {} }) }) }
})
jest.mock('../cloudfunctions/dataWrite/_shared/config', function () {
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

function seedMember(extra) {
  mockStore.members.push(Object.assign({ _id: 'mem_m1', family_id: 'f1', _openid: 'mock_openid', member_id: 'm1', name: '张三', health: '', occupation: '', income: '' }, extra || {}))
}

describe('Phase 4 fact→members / source', function () {
  beforeEach(function () {
    mockStore = { families: [], members: [], facts: [], agent_logs: [], operation_logs: [] }
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', members: [{ member_id: 'm1', name: '张三' }], engagement_stage: 'profiling' })
  })

  test('A1：表单标准字段写入的 fact source=user_form', function () {
    seedMember()
    return dataWrite.main({
      action: 'submitProfiling', familyId: 'f1',
      members: [{ memberId: 'm1', name: '张三', standardFields: [{ key: 'health', value: '高血压' }] }]
    }).then(function (res) {
      expect(res.code).toBe(200)
      var healthFact = mockStore.facts.find(function (f) { return f.predicate === '健康异常' })
      expect(healthFact).toBeTruthy()
      expect(healthFact.source).toBe('user_form')
    })
  })

  test('反向同步：对话高置信度 健康异常→members.health', function () {
    seedMember()
    return dataWrite.main({
      action: 'addFact', familyId: 'f1',
      subjectId: 'm1', subjectType: 'member', predicate: '健康异常',
      objectValue: '高血压', source: 'conversation', confidence: 0.9
    }).then(function (res) {
      expect(res.code).toBe(200)
      expect(mockStore.members[0].health).toBe('高血压')
    })
  })

  test('反向同步：对话高置信度 职业→members.occupation', function () {
    seedMember()
    return dataWrite.main({
      action: 'addFact', familyId: 'f1',
      subjectId: 'm1', subjectType: 'member', predicate: '职业',
      objectValue: '货运司机', source: 'conversation', confidence: 0.9
    }).then(function (res) {
      expect(res.code).toBe(200)
      expect(mockStore.members[0].occupation).toBe('货运司机')
    })
  })

  test('反向同步：低置信度 fact（<0.8）不写回 members', function () {
    seedMember()
    return dataWrite.main({
      action: 'addFact', familyId: 'f1',
      subjectId: 'm1', subjectType: 'member', predicate: '健康异常',
      objectValue: '疑似高血压', source: 'conversation', confidence: 0.3
    }).then(function (res) {
      expect(res.code).toBe(200)
      expect(mockStore.members[0].health).toBe('')
    })
  })

  test('反向同步：收入 fact 数值提取→members.income', function () {
    seedMember()
    return dataWrite.main({
      action: 'addFact', familyId: 'f1',
      subjectId: 'm1', subjectType: 'member', predicate: '个人年收入',
      objectValue: '年收入30万', source: 'conversation', confidence: 0.9
    }).then(function (res) {
      expect(res.code).toBe(200)
      expect(mockStore.members[0].income).toBe('30')
    })
  })
})
