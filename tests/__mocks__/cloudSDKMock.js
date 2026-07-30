/**
 * wx-server-sdk mock
 * 模拟微信云开发 SDK 的核心 API
 */
var mockCollectionData = {}
var mockCollection = null

function __setCollectionData(name, data) {
  mockCollectionData[name] = JSON.parse(JSON.stringify(data))
}

function __resetMock() {
  mockCollectionData = {}
  mockCollection = null
}

var cloud = {
  init: jest.fn(),
  DYNAMIC_CURRENT_ENV: 'env-mock',
  database: function() {
    return {
      collection: function(name) {
        var data = mockCollectionData[name] || []
        var docId = null
        return {
          doc: function(id) {
            docId = id
            return {
              get: function() {
                var doc = data.find(function(d) { return d._id === id })
                return Promise.resolve({ data: doc || null })
              },
              update: function() {
                return Promise.resolve({ stats: { updated: 1 } })
              }
            }
          },
          where: function() {
            return {
              get: function() {
                return Promise.resolve({ data: data })
              },
              orderBy: function() {
                return {
                  get: function() {
                    return Promise.resolve({ data: data })
                  }
                }
              }
            }
          },
          add: function() {
            return Promise.resolve({ _id: 'mock_id_' + Date.now() })
          }
        }
      },
      command: {
        push: function(val) { return { $push: val } },
        serverDate: function() { return new Date('2026-01-01T00:00:00Z') }
      },
      Geo: function() { return {} }
    }
  },
  callFunction: function() {
    return Promise.resolve({ result: { code: 200, data: {} } })
  },
  getWXContext: function() {
    return { OPENID: 'mock_openid', APPID: 'mock_appid' }
  }
}

module.exports = cloud
module.exports.__setCollectionData = __setCollectionData
module.exports.__resetMock = __resetMock
