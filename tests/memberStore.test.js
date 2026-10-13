/**
 * memberRepo 单元测试
 * 验证 Plan A 下 createMembersForFamily 保留既有 member_id（join key 不可破坏），
 * 新建成员生成 mem_xxx
 */
const { createMembersForFamily } = require('../cloudfunctions/_shared/memberRepo')
const { makeMemoryDb } = require('./helpers/memory-db')

// 2026-09-15 架构审查候选 4：改用手写原语的唯一实现 memory-db。
// 原桩是"where 一律返回空表"的空实现——它无法表达"已有成员"，因此本文件只能覆盖新建路径；
// 换 adapter 后 where 为真实过滤，后续补"既有成员保留"用例可直接 seed store 而无需改桩。
const makeMockDb = () => makeMemoryDb({})

describe('createMembersForFamily — member_id 稳定性', function() {
  test('保留既有 member_id', function() {
    return createMembersForFamily(makeMockDb(), 'f1', 'o1', [{ member_id: 'mem_keep', name: '张三' }]).then(function(created) {
      expect(created[0].member_id).toBe('mem_keep')
    })
  })

  test('新建成员生成 mem_ 前缀', function() {
    return createMembersForFamily(makeMockDb(), 'f1', 'o1', [{ name: '李四' }]).then(function(created) {
      expect(created[0].member_id).toMatch(/^mem_/)
    })
  })

  test('前端临时 m_ 前缀成员重新生成稳定 id', function() {
    return createMembersForFamily(makeMockDb(), 'f1', 'o1', [{ member_id: 'm_12345', name: '王五' }]).then(function(created) {
      expect(created[0].member_id).toMatch(/^mem_/)
    })
  })
})
