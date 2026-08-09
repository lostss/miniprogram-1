/**
 * updateFamilyDetail 云函数单元测试
 * 测试：参数校验、字段更新、action 路由（delete/updateSummary）、权限检查
 */

jest.mock('wx-server-sdk', function() {
  var mockDoc = {
    get: jest.fn(),
    update: jest.fn()
  }

  var mockInnerDoc = {
    get: jest.fn(),
    update: jest.fn(),
    remove: jest.fn().mockResolvedValue({ stats: { removed: 1 } })
  }

  var mockCollection = {
    where: jest.fn(),
    limit: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    doc: jest.fn(function() { return mockInnerDoc })
  }

  var mock = {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() {
      return {
        collection: jest.fn(function(name) {
          if (name === 'families') return mockCollection
          // 架构审计第 6 轮：batchRemove/batchSupersede 需完整 where 链（limit/get/update/remove）
          var mockWhereChain = {
            limit: jest.fn(function() { return mockWhereChain }),
            get: jest.fn(function() { return Promise.resolve({ data: [] }) }),
            update: jest.fn(function() { return Promise.resolve({ stats: { updated: 0 } }) }),
            remove: jest.fn(function() { return Promise.resolve({}) })
          }
          return {
            where: jest.fn(function() { return mockWhereChain })
          }
        }),
        command: {
          push: jest.fn(function(v) { return { $push: v } }),
          pull: jest.fn(function(v) { return { $pull: v } }),
          inc: jest.fn(function(v) { return { $inc: v } })
        }
      }
    }),
    getWXContext: jest.fn(function() {
      return { OPENID: 'mock_openid', APPID: 'mock_appid' }
    }),
    callFunction: jest.fn(function() { return Promise.resolve({ result: { code: 200 } }) })
  }
  mock.__mockCollection = mockCollection
  return mock
})

jest.mock('../cloudfunctions/dataWrite/constants', function() {
  return {
    ALLOWED_FIELDS: ['family_name', 'members', 'status', 'policies', 'financial_snapshot', 'completeness_score', 'memo', 'health_confirmed', 'confirmed_health'],
    isSafeKey: function(key) {
      var forbidden = ['__proto__', 'constructor', 'prototype']
      return !forbidden.some(function(p) { return key.indexOf(p) !== -1 })
    }
  }
})

jest.mock('../cloudfunctions/dataWrite/_shared/completeness', function() {
  return {
    calcCompletenessScore: function(family) {
      var members = family.members || []
      var policies = family.policies || []
      var score = 0
      if (members.length > 0) score += 40
      if (policies.length > 0) score += 20
      return Math.min(100, score)
    }
  }
})

var updateFamilyDetail = require('../cloudfunctions/dataWrite/index')

describe('updateFamilyDetail 云函数', function() {

  test('缺少 familyId 返回 400', function() {
    return updateFamilyDetail.main({ action: 'updateFamily' }).then(function(res) {
      expect(res.code).toBe(400)
      expect(res.msg).toContain('familyId')
    })
  })

  describe('action 路由', function() {

    test('action=delete 删除家庭', function() {
      var cloud = require('wx-server-sdk')
      cloud.__mockCollection.where.mockReturnThis()
      cloud.__mockCollection.limit.mockReturnThis()
      cloud.__mockCollection.get.mockResolvedValue({
        data: [{ _id: 'fam_001', _openid: 'mock_openid' }]
      })
      cloud.__mockCollection.update.mockResolvedValue({ stats: { updated: 1 } })
      // doc(familyId).update() resolves
      cloud.__mockCollection.doc().update.mockResolvedValue({ stats: { updated: 1 } })
      // ponytail: 硬删策略需要 doc().remove() 支持
      cloud.__mockCollection.doc().remove.mockResolvedValue({ stats: { removed: 1 } })

      return updateFamilyDetail.main({ action: 'deleteFamily', familyId: 'fam_001' }).then(function(res) {
        expect(res.code).toBe(200)
        expect(res.msg).toContain('删除成功')
      })
    })

    test('action=delete 家庭不存在返回 404', function() {
      var cloud = require('wx-server-sdk')
      cloud.__mockCollection.where.mockReturnThis()
      cloud.__mockCollection.get.mockResolvedValue({ data: [] })

      return updateFamilyDetail.main({ action: 'deleteFamily', familyId: 'nonexist' }).then(function(res) {
        expect(res.code).toBe(404)
      })
    })

  })

  describe('字段更新', function() {

    test('不允许的字段返回 400', function() {
      return updateFamilyDetail.main({ action: 'updateFamily', familyId: 'fam_001', field: 'invalid_field', value: 'test' }).then(function(res) {
        expect(res.code).toBe(400)
        expect(res.msg).toContain('不允许更新')
      })
    })

    test('set 操作更新字段', function() {
      var cloud = require('wx-server-sdk')
      cloud.__mockCollection.where.mockReturnThis()
      cloud.__mockCollection.update.mockResolvedValue({ stats: { updated: 1 } })
      cloud.__mockCollection.limit.mockReturnThis()
      cloud.__mockCollection.get.mockResolvedValue({
        data: [{ _id: 'fam_001', members: [], policies: [] }]
      })

      return updateFamilyDetail.main({ action: 'updateFamily', familyId: 'fam_001', field: 'family_name', value: '新名称' }).then(function(res) {
        expect(res.code).toBe(200)
      })
    })

    test('members 字段禁止直接写（需走专用写接口）', function() {
      var cloud = require('wx-server-sdk')
      cloud.__mockCollection.where.mockReturnThis()
      cloud.__mockCollection.update.mockResolvedValue({ stats: { updated: 1 } })

      return updateFamilyDetail.main({
        action: 'updateFamily', familyId: 'fam_001', field: 'members', value: [{ id: 'm1', name: '新成员' }], operator: 'push'
      }).then(function(res) {
        expect(res.code).toBe(400)
        expect(res.msg).toContain('对应写接口')
      })
    })

    test('updateData 批量更新', function() {
      var cloud = require('wx-server-sdk')
      cloud.__mockCollection.where.mockReturnThis()
      cloud.__mockCollection.update.mockResolvedValue({ stats: { updated: 1 } })
      cloud.__mockCollection.get.mockResolvedValue({
        data: [{ _id: 'fam_001', members: [], policies: [], financial_snapshot: {} }]
      })

      return updateFamilyDetail.main({
        action: 'updateFamily', familyId: 'fam_001',
        updateData: { family_name: '批量更新', memo: '备注' }
      }).then(function(res) {
        expect(res.code).toBe(200)
        expect(res.msg).toContain('更新成功')
      })
    })

  })

  test('记录不存在返回 404', function() {
    var cloud = require('wx-server-sdk')
    cloud.__mockCollection.where.mockReturnThis()
    cloud.__mockCollection.update.mockResolvedValue({ stats: { updated: 0 } })

    return updateFamilyDetail.main({ action: 'updateFamily', familyId: 'fam_001', field: 'family_name', value: 'test' }).then(function(res) {
      expect(res.code).toBe(404)
    })
  })

  test('异常返回 500', function() {
    var cloud = require('wx-server-sdk')
    cloud.__mockCollection.update.mockRejectedValue(new Error('DB error'))

    return updateFamilyDetail.main({ action: 'updateFamily', familyId: 'fam_001', field: 'family_name', value: 'test' }).then(function(res) {
      expect(res.code).toBe(500)
    })
  })

})
