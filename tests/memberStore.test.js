/**
 * memberRepo 单元测试
 * 验证 Plan A 下 createMembersForFamily 保留既有 member_id（join key 不可破坏），
 * 新建成员生成 mem_xxx
 */
const { createMembersForFamily } = require('../cloudfunctions/_shared/memberRepo')

function makeMockDb() {
  return {
    collection: function() {
      return {
        where: function() { return { get: function() { return Promise.resolve({ data: [] }) }, limit: function() { return { get: function() { return Promise.resolve({ data: [] }) } } } } },
        add: function() { return Promise.resolve({ _id: 'doc_' + Math.random() }) },
        doc: function() { return { update: function() { return Promise.resolve({}) }, remove: function() { return Promise.resolve({}) } } },
        remove: function() { return Promise.resolve({}) }
      }
    }
  }
}

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
