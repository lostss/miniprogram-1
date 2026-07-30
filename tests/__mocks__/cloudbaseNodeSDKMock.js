/**
 * @cloudbase/node-sdk mock
 * 模拟腾讯云 CloudBase AI 能力
 */

var mockGenerateText = null

function _getFn() {
  var fn = mockGenerateText || jest.fn().mockResolvedValue({ text: '{}' })
  return fn
}

function __setMockGenerateText(fn) {
  mockGenerateText = fn
}

function __resetMock() {
  mockGenerateText = null
}

var cloudbase = {
  init: jest.fn(function() {
    return {
      ai: jest.fn(function() {
        return {
          createModel: jest.fn(function() {
            return {
              generateText: function() {
                return _getFn()()
              }
            }
          })
        }
      })
    }
  })
}

module.exports = cloudbase
module.exports.__setMockGenerateText = __setMockGenerateText
module.exports.__resetMock = __resetMock
