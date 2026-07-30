/**
 * errorHandler 单元测试
 * 测试：错误分类、错误映射、handle、handleCloudError
 */

// 全局 mock wx 对象
global.wx = {
  showToast: jest.fn(),
  cloud: {
    database: jest.fn(),
    callFunction: jest.fn()
  }
}

beforeEach(function() {
  jest.clearAllMocks()
})

afterEach(function() {
  jest.resetModules()
})

describe('errorHandler', function() {

  describe('getErrorInfo', function() {

    test('400 错误码映射', function() {
      var errorHandler = require('../miniprogram/utils/errorHandler')
      var info = errorHandler.getErrorInfo({ code: 400, msg: '参数缺失' })
      expect(info.code).toBe(400)
      expect(info.label).toBe('参数错误')
      expect(info.tip).toBe('操作有误，请重试')
      expect(info.detail).toBe('参数缺失')
    })

    test('404 错误码映射', function() {
      var errorHandler = require('../miniprogram/utils/errorHandler')
      var info = errorHandler.getErrorInfo({ code: 404 })
      expect(info.code).toBe(404)
      expect(info.label).toBe('未找到')
    })

    test('500 错误码映射', function() {
      var errorHandler = require('../miniprogram/utils/errorHandler')
      var info = errorHandler.getErrorInfo({ code: 500 })
      expect(info.code).toBe(500)
      expect(info.label).toBe('服务异常')
    })

    test('网络超时错误', function() {
      var errorHandler = require('../miniprogram/utils/errorHandler')
      var info = errorHandler.getErrorInfo({ errMsg: 'request:fail timeout' })
      expect(info.code).toBe('TIMEOUT')
    })

    test('网络连接失败', function() {
      var errorHandler = require('../miniprogram/utils/errorHandler')
      var info = errorHandler.getErrorInfo({ errMsg: 'network error fail' })
      expect(info.code).toBe('NETWORK')
    })

    test('wx API 网络错误 (errno 600001)', function() {
      var errorHandler = require('../miniprogram/utils/errorHandler')
      var info = errorHandler.getErrorInfo({ errno: 600001 })
      expect(info.code).toBe('NETWORK')
    })

    test('null 输入返回 UNKNOWN', function() {
      var errorHandler = require('../miniprogram/utils/errorHandler')
      var info = errorHandler.getErrorInfo(null)
      expect(info.code).toBe('UNKNOWN')
    })

    test('undefined 输入返回 UNKNOWN', function() {
      var errorHandler = require('../miniprogram/utils/errorHandler')
      var info = errorHandler.getErrorInfo(undefined)
      expect(info.code).toBe('UNKNOWN')
    })

  })

  describe('handle', function() {

    test('正常模式弹出 toast', function() {
      var errorHandler = require('../miniprogram/utils/errorHandler')
      errorHandler.handle({ code: 500 }, { context: 'test' })

      expect(wx.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          icon: 'error',
          duration: 2500
        })
      )
    })

    test('静默模式不弹 toast', function() {
      var errorHandler = require('../miniprogram/utils/errorHandler')
      errorHandler.handle({ code: 500 }, { silent: true })

      expect(wx.showToast).not.toHaveBeenCalled()
    })

    test('返回错误信息对象', function() {
      var errorHandler = require('../miniprogram/utils/errorHandler')
      var info = errorHandler.handle({ code: 404, msg: '找不到' })
      expect(info.code).toBe(404)
    })

  })

})
