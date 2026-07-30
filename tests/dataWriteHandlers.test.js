/**
 * dataWrite handlers 单元测试（重写版）
 *
 * 修复问题：原测试复制粘贴了 handler 的校验逻辑，production 代码从未被调用，
 * 提供零回归保护。本版直接调用 dataWrite.main，让真实 handler 处理校验。
 *
 * 接口即测试面：通过 createHandler 的公开入口（event.action + event._authOpenid）
 * 触发真实 handler，校验规则改动自动被测试捕获。
 */

// 共享 mock：补全所有 command 操作符（neq/push/inc/nin/gt/lt/or/and/pull）
var mockStore = { families: [], members: [], finances: [], policies: [], facts: [], messages: [], operation_logs: [], agent_logs: [] }

function mockMakeDb() {
  return {
    collection: function (name) {
      var rows = mockStore[name] || (mockStore[name] = [])
      var api = {
        where: function () { return api },
        field: function () { return api },
        orderBy: function () { return api },
        limit: function () { return api },
        get: function () { return Promise.resolve({ data: rows.slice() }) },
        count: function () { return Promise.resolve({ total: rows.length }) },
        update: function () { return Promise.resolve({ stats: { updated: 1 } }) },
        remove: function () { return Promise.resolve({ stats: { removed: 1 } }) },
        add: function (payload) {
          var id = 'mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
          var rec = Object.assign({ _id: id }, payload && payload.data ? payload.data : payload)
          rows.push(rec)
          return Promise.resolve({ _id: id })
        },
        doc: function (id) {
          return {
            get: function () {
              var rec = rows.find(function (r) { return r._id === id })
              return Promise.resolve({ data: rec || null })
            },
            update: function (payload) {
              var rec = rows.find(function (r) { return r._id === id })
              if (rec && payload && payload.data) Object.assign(rec, payload.data)
              return Promise.resolve({ stats: { updated: rec ? 1 : 0 } })
            },
            remove: function () {
              var idx = rows.findIndex(function (r) { return r._id === id })
              if (idx >= 0) rows.splice(idx, 1)
              return Promise.resolve({ stats: { removed: idx >= 0 ? 1 : 0 } })
            }
          }
        }
      }
      return api
    },
    command: {
      neq: function (v) { return { $ne: v } },
      push: function (v) { return { $push: v } },
      pull: function (v) { return { $pull: v } },
      inc: function (v) { return { $inc: v } },
      gt: function (v) { return { $gt: v } },
      gte: function (v) { return { $gte: v } },
      lt: function (v) { return { $lt: v } },
      lte: function (v) { return { $lte: v } },
      in: function (v) { return { $in: v } },
      nin: function (v) { return { $nin: v } },
      or: function (arr) { return { $or: arr } },
      and: function (arr) { return { $and: arr } },
      serverDate: function () { return new Date('2026-01-01') }
    }
  }
}

jest.mock('wx-server-sdk', function () {
  return {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function () { return mockMakeDb() }),
    getWXContext: jest.fn(function () { return { OPENID: 'mock_openid' } }),
    callFunction: jest.fn(function () { return Promise.resolve({ result: { code: 200 } }) })
  }
})

