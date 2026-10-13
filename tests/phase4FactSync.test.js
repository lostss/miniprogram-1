/**
 * Phase 4 回归测试：
 * - A1：表单事实 source 由 'user' 改为 'user_form'
 * - 高置信度 fact（健康/职业/收入，confidence≥0.8）反向同步回 members
 * 注意：CloudBase add/update 入参包在 { data: {...} } 中，存储记录为 { _id, data: {...} }
 */
const { makeMemoryDb } = require('./helpers/memory-db')

// 2026-09-15 架构审查候选 4：DB mock 统一为 tests/helpers/memory-db。
// 旧桩的 where() 不过滤（恒返回全表）、update() 恒 updated:1 —— 条件读写写错也测不出来。
// store 即表容器：db 持有其引用，故**加载期构造**（被测模块 require 阶段即取 database()）
// 且重置只能原地清空（length = 0），不可重新赋值。
const mockStore = { families: [], members: [], facts: [], agent_logs: [], operation_logs: [] }
const mockMemDb = makeMemoryDb(mockStore)

jest.mock('wx-server-sdk', function () {
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function () { return mockMemDb }),
    getWXContext: jest.fn(function () { return { OPENID: 'mock_openid' } }),
    callFunction: jest.fn(function () { return Promise.resolve({ result: { code: 200 } }) })
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

function seedMember(extra) {
  mockStore.members.push(Object.assign({ _id: 'mem_m1', family_id: 'f1', _openid: 'mock_openid', member_id: 'm1', name: '张三', health: '', occupation: '', income: '' }, extra || {}))
}

describe('Phase 4 fact→members / source', function () {
  beforeEach(function () {
    // 原地清空（不重新赋值）：db 持有 mockStore 的引用（见文件头说明）
    Object.keys(mockStore).forEach(function (k) { mockStore[k].length = 0 })
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', members: [{ member_id: 'm1', name: '张三' }], engagement_stage: 'profiling' })
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
