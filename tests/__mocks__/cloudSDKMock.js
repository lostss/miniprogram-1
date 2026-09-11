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

// 更新补丁应用：支持 $inc/$set 操作符（其余字段直接赋值）
function applyPatch(d, patch) {
  for (const k of Object.keys(patch)) {
    const v = patch[k]
    if (v && typeof v === 'object' && '$inc' in v) d[k] = (Number(d[k]) || 0) + Number(v.$inc)
    else if (v && typeof v === 'object' && '$set' in v) d[k] = v.$set
    else d[k] = v
  }
}

function buildQuery(data, where) {
  const filtered = where ? data.filter(d => matchDoc(d, where)) : data.slice()
  return {
    get: () => Promise.resolve({ data: filtered }),
    count: () => Promise.resolve({ total: filtered.length }),
    limit: (n) => buildQuery(filtered.slice(0, n), null),
    skip: (n) => buildQuery(filtered.slice(n), null),
    orderBy: () => buildQuery(filtered, null),
    field: () => buildQuery(filtered, null),
    update: ({ data: patch }) => {
      let updated = 0
      for (const d of filtered) {
        applyPatch(d, patch)
        updated++
      }
      return Promise.resolve({ stats: { updated } })
    },
    remove: () => {
      // 真实删除：filtered 是 data 的过滤副本（同引用），按引用从 data 中移除
      let removed = 0
      for (const d of filtered.slice()) {
        const idx = data.indexOf(d)
        if (idx >= 0) { data.splice(idx, 1); removed++ }
      }
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
        if (!mockCollectionData[name]) mockCollectionData[name] = []
        const data = mockCollectionData[name]
        return {
          doc: function (id) {
            return {
              get: () => Promise.resolve({ data: data.find(d => d._id === id) || null }),
              update: ({ data: patch }) => {
                const d = data.find(x => x._id === id)
                if (d) applyPatch(d, patch)
                return Promise.resolve({ stats: { updated: d ? 1 : 0 } })
              },
              remove: () => {
                const idx = data.findIndex(d => d._id === id)
                const removed = idx >= 0 ? (data.splice(idx, 1), 1) : 0
                return Promise.resolve({ stats: { removed } })
              },
              set: ({ data: patch }) => {
                const d = data.find(x => x._id === id)
                if (d) applyPatch(d, patch)
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
        neq: (val) => ({ $ne: val }),
        eq: (val) => ({ $eq: val }),
        set: (val) => ({ $set: val }),
        gt: (val) => ({ $gt: val }),
        gte: (val) => ({ $gte: val }),
        lt: (val) => ({ $lt: val }),
        lte: (val) => ({ $lte: val }),
        in: (val) => ({ $in: val }),
        nin: (val) => ({ $nin: val }),
        exists: (val) => ({ $exists: val }),
        remove: () => ({ $remove: 1 }),
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