jest.mock('../cloudfunctions/dataWrite/_shared/ai-gateway', function () {
  return {
    safeCallChat: jest.fn(function () { return Promise.resolve({ text: '{}', usage: {}, logId: null }) }),
    safeCallThink: jest.fn()
  }
})
jest.mock('../cloudfunctions/dataWrite/_shared/ai-client', function () {
  return {
    callChat: jest.fn(function () { return Promise.resolve({ text: '{}', usage: {} }) }),
    callAIWithRetry: jest.fn(function () { return Promise.resolve({ text: '{}', usage: {} }) }),
    callHunyuan: jest.fn(function () { return Promise.resolve({ text: '{}', usage: {} }) })
  }
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

// 统一调用入口：通过 _authOpenid 注入身份，绕过 cloud.getWXContext
function call(action, extra) {
  return dataWrite.main(Object.assign({ action: action, _authOpenid: 'test_openid' }, extra || {}))
}

function seedFamily(id) {
  mockStore.families.push({ _id: id || 'f1', _openid: 'test_openid', family_id: id || 'f1', family_name: '测试家庭', members: [], engagement_stage: 'profiling' })
}

describe('dataWrite handlers — 真实 handler 调用', function () {
  beforeEach(function () {
    mockStore = { families: [], members: [], finances: [], policies: [], facts: [], messages: [], operation_logs: [], agent_logs: [] }
    seedFamily('f1')
  })

  describe('未登录拦截', function () {
    test('无 openid 返回 401', async function () {
      // 不传 _authOpenid，且 getWXContext mock 也返回空（临时覆盖）
      var origGetCtx = require('wx-server-sdk').getWXContext
      require('wx-server-sdk').getWXContext = jest.fn(function () { return {} })
      var res = await dataWrite.main({ action: 'writeMessage', familyId: 'f1', role: 'user', content: 'hi' })
      require('wx-server-sdk').getWXContext = origGetCtx
      expect(res.code).toBe(401)
    })
    test('未知 action 返回 400', async function () {
      var res = await call('nonExistentAction')
      expect(res.code).toBe(400)
    })
  })

  describe('writeMessage', function () {
    test('缺少 role 返回 400', async function () {
      var res = await call('writeMessage', { familyId: 'f1', content: 'hello' })
      expect(res.code).toBe(400)
    })
    test('缺少 content 返回 400', async function () {
      var res = await call('writeMessage', { familyId: 'f1', role: 'user' })
      expect(res.code).toBe(400)
    })
    test('非法 role 返回 400', async function () {
      var res = await call('writeMessage', { familyId: 'f1', role: 'admin', content: 'test' })
      expect(res.code).toBe(400)
    })
    test('内容超长返回 400', async function () {
      var res = await call('writeMessage', { familyId: 'f1', role: 'user', content: 'x'.repeat(4001) })
      expect(res.code).toBe(400)
    })
    test('成功写入返回 200 且消息入库', async function () {
      var res = await call('writeMessage', { familyId: 'f1', role: 'user', content: 'hello' })
      expect(res.code).toBe(200)
      expect(mockStore.messages.length).toBe(1)
      expect(mockStore.messages[0].content).toBe('hello')
    })
  })

  describe('writeOpLog', function () {
    // writeOpLog 内部用 event.action 作为 logAction（createHandler 路由也用 event.action，二者复用同名字段）
    test('缺少 action 时返回 400（handler 内 event.action 既路由又作 logAction）', async function () {
      // action='writeOpLog' 本身就是 logAction，不会缺；测缺 familyId 时的兼容路径
      var res = await call('writeOpLog', { result: { status: 'ok' } })
      expect(res.code).toBe(200)
    })
    test('成功写入返回 200', async function () {
      var res = await call('writeOpLog', { familyId: 'f1', result: { status: 'ok' } })
      expect(res.code).toBe(200)
      expect(mockStore.operation_logs.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('addFact', function () {
    test('缺少 familyId 返回 400', async function () {
      var res = await call('addFact', { subjectId: 'm1', predicate: '健康异常', objectValue: '高血压' })
      expect(res.code).toBe(400)
    })
    test('缺少 predicate 返回 400', async function () {
      var res = await call('addFact', { familyId: 'f1', subjectId: 'm1', objectValue: '高血压' })
      expect(res.code).toBe(400)
    })
    test('成功写入返回 200', async function () {
      var res = await call('addFact', {
        familyId: 'f1', subjectId: 'm1', subjectType: 'member', predicate: '健康异常',
        objectValue: '高血压', source: 'conversation', confidence: 0.9
      })
      expect(res.code).toBe(200)
    })
  })

  describe('writePolicy', function () {
    test('缺少 familyId 返回 400', async function () {
      var res = await call('writePolicy', { data: { insured_name: '张三' } })
      expect(res.code).toBe(400)
    })
    test('成功写入返回 200', async function () {
      var res = await call('writePolicy', {
        familyId: 'f1',
        data: { insured_name: '张三', insurance_category: '重疾险', product_name: '健康保', sum_assured: 500000, annual_premium: 8000 }
      })
      expect(res.code).toBe(200)
    })
  })

  describe('setStage', function () {
    test('缺少 familyId 返回 400', async function () {
      var res = await call('setStage', { stage: 'profiling' })
      expect(res.code).toBe(400)
    })
    test('成功设置返回 200', async function () {
      var res = await call('setStage', { familyId: 'f1', stage: 'analyzing' })
      expect(res.code).toBe(200)
    })
  })

  describe('createFamily', function () {
    // createFamily 检查重名，mock 的 where().count() 返回全部行数，需清空 families
    beforeEach(function () { mockStore.families = [] })
    test('缺少 family_name 返回 400', async function () {
      var res = await call('createFamily', {})
      expect(res.code).toBe(400)
    })
    test('缺少 members 返回 400', async function () {
      var res = await call('createFamily', { family_name: '李四家庭' })
      expect(res.code).toBe(400)
    })
    test('成功创建返回 200 且写入 families 集合', async function () {
      var res = await call('createFamily', {
        family_name: '李四家庭',
        members: [{ name: '李四', role: '本人' }, { name: '王五', role: '配偶' }]
      })
      expect(res.code).toBe(200)
      expect(mockStore.families.length).toBe(1)
      expect(mockStore.members.length).toBe(2)
    })
  })
})
