/**
 * memory-db — 测试用内存数据库 adapter（2026-09-15 架构审查候选 4）
 *
 * 背景：tests/ 下有 31 个文件各自手写 DB mock（1–64 行不等），共同原语
 * （matchWhere / 链式 `where().orderBy().limit().get()` / `doc()` / `add({data})`）
 * 被反复重写；其中多数 mock 的 `where()` 是空实现（不过滤直接返回全表），
 * 于是测试通过并不代表条件查询逻辑正确。本 adapter 是那 31 份的唯一实现。
 *
 * ## 语义对齐（wx-server-sdk / CloudBase）
 * - `add(payload)`：payload 是 `{ data: {...} }`，落库为**平铺记录**（`{_id, ...data}`）——
 *   与 SDK 实测语义一致（见 writePoliciesBatch.test.js 的注释记载）
 * - 读取返回平铺记录数组（`{ data: rows }`），不做 `{data:{...}}` 嵌套
 * - `doc(id).get()` 返回 `{ data: record|null }`（SDK 单文档语义）
 * - `update()` 返回 `{ stats: { updated: n } }`；`remove()` 返回 `{ stats: { removed: n } }`
 * - `count()` 返回 `{ total: n }`
 * - **where 真实过滤**（含操作符），不再"全表返回"——这是与手写 mock 最大的差别，
 *   迁移时可能暴露被旧 mock 掩盖的问题，需逐个判断是代码 bug 还是测试假设错
 *
 * ## 用法
 * ```js
 * const { makeMemoryDb, memoryCommand } = require('./helpers/memory-db')
 * const store = { families: [{ _id: 'f1', _openid: 'o1' }] }
 * const db = makeMemoryDb(store)
 * await db.collection('families').where({ _openid: 'o1' }).get()
 * // 断言落库：用 store 本身（store.facts 数组就是表）
 * ```
 */

/** 操作符匹配：支持 command 产出的 { $op: value } 形式 */
function matchOp(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    // 正则查询：db.RegExp({ regexp, options })（模糊搜索用）
    if (expected.regexp !== undefined) {
      return new RegExp(expected.regexp, expected.options || 'i').test(String(actual == null ? '' : actual))
    }
    const ops = Object.keys(expected).filter(k => k.startsWith('$'))
    if (ops.length) {
      return ops.every(op => {
        const v = expected[op]
        switch (op) {
          case '$eq': return actual === v
          case '$ne': return actual !== v
          case '$gt': return actual > v
          case '$gte': return actual >= v
          case '$lt': return actual < v
          case '$lte': return actual <= v
          case '$in': return Array.isArray(v) && v.some(x => matchOp(actual, x))
          case '$nin': return Array.isArray(v) && !v.some(x => matchOp(actual, x))
          case '$exists': return v ? actual !== undefined : actual === undefined
          case '$all': return Array.isArray(v) && Array.isArray(actual) && v.every(x => actual.indexOf(x) !== -1)
          case '$or': return Array.isArray(v) && v.some(cond => matchWhere(actual, cond))
          case '$and': return Array.isArray(v) && v.every(cond => matchWhere(actual, cond))
          default: return true
        }
      })
    }
  }
  // 数组字段：成员匹配（SDK 语义：{ tags: 'x' } 命中 tags 含 x 的记录）
  if (Array.isArray(actual)) return actual.some(x => x === expected)
  return actual === expected
}

/** 整条记录是否满足 where 条件（值可以是操作符对象） */
function matchWhere(row, where) {
  if (!where || typeof where !== 'object') return true
  return Object.keys(where).every(key => {
    const cond = where[key]
    // 顶层逻辑操作符：$or / $and 的值是条件数组
    if (key === '$or') return Array.isArray(cond) && cond.some(c => matchWhere(row, c))
    if (key === '$and') return Array.isArray(cond) && cond.every(c => matchWhere(row, c))
    return matchOp(row[key], cond)
  })
}

/** 应用 update patch（支持 $inc / $push / $pull / $set，其余字段直接覆盖） */
function applyPatch(row, patch) {
  const data = patch && patch.data ? patch.data : patch
  if (!data || typeof data !== 'object') return
  Object.keys(data).forEach(key => {
    const op = data[key]
    if (op && typeof op === 'object' && !Array.isArray(op) && op.$inc !== undefined) {
      row[key] = (Number(row[key]) || 0) + Number(op.$inc)
    } else if (op && typeof op === 'object' && !Array.isArray(op) && op.$push !== undefined) {
      row[key] = (Array.isArray(row[key]) ? row[key] : []).concat([op.$push])
    } else if (op && typeof op === 'object' && !Array.isArray(op) && op.$pull !== undefined) {
      row[key] = (Array.isArray(row[key]) ? row[key] : []).filter(x => x !== op.$pull)
    } else if (op && typeof op === 'object' && !Array.isArray(op) && op.$set !== undefined) {
      row[key] = op.$set
    } else {
      row[key] = op
    }
  })
}

