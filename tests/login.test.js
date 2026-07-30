/**
 * login 云函数单元测试
 * 测试：参数校验、devMode 静默登录、手机号登录、新建/更新代理人
 */

var mockCols = {}
var mockTmDoc = {
  get: jest.fn(),
  update: jest.fn()
}

jest.mock('wx-server-sdk', function() {
  var mock = {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() {
      return {
        collection: jest.fn(function(name) {
          if (!mockCols[name]) {
            mockCols[name] = {
              where: jest.fn(function() {
                return {
                  limit: jest.fn(function() {
                    return { get: jest.fn(function() { return Promise.resolve({ data: [] }) }) }
                  })
                }
              }),
              doc: jest.fn(function(id) { return mockTmDoc }),
              add: jest.fn(function() { return Promise.resolve({ _id: 'new_agent' }) })
            }
          }
          return mockCols[name]
        }),
        command: {}
      }
    }),
    getWXContext: jest.fn(function() {
      return { OPENID: 'mock_openid', APPID: 'mock_appid' }
    }),
    openapi: {
      phonenumber: {
        getPhoneNumber: jest.fn(function() {
          return Promise.resolve({ phoneInfo: { phoneNumber: '13800138000' } })
        })
      }
    }
  }
  return mock
})

var login = require('../cloudfunctions/login/index')

describe('login 云函数', function() {

  beforeEach(function() {
    var col = mockCols['agents']
    if (col) {
      col.where.mockReset()
      col.where.mockImplementation(function() {
        return {
          limit: jest.fn(function() {
            return { get: jest.fn(function() { return Promise.resolve({ data: [] }) }) }
          })
        }
      })
      mockTmDoc.update.mockReset()
    }
  })

  test('无 openid 返回 401', function() {
    var cloud = require('wx-server-sdk')
    cloud.getWXContext.mockReturnValueOnce({})

    return login.main({}).then(function(res) {
      expect(res.code).toBe(401)
      expect(res.msg).toContain('获取用户身份失败')
    })
  })

  describe('devMode', function() {

    test('devMode 创建新用户', function() {
      // agents 查询返回空，触发新建
      return login.main({ devMode: true }).then(function(res) {
        expect(res.code).toBe(200)
        expect(res.msg).toContain('调试登录成功')
        expect(res.data.nickname).toBe('开发测试')
        expect(res.data.role).toBe('trial')
        expect(res.data.plan).toBe('trial')
      })
    })

    test('devMode 更新已有用户', function() {
      mockCols['agents'].where.mockReturnValue({
        limit: jest.fn(function() { return { get: jest.fn(function() { return Promise.resolve({ data: [{ _id: 'agent_001', nickname: '已有用户', role: 'basic', plan: 'basic' }] }) }) } })
      })

      return login.main({ devMode: true }).then(function(res) {
        expect(res.code).toBe(200)
        expect(res.data.nickname).toBe('已有用户')
        expect(mockTmDoc.update).toHaveBeenCalled()
      })
    })

    test('devMode 异常返回 500', function() {
      mockCols['agents'].where.mockImplementation(function() {
        throw new Error('DB error')
      })

      return login.main({ devMode: true }).then(function(res) {
        expect(res.code).toBe(500)
        expect(res.msg).toContain('调试登录失败')
      })
    })

  })

  describe('手机号登录', function() {

    test('缺少 code 返回 400', function() {
      return login.main({}).then(function(res) {
        expect(res.code).toBe(400)
        expect(res.msg).toContain('登录code')
      })
    })

    test('手机号登录创建新代理人', function() {
      var cloud = require('wx-server-sdk')
      cloud.openapi.phonenumber.getPhoneNumber.mockResolvedValue({
        phoneInfo: { phoneNumber: '13912345678' }
      })
      // agents 查询返回空（默认已是空）

      return login.main({ code: 'mock_code' }).then(function(res) {
        expect(res.code).toBe(200)
        expect(res.msg).toContain('登录成功')
        expect(res.data.phone).toBe('13912345678')
      })
    })

    test('手机号登录更新已有代理人', function() {
      var cloud = require('wx-server-sdk')
      cloud.openapi.phonenumber.getPhoneNumber.mockResolvedValue({
        phoneInfo: { phoneNumber: '13800138000' }
      })
      // agents 查询返回已有记录
      mockCols['agents'].where.mockReturnValue({
        limit: jest.fn(function() { return { get: jest.fn(function() { return Promise.resolve({ data: [{ _id: 'agent_001', phone: '13800138000', nickname: '老用户' }] }) }) } })
      })

      return login.main({ code: 'mock_code' }).then(function(res) {
        expect(res.code).toBe(200)
        expect(res.data.agent_id).toBe('agent_001')
        expect(mockTmDoc.update).toHaveBeenCalled()
      })
    })

    test('手机号获取失败返回 400', function() {
      var cloud = require('wx-server-sdk')
      cloud.openapi.phonenumber.getPhoneNumber.mockResolvedValue({
        phoneInfo: {}
      })

      return login.main({ code: 'mock_code' }).then(function(res) {
        expect(res.code).toBe(400)
        expect(res.msg).toContain('手机号获取失败')
      })
    })

    test('登录异常返回 500', function() {
      var cloud = require('wx-server-sdk')
      cloud.openapi.phonenumber.getPhoneNumber.mockRejectedValue(new Error('API error'))

      return login.main({ code: 'mock_code' }).then(function(res) {
        expect(res.code).toBe(500)
        expect(res.msg).toContain('登录失败')
      })
    })

  })

})
