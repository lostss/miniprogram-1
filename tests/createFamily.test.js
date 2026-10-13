/**
 * createFamily 云函数单元测试
 * 测试：参数校验、成员生成、数据写入
 */

jest.mock('wx-server-sdk', function() {
  var mockCollectionData = {}
  var mockDoc = {
    get: jest.fn(),
    update: jest.fn(function() { return Promise.resolve({ stats: { updated: 1 } }) })
  }

  var mock = {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() {
      return {
        collection: jest.fn(function(name) {
          return {
            doc: jest.fn(function(id) {
              return mockDoc
            }),
            where: jest.fn(function() {
              return {
                get: jest.fn(function() {
                  return Promise.resolve({ data: [] })
                }),
                limit: jest.fn(function() {
                  return { get: jest.fn(function() { return Promise.resolve({ data: [] }) }) }
                }),
                count: jest.fn(function() {
                  return Promise.resolve({ total: 0 })
                })
              }
            }),
            add: jest.fn(function(data) {
              return Promise.resolve({ _id: 'new_fam_id' })
            })
          }
        }),
        command: {
          push: jest.fn(function(v) { return { $push: v } }),
          unshift: jest.fn(function(v) { return { $unshift: v } }),
          set: jest.fn(function(v) { return { $set: v } }),
          inc: jest.fn(function(v) { return { $inc: v } }),
          neq: jest.fn(function(v) { return { $neq: v } }),
          in: jest.fn(function(v) { return { $in: v } }),
          gte: jest.fn(function(v) { return { $gte: v } }),
          lte: jest.fn(function(v) { return { $lte: v } }),
          serverDate: jest.fn(function() { return new Date('2026-01-01') })
        },
        serverDate: jest.fn(function() { return new Date('2026-01-01') })
      }
    }),
    getWXContext: jest.fn(function() {
      return { OPENID: 'mock_openid', APPID: 'mock_appid' }
    }),
    callFunction: jest.fn(function() {
      return Promise.resolve({ result: { code: 200 } })
    })
  }
  mock.__mockDoc = mockDoc
  mock.__mockCollectionData = mockCollectionData
  return mock
})

var dataWrite = require('../cloudfunctions/dataWrite/index')

describe('createFamily (via dataWrite) 云函数', function() {

  test('缺少 openid 返回 401', function() {
    var cloud = require('wx-server-sdk')
    cloud.getWXContext.mockReturnValueOnce({})

    return dataWrite.main({
      action: 'createFamily',
      family_name: '测试家庭',
      members: [{ role: '本人', name: '张三' }]
    }).then(function(res) {
      expect(res.code).toBe(401)
      expect(res.msg).toContain('未登录')
    })
  })

  test('空家庭名称返回 400', function() {
    return dataWrite.main({
      action: 'createFamily',
      family_name: '',
      members: [{ role: '本人', name: '张三' }]
    }).then(function(res) {
      expect(res.code).toBe(400)
      expect(res.msg).toContain('家庭名称不能为空')
    })
  })

  // 2026-09-12 契约变更：放开"无成员建档"——第一次见面、还没拿到保单时最需要先建客户档案，
  // 成员可后续补（readiness 会引导）。原契约（至少一个成员）把最需要的时点挡在门外。
  test('空成员列表 → 允许建档（member_count 0）', function() {
    return dataWrite.main({
      action: 'createFamily',
      family_name: '待补全客户',
      members: []
    }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.family_structure.member_count).toBe(0)
      expect(res.data.members).toEqual([])
    })
  })

  test('无 members 字段 → 同样允许建档', function() {
    return dataWrite.main({
      action: 'createFamily',
      family_name: '无成员客户'
    }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.family_structure.member_count).toBe(0)
    })
  })

  test('成功创建家庭返回 200', function() {
    return dataWrite.main({
      action: 'createFamily',
      family_name: '张三家庭',
      family_structure: ['本人', '配偶'],
      members: [
        { role: '本人', name: '张三', birth_year: 1985 },
        { role: '配偶', name: '李四', birth_year: 1988 }
      ]
    }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.msg).toBe('创建成功')
      expect(res.data._id).toBe('new_fam_id')
      expect(res.data.family_name).toBe('张三家庭')
      expect(res.data.members.length).toBe(2)
      expect(res.data.members[0].member_id).toMatch(/^mem_/)
      expect(res.data.members[0].role).toBe('本人')
      expect(res.data.members[1].role).toBe('配偶')
    })
  })

  test('成员生成 member_id 和字段锁定', function() {
    return dataWrite.main({
      action: 'createFamily',
      family_name: '测试',
      members: [
        { role: '本人', name: '王五', age: 35 }
      ]
    }).then(function(res) {
      var member = res.data.members[0]
      expect(member.member_id).toMatch(/^mem_/)
      expect(member.role).toBe('本人')
      expect(member.name).toBe('王五')
      expect(member.age).toBe(35)
    })
  })

  test('family_structure 结构正确', function() {
    return dataWrite.main({
      action: 'createFamily',
      family_name: '测试',
      members: [
        { role: '本人', name: '赵六' },
        { role: '配偶', name: '孙七' },
        { role: '子女', name: '赵八' }
      ]
    }).then(function(res) {
      var structure = res.data.family_structure
      expect(structure.roles).toEqual(['本人', '配偶', '子女'])
      expect(structure.member_count).toBe(3)
    })
  })

})
