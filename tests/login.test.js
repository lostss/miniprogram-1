/**
 * login 云函数单元测试
 * 方案 A（个人主体）：openid 静默登录——微信唯一身份即账号，无需手机号授权
 * 测试：参数校验、新建/更新代理人、异常兜底
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
    })
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

  test('openid 登录创建新用户', function() {
    // agents 查询返回空，触发新建
    return login.main({}).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.msg).toContain('登录成功')
      expect(res.data.openid).toBe('mock_openid')
      expect(res.data.agent_id).toBe('new_agent')
      expect(res.data.nickname).toBe('新用户')
      expect(res.data.role).toBe('trial')
      expect(res.data.plan).toBe('trial')
      expect(res.data.phone).toBe('')
    })
  })

  test('openid 登录更新已有用户', function() {
    // M-1 修复后登录走 writeSeam.silentUpdateDoc：先 where(_id + _openid).get() 校验归属，再 doc().update()
    var existingAgent = { _id: 'agent_001', _openid: 'mock_openid', phone: 'dev_000001', nickname: '已有用户', role: 'basic', plan: 'basic' }
    mockCols['agents'].where.mockReturnValue({
      limit: jest.fn(function() { return { get: jest.fn(function() { return Promise.resolve({ data: [existingAgent] }) }) } }),
      get: jest.fn(function() { return Promise.resolve({ data: [existingAgent] }) })
    })

    return login.main({}).then(function(res) {
      expect(res.code).toBe(200)
      expect(res.data.agent_id).toBe('agent_001')
      expect(res.data.nickname).toBe('已有用户')
      expect(res.data.phone).toBe('dev_000001')
      expect(mockTmDoc.update).toHaveBeenCalled()
    })
  })

  test('登录异常返回 500', function() {
    mockCols['agents'].where.mockImplementation(function() {
      throw new Error('DB error')
    })

    return login.main({}).then(function(res) {
      expect(res.code).toBe(500)
      expect(res.msg).toContain('登录失败')
    })
  })

})
