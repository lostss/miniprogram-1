/**
 * dataWrite handlers 单元测试（重写版）
 *
 * 修复问题：原测试复制粘贴了 handler 的校验逻辑，production 代码从未被调用，
 * 提供零回归保护。本版直接调用 dataWrite.main，让真实 handler 处理校验。
 *
 * 接口即测试面：通过 createHandler 的公开入口（event.action + event._authOpenid）
 * 触发真实 handler，校验规则改动自动被测试捕获。
 */
const { makeMemoryDb } = require('./helpers/memory-db')

// 共享 mock：DB mock 收敛到 tests/helpers/memory-db（2026-09-15 架构审查候选 4）
var mockStore = { families: [], members: [], finances: [], policies: [], facts: [], messages: [], operation_logs: [], agent_logs: [] }

/**
 * 旧实现是 57 行手写 mock，且 where 为空实现（恒返回全表）——查询条件从未被验证，
 * 于是"某个 action 忘了带 family_id 过滤"这类缺陷测试也发现不了。
 * adapter 真实过滤（neq/in/nin/or/and… 均支持）；本文件 seed 已带
 * _openid='test_openid' 与 family_id，可直接迁移。
 */
function mockMakeDb() {
  return makeMemoryDb(mockStore)
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
  mockStore.families.push({ _id: id || 'f1', _openid: 'mock_openid', family_id: id || 'f1', family_name: '测试家庭', members: [], engagement_stage: 'profiling' })
}

describe('dataWrite handlers — 真实 handler 调用', function () {
  beforeEach(function () {
    // ⚠️ 必须原地清空、不能重新赋值 mockStore：adapter 在构造时固化 store 引用
    // （旧的手写 mock 每次动态读 mockStore 变量，所以能容忍重建；adapter 不能）。
    Object.keys(mockStore).forEach(function (k) { mockStore[k].length = 0 })
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
    test('undoOps 透传落库（P1-L1：历史恢复撤销入口，此前白名单丢弃导致按钮永不出现）', async function () {
      var res = await call('writeMessage', { familyId: 'f1', role: 'assistant', content: '已更新家庭财务', undoOps: [{ opId: 'ud_1', summary: '已更新家庭财务', ttlSec: 300 }] })
      expect(res.code).toBe(200)
      var m = mockStore.messages.find(function (x) { return x.content === '已更新家庭财务' })
      expect(m && m.undoOps).toEqual([{ opId: 'ud_1', summary: '已更新家庭财务', ttlSec: 300 }])
    })
  })

  describe('writeOpLog', function () {
    // 2026-09-12 修复（埋点前置缺陷）：apiClient 把本 action 映射为路由 {action:'writeOpLog'}，
    // 真正的事件名在 logAction。原实现取 event.action → 线上 979 条日志里前端上报的事件类型全部丢失
    // （都落成 action:'writeOpLog'），无法按事件聚合；产品埋点依赖此修复才能生效。
    test('缺少 logAction → 400（event.action 是路由名，不再当事件名）', async function () {
      var res = await call('writeOpLog', { result: { status: 'ok' } })
      expect(res.code).toBe(400)
    })
    test('logAction 生效：落库 action 为事件名（可按事件聚合）', async function () {
      var res = await call('writeOpLog', {
        familyId: 'f1',
        logAction: 'product_report_open',
        result: { status: 'ok' },
        meta: { view: 'shared' }
      })
      expect(res.code).toBe(200)
      var rec = mockStore.operation_logs[mockStore.operation_logs.length - 1]
      expect(rec.action).toBe('product_report_open')
      expect(rec.meta).toEqual({ view: 'shared' })
    })
    test('成功写入返回 200 且落库', async function () {
      var res = await call('writeOpLog', { familyId: 'f1', logAction: 'frontend_error', result: { status: 'error', summary: 'x' } })
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

  describe('createFamily', function () {
    // createFamily 检查重名 → 需清空 families（原地清空，理由同上）
    beforeEach(function () { mockStore.families.length = 0 })
    test('缺少 family_name 返回 400', async function () {
      var res = await call('createFamily', {})
      expect(res.code).toBe(400)
    })
    // 2026-09-12 契约变更：允许无成员建档（第一次见面、还没拿到保单时最需要先建档案）
    test('缺少 members → 允许建档（member_count 0）', async function () {
      var res = await call('createFamily', { family_name: '李四家庭' })
      expect(res.code).toBe(200)
      expect(mockStore.families[0].family_structure.member_count).toBe(0)
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

  describe('updatePolicy', function () {
    function seedPolicy() {
      // 必须带业务字段 id：locatePolicy 按 `id` 定位（policy-locate.js:31），不是 _id。
      // 旧 mock（where 空实现）靠"表里只有一条"侥幸命中，实际未验证定位逻辑。
      var rec = { _id: 'db_pol_test1', id: 'pol_test1', _openid: 'mock_openid', family_id: 'f1', member_id: '', product_name: '康健华尊', insured_name: '张三', insurance_category: '医疗险', effective_date: '2025-01-01', insurance_period: '1年', status: 'active' }
      mockStore.policies.push(rec)
      return rec
    }
    beforeEach(function () { mockStore.policies.length = 0 })
    test('生效日期格式非法（AI 误填保障期间）返回 400 且不落库', async function () {
      var t = seedPolicy()
      var res = await call('updatePolicy', { familyId: 'f1', policyId: t.id, data: { effective_date: '1年' } })
      expect(res.code).toBe(400)
      expect(t.effective_date).toBe('2025-01-01')
    })
    test('保障期间字段可更新（白名单）且落库', async function () {
      var t = seedPolicy()
      var res = await call('updatePolicy', { familyId: 'f1', policyId: t.id, data: { insurance_period: '终身' } })
      expect(res.code).toBe(200)
      expect(t.insurance_period).toBe('终身')
    })
    test('合法生效日期可更新', async function () {
      var t = seedPolicy()
      var res = await call('updatePolicy', { familyId: 'f1', policyId: t.id, data: { effective_date: '2026-03-01' } })
      expect(res.code).toBe(200)
      expect(t.effective_date).toBe('2026-03-01')
    })
  })
})
