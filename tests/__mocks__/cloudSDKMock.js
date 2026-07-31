/**
 * wx-server-sdk mock
 * 模拟微信云开发 SDK 的核心 API（真实 where 过滤 + 完整链式方法）
 */
let mockCollectionData = {}
let mockCollection = null

function __setCollectionData(name, data) {
  mockCollectionData[name] = JSON.parse(JSON.stringify(data))
}

function __resetMock() {
  mockCollectionData = {}
  mockCollection = null
}

// 操作符匹配：支持 $ne/$exists/$gt/$gte/$lt/$lte/$in/$nin
function matchOp(op, val) {
  if (op && typeof op === 'object') {
    if ('$ne' in op) return val !== op.$ne
    if ('$exists' in op) return op.$exists ? (val !== undefined) : (val === undefined)
    if ('$gt' in op) return val > op.$gt
    if ('$gte' in op) return val >= op.$gte
    if ('$lt' in op) return val < op.$lt
    if ('$lte' in op) return val <= op.$lte
    if ('$in' in op) return Array.isArray(op.$in) && op.$in.indexOf(val) !== -1
    if ('$nin' in op) return Array.isArray(op.$nin) && op.$nin.indexOf(val) === -1
  }
  return val === op
}

function matchDoc(doc, where) {
  for (const k of Object.keys(where)) {
    if (!matchOp(where[k], doc[k])) return false
  }
  return true
}

function buildQuery(data, where) {
  const filtered = where ? data.filter(d => matchDoc(d, where)) : data.slice()
  return {
    get: () => Promise.resolve({ data: filtered }),
    count: () => Promise.resolve({ total: filtered.length }),
    limit: (n) => buildQuery(filtered.slice(0, n), null),
    orderBy: () => buildQuery(filtered, null),
    update: ({ data: patch }) => {
      let updated = 0
      for (const d of filtered) {
        Object.assign(d, patch)
        updated++
      }
      return Promise.resolve({ stats: { updated } })
    },
    remove: () => {
      const removed = filtered.length
      return Promise.resolve({ stats: { removed } })
    }
  }
}

const cloud = {
  init: jest.fn(),
  DYNAMIC_CURRENT_ENV: 'env-mock',
  database: function () {
    return {
      collection: function (name) {
        const data = mockCollectionData[name] || []
        return {
          doc: function (id) {
            return {
              get: () => Promise.resolve({ data: data.find(d => d._id === id) || null }),
              update: ({ data: patch }) => {
                const d = data.find(x => x._id === id)
                if (d) Object.assign(d, patch)
                return Promise.resolve({ stats: { updated: d ? 1 : 0 } })
              },
              remove: () => {
                const idx = data.findIndex(d => d._id === id)
                const removed = idx >= 0 ? (data.splice(idx, 1), 1) : 0
                return Promise.resolve({ stats: { removed } })
              },
              set: ({ data: patch }) => {
                const d = data.find(x => x._id === id)
                if (d) Object.assign(d, patch)
                return Promise.resolve({ stats: { updated: d ? 1 : 0 } })
              }
            }
          },
          where: function (cond) { return buildQuery(data, cond) },
          add: function ({ data: doc }) {
            const _id = 'mock_id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
            data.push(Object.assign({ _id }, doc))
            return Promise.resolve({ _id })
          },
          get: function () { return Promise.resolve({ data }) }
        }
      },
      command: {
        push: (val) => ({ $push: val }),
        pull: (val) => ({ $pull: val }),
        inc: (val) => ({ $inc: val }),
        ne: (val) => ({ $ne: val }),
        eq: (val) => ({ $eq: val }),
        gt: (val) => ({ $gt: val }),
        gte: (val) => ({ $gte: val }),
        lt: (val) => ({ $lt: val }),
        lte: (val) => ({ $lte: val }),
        in: (val) => ({ $in: val }),
        nin: (val) => ({ $nin: val }),
        exists: (val) => ({ $exists: val }),
        serverDate: () => new Date('2026-01-01T00:00:00Z')
      },
      Geo: function () { return {} }
    }
  },
  callFunction: function () { return Promise.resolve({ result: { code: 200, data: {} } }) },
  getWXContext: function () { return { OPENID: 'mock_openid', APPID: 'mock_appid' } }
}

module.exports = cloud
module.exports.__setCollectionData = __setCollectionData
module.exports.__resetMock = __resetMock
