/**
 * updateFamily handler — DB mock 测试
 *
 * 2026-09-15 架构审查候选 4：DB mock 统一为 tests/helpers/memory-db。
 * 旧桩有两个"放水"点，使真实语义无法被验证：
 *   1) where() 完全不过滤（恒返回全表）——条件查询写错也不会失败；
 *   2) update() 恒返回 { updated: 1 }——"无匹配应 404"这条语义被掩盖（原用例名自述"mock局限"）。
 * 换 adapter 后 where/update 与生产同语义，故下面"无匹配"用例改为断言真实的 404。
 * 另：旧桩 add(data) 按非 SDK 形状入参（SDK 是 add({ data })），写入内容其实从未被正确断言；
 * adapter 用真实形状，写入后的 store 可被直接检查（store 本身即表）。
 */
const { makeMemoryDb } = require('./helpers/memory-db')

// store 即 memory-db 的表容器（db 持有它的引用）：
//   1) 必须**模块加载期就构造**——被测模块在 require 阶段即取 cloud.database()，
//      延迟到 beforeEach 会拿到 null（jest.mock 工厂引用的变量需以 mock 开头，故命名 mockMemDb）；
//   2) 重置只能**原地清空**（length = 0），重新赋值会让 db 继续持有旧数组 → 写入静默丢失。
//      （README「测试基础设施」记录了这两条约束）
const mockStore = { families: [], operation_logs: [], members: [], facts: [], policies: [] }
const mockMemDb = makeMemoryDb(mockStore)

jest.mock('wx-server-sdk', function() {
  return {
    init: jest.fn(), DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return mockMemDb }),
    getWXContext: jest.fn(function() { return { OPENID: 'mock_openid' } })
  }
})

const dataWrite = require('../cloudfunctions/dataWrite/index')

