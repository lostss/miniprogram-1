/**
 * getHomeList 云函数单元测试
 * 测试：参数校验、agent 查询、家庭列表格式化、分页
 * Plan A：成员来自 members 集合，不再内嵌 families.members
 */

var membersStore = []

jest.mock('wx-server-sdk', function() {
  function makeCol() {
    return {
      where: jest.fn(function() { return this }),
      limit: jest.fn(function() { return this }),
      orderBy: jest.fn(function() { return this }),
      field: jest.fn(function() { return this }),
      get: jest.fn()
    }
  }
  var famCol = makeCol()
  var memCol = makeCol()
  memCol.get.mockImplementation(function() { return Promise.resolve({ data: membersStore }) })

  var mock = {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() {
      return {
        collection: jest.fn(function(name) {
          if (name === 'agents') {
            return {
              where: jest.fn(function() {
                return { limit: jest.fn(function() { return { get: jest.fn(function() { return Promise.resolve({ data: [] }) }) } }) }
              })
            }
          }
          if (name === 'members') return memCol
          return famCol
        }),
        command: {
          neq: jest.fn(function(v) { return { $neq: v } }),
          gte: jest.fn(function(v) { return { $gte: v } }),
          gt: jest.fn(function(v) { return { $gt: v } }),
          in: jest.fn(function(v) { return { $in: v } })
        }
      }
    }),
    getWXContext: jest.fn(function() {
      return { OPENID: 'mock_openid', APPID: 'mock_appid' }
    })
  }
  mock.__famCol = famCol
  mock.__memCol = memCol
  return mock
})

var dataQuery = require('../cloudfunctions/dataQuery/index')

describe('getHomeList (via dataQuery) 云函数', function() {
  beforeEach(function() {
    membersStore.length = 0
  })

  test('无 openid 返回 401', function() {
    var cloud = require('wx-server-sdk')
    cloud.getWXContext.mockReturnValueOnce({})

    return dataQuery.main({ action: 'listFamilies' }).then(function(res) {
      expect(res.code).toBe(401)
      expect(res.msg).toContain('未登录')
    })
  })

  test('获取家庭列表成功', function() {
    var cloud = require('wx-server-sdk')
    membersStore.push({ family_id: 'fam_001', name: '张三', role: '本人' })
    cloud.__famCol.get.mockResolvedValue({
      data: [
        {
          _id: 'fam_001',
          family_name: '测试家庭',
          created_at: new Date(),
          updated_at: new Date(),
          profile_progress: { members: 50, finance: 30, insurance: 20, health: 10 }
        }
      ]
    })

    return dataQuery.main({ action: 'listFamilies' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.families.length).toBe(1)
      expect(res.data.families[0].family_name).toBe('测试家庭')
      expect(res.data.families[0].member_count).toBe(1)
      expect(res.data.families[0].pillar_name).toBe('张三')
      expect(res.data.families[0].profile_progress.members).toBe(50)
      expect(res.data.families[0].deliverable_status).toBe('none')
    })
  })

  test('家庭列表为空时返回空数组', function() {
    var cloud = require('wx-server-sdk')
    cloud.__famCol.get.mockResolvedValue({ data: [] })

    return dataQuery.main({ action: 'listFamilies' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.families).toEqual([])
      expect(res.data.family_count).toBe(0)
    })
  })

  test('since 参数按更新时间过滤家庭列表', function() {
    var cloud = require('wx-server-sdk')
    cloud.__famCol.get.mockResolvedValue({ data: [{ _id: 'fam_001', family_name: '家庭A' }] })

    return dataQuery.main({ action: 'listFamilies', since: '2026-01-01T00:00:00Z' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.families.length).toBe(1)
    })
  })

  test('limit 参数限制结果数', function() {
    var cloud = require('wx-server-sdk')
    cloud.__famCol.get.mockResolvedValue({ data: [] })

    return dataQuery.main({ action: 'listFamilies', limit: 5 }).then(function(res) {
      expect(res.code).toBe(200)
    })
  })

  test('DB 异常时吞错返回空列表', function() {
    var cloud = require('wx-server-sdk')
    cloud.__famCol.get.mockRejectedValue(new Error('DB error'))

    return dataQuery.main({ action: 'listFamilies' }).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.families).toEqual([])
      expect(res.data.family_count).toBe(0)
    })
  })

})