const memoryCommand = {
  eq: v => ({ $eq: v }),
  neq: v => ({ $ne: v }),
  gt: v => ({ $gt: v }),
  gte: v => ({ $gte: v }),
  lt: v => ({ $lt: v }),
  lte: v => ({ $lte: v }),
  in: v => ({ $in: v }),
  nin: v => ({ $nin: v }),
  exists: v => ({ $exists: v }),
  all: v => ({ $all: v }),
  or: v => ({ $or: v }),
  and: v => ({ $and: v }),
  inc: v => ({ $inc: v }),
  push: v => ({ $push: v }),
  pull: v => ({ $pull: v }),
  set: v => ({ $set: v }),
  serverDate: () => new Date(),
  remove: () => ({ $remove: true })
}

let _seq = 0
function _nextId() {
  _seq += 1
  return 'mem_' + Date.now().toString(36) + '_' + _seq
}

/**
 * 构造内存数据库 adapter
 * @param {object} store - 表容器：{ [collectionName]: rows[] }（测试直接断言这个对象）
 * @param {object} [opts] - { onQuery?(name, where) } 可选钩子，便于断言查询行为
 */
function makeMemoryDb(store, opts) {
  const tables = store || {}
  const options = opts || {}
  // opts.spy：调用记录（{ queries, adds, updates, removes, counts }）——
  // 供"断言是否发生某次写入/查询"的测试使用（原多份手写 mock 各自实现了这套记录）。
  const spy = options.spy || null
  const record = (kind, entry) => { if (spy && Array.isArray(spy[kind])) spy[kind].push(entry) }
  // opts.failCollections：按集合名注入查询失败（测试"部分集合读失败时的降级"路径）。
  // 支持数组或返回数组的函数——用函数形式可避免"测试重新赋值变量导致引用失联"。
  function shouldFail(name) {
    const fc = typeof options.failCollections === 'function' ? options.failCollections() : options.failCollections
    return Array.isArray(fc) && fc.indexOf(name) !== -1
  }

  function collection(name) {
    const rows = tables[name] || (tables[name] = [])
    const state = { where: null, order: null, limit: null, skip: 0, projection: null }

    const api = {
      where(criteria) { state.where = criteria || null; record('queries', { name, where: criteria }); return api },
      orderBy(field, dir) { state.order = { field, dir: dir === 'desc' ? -1 : 1 }; return api },
      limit(n) { state.limit = n; return api },
      skip(n) { state.skip = n || 0; return api },
      field(proj) { state.projection = proj || null; return api },
      _rows() {
        if (options.onQuery) options.onQuery(name, state.where)
        let out = rows.slice()
        if (state.where) out = out.filter(r => matchWhere(r, state.where))
        if (state.order) {
          const { field, dir } = state.order
          out.sort((a, b) => {
            const av = a[field], bv = b[field]
            if (av === bv) return 0
            return (av > bv ? 1 : -1) * dir
          })
        }
        if (state.skip) out = out.slice(state.skip)
        if (state.limit != null) out = out.slice(0, state.limit)
        return out
      },
      get() {
        if (shouldFail(name)) return Promise.reject(new Error(name + ' query failed'))
        return Promise.resolve({ data: api._rows() })
      },
      count() {
        record('counts', { name, where: state.where })
        if (shouldFail(name)) return Promise.reject(new Error(name + ' query failed'))
        return Promise.resolve({ total: api._rows().length })
      },
      add(payload) {
        record('adds', { name, data: (payload && payload.data) || payload })
        const id = _nextId()
        const rec = Object.assign({ _id: id }, (payload && payload.data) || payload || {})
        rows.push(rec)
        return Promise.resolve({ _id: id })
      },
      update(payload) {
        record('updates', { name, where: state.where, data: (payload && payload.data) || payload })
        const targets = api._rows()
        targets.forEach(r => applyPatch(r, payload))
        return Promise.resolve({ stats: { updated: targets.length } })
      },
      remove() {
        record('removes', { name, where: state.where })
        const targets = api._rows()
        targets.forEach(r => {
          const i = rows.indexOf(r)
          if (i !== -1) rows.splice(i, 1)
        })
        return Promise.resolve({ stats: { removed: targets.length } })
      },
      doc(id) {
        return {
          get() {
            return Promise.resolve({ data: rows.find(r => r._id === id) || null })
          },
          update(payload) {
            record('updates', { name, docId: id, data: (payload && payload.data) || payload })
            const rec = rows.find(r => r._id === id)
            if (!rec) return Promise.resolve({ stats: { updated: 0 } })
            applyPatch(rec, payload)
            return Promise.resolve({ stats: { updated: 1 } })
          },
          remove() {
            record('removes', { name, docId: id })
            const i = rows.findIndex(r => r._id === id)
            if (i === -1) return Promise.resolve({ stats: { removed: 0 } })
            rows.splice(i, 1)
            return Promise.resolve({ stats: { removed: 1 } })
          }
        }
      }
    }
    return api
  }

  // RegExp：对齐 wx-server-sdk 的 db.RegExp({ regexp, options })，供模糊搜索查询
  const RegExpCtor = o => ({ regexp: o && o.regexp, options: (o && o.options) || 'i' })

  return { collection, command: memoryCommand, RegExp: RegExpCtor, _tables: tables }
}

module.exports = { makeMemoryDb, memoryCommand, matchWhere, applyPatch }