describe('updateFamily (memory-db)', function() {
  beforeEach(function() {
    Object.keys(mockStore).forEach(function(k) { mockStore[k].length = 0 })
  })

  test('缺少 familyId 返回 400', function() {
    return dataWrite.main({ action: 'updateFamily' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('update 无匹配 → 404（2026-09-15 换 memory-db 后暴露的真实语义）', function() {
    return dataWrite.main({ action: 'updateFamily', familyId: 'f1', field: 'family_name', value: '新名', operator: 'set' }).then(function(res) {
      // handler 检查 result.stats.updated===0 → 404；旧桩恒返回 updated:1 让这条路径从未被覆盖
      expect(res.code).toBe(404)
    })
  })

  test('非法字段返回 400', function() {
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', family_name: '测试' })
    return dataWrite.main({ action: 'updateFamily', familyId: 'f1', field: 'invalid_field', value: 'x', operator: 'set' }).then(function(res) {
      expect(res.code).toBe(400)
    })
  })

  test('合法 set 操作返回 200', function() {
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', family_name: '测试' })
    return dataWrite.main({ action: 'updateFamily', familyId: 'f1', field: 'family_name', value: '新家庭名', operator: 'set' }).then(function(res) {
      expect(res.code).toBe(200)
    })
  })
})

// ===========================================================================
// 2026-09-19 流程审计 P2-7 + 上轮遗留（成员删除后 facts 悬挂）
//   members 整组覆盖的差集软删路径此前**零测试覆盖**，且完全不做事实清理
// ===========================================================================
describe('updateFamily · members 整组覆盖（P2-7 基线 + 事实清理）', function () {
  function seed() {
    Object.keys(mockStore).forEach(function(k) { mockStore[k].length = 0 })
    mockStore.families.push({ _id: 'f1', _openid: 'mock_openid', family_name: '测试' })
    mockStore.members.push(
      { _id: 'd1', member_id: 'm1', family_id: 'f1', _openid: 'mock_openid', name: '张三', role: '本人', status: 'active' },
      { _id: 'd2', member_id: 'm2', family_id: 'f1', _openid: 'mock_openid', name: '李四', role: '配偶', status: 'active' }
    )
    mockStore.facts.push(
      { _id: 'fa1', family_id: 'f1', _openid: 'mock_openid', subject_type: 'member', subject_id: 'm2', predicate: '职业', object_value: '教师', status: 'active' },
      { _id: 'fa2', family_id: 'f1', _openid: 'mock_openid', subject_type: 'member', subject_id: 'm1', predicate: '配偶', object_id: 'm2', status: 'active' }
    )
  }

  test('基线内经确认被移除 → 软删 + 关联事实 superseded（原实现只软删、不清理）', function() {
    seed()
    return dataWrite.main({
      action: 'updateFamily', familyId: 'f1',
      updateData: { members: [{ member_id: 'm1', name: '张三', role: '本人' }], members_baseline: ['m1', 'm2'] }
    }).then(function(res) {
      expect(res.code).toBe(200)
      expect(mockStore.members.find(m => m.member_id === 'm2').status).toBe('deleted')
      expect(mockStore.facts.find(f => f._id === 'fa1').status).toBe('superseded') // 正向：被删成员名下事实
      expect(mockStore.facts.find(f => f._id === 'fa2').status).toBe('superseded') // 反向：其他成员指向它的关系边
    })
  })

  // 2026-09-22：本条原先断言"软删成员 → 保单解链（member_id 置空）"，该实现已**回退**——
  // 它对声称要修的「保障人数 vs 缺口矩阵」分歧实际是 no-op（消费侧的 memberIdToName 只由在册
  // 成员构成，已删 id 本来就查不到、一直走 insured_name 兜底），却违反 docs/data-model-v2.md L101。
  // 现在改为**钉住文档规则本身**：软删只清 facts，保单归属一律不动（在册/已删成员都一样）。
  // 这条断言的价值在于它是"删除语义"的唯一书面来源 —— 任一侧被改成"顺手清 member_id"即红。
  test('软删成员：只清 facts，policies.member_id 一律保留（含在册成员对照）', function() {
    seed()
    mockStore.policies.push({ _id: 'p1', id: 'pol_1', family_id: 'f1', _openid: 'mock_openid', insured_name: '李四', member_id: 'm2', sum_assured: 100000 })
    mockStore.policies.push({ _id: 'p2', id: 'pol_2', family_id: 'f1', _openid: 'mock_openid', insured_name: '张三', member_id: 'm1' })
    return dataWrite.main({
      action: 'updateFamily', familyId: 'f1',
      updateData: { members: [{ member_id: 'm1', name: '张三', role: '本人' }], members_baseline: ['m1', 'm2'] }
    }).then(function(res) {
      expect(res.code).toBe(200)
      expect(mockStore.policies[0].member_id).toBe('m2')      // 被软删成员：join key 保留（不销毁历史归属）
      expect(mockStore.policies[0].insured_name).toBe('李四') // 保单仍在
      expect(mockStore.policies[1].member_id).toBe('m1')      // 在册成员：同样不动
      expect(mockStore.facts.find(f => f._id === 'fa1').status).toBe('superseded') // 事实层才是清理对象
    })
  })

  test('**不在基线内**的库内成员 → 不软删（编辑期间被对话/多端新增，防误删）', function() {
    seed()
    // 场景：用户打开编辑 Sheet（当时只见过 m2），期间别处新增了 m3，随后用户保存
    mockStore.members.push({ _id: 'd3', member_id: 'm3', family_id: 'f1', _openid: 'mock_openid', name: '王五', role: '', status: 'active' })
    return dataWrite.main({
      action: 'updateFamily', familyId: 'f1',
      updateData: { members: [{ member_id: 'm2', name: '李四', role: '配偶' }], members_baseline: ['m2'] }
    }).then(function(res) {
      expect(res.code).toBe(200)
      expect(mockStore.members.find(m => m.member_id === 'm3').status).toBe('active') // 并发新增者保留
      expect(mockStore.members.find(m => m.member_id === 'm1').status).toBe('active') // 同理保留
    })
  })

  test('未传基线 → 沿用旧行为（凡不在 incoming 者皆软删），避免老调用方删除静默失效', function() {
    seed()
    return dataWrite.main({
      action: 'updateFamily', familyId: 'f1',
      updateData: { members: [{ member_id: 'm1', name: '张三', role: '本人' }] }
    }).then(function(res) {
      expect(res.code).toBe(200)
      expect(mockStore.members.find(m => m.member_id === 'm2').status).toBe('deleted')
    })
  })

  test('members_baseline 仅作基线消费，不落库', function() {
    seed()
    return dataWrite.main({
      action: 'updateFamily', familyId: 'f1',
      updateData: { members: [{ member_id: 'm1', name: '张三', role: '本人' }], members_baseline: ['m1', 'm2'] }
    }).then(function() {
      expect(mockStore.families[0].members_baseline).toBeUndefined()
    })
  })
})
