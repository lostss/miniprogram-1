/**
 * report-files — 报告 PDF 导出文件的登记与 TTL 回收（2026-09-20 复核批次 B）
 *
 * 覆盖两条关键不变量：
 *   ① 删文件失败 → **记录必须保留**（记录先删 = 文件成永久孤儿，再也找不到）
 *   ② 集合不存在 → 自动建集合后重试（沿用 report-versions 的线上教训：集合缺失 + 被吞的异常
 *      = 「功能自上线起从未可用」且长期无人发现）
 *
 * 用 purpose-built 假 db（支持 _.lt / _.in + 真实删除语义），不引 memory-db：
 * 这里的查询形态很窄，手写更直观且不牵动其他测试的公共夹具。
 */
const { COLLECTION, recordReportFile, pruneReportFiles } = require('../cloudfunctions/_shared/report-files')

let errSpy
beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errSpy.mockRestore() })

function makeDb(rows = [], opts = {}) {
  const removed = []
  const added = []
  const command = {
    lt: (v) => ({ op: 'lt', v }),
    in: (arr) => ({ op: 'in', arr })
  }
  function match(row, where) {
    return Object.keys(where).every(k => {
      const c = where[k]
      if (c && c.op === 'lt') return new Date(row[k]).getTime() < new Date(c.v).getTime()
      if (c && c.op === 'in') return c.arr.indexOf(row[k]) > -1
      return row[k] === c
    })
  }
  const collection = () => ({
    where: (w) => ({
      limit: (n) => ({ get: async () => ({ data: rows.filter(r => match(r, w)).slice(0, n) }) }),
      remove: async () => {
        const hit = rows.filter(r => match(r, w))
        hit.forEach(r => { const i = rows.indexOf(r); if (i > -1) rows.splice(i, 1); removed.push(r._id) })
        return { stats: { removed: hit.length } }
      }
    }),
    add: async ({ data }) => {
      if (opts.addThrows) throw new Error(opts.addThrows)
      added.push(data)
      rows.push(Object.assign({ _id: 'new_' + rows.length }, data))
      return { _id: 'new' }
    }
  })
  return {
    collection,
    command,
    createCollection: opts.noCreateCollection ? undefined : jest.fn().mockResolvedValue({}),
    _rows: rows,
    _removed: removed,
    _added: added
  }
}

function makeCloud(impl) {
  return {
    deleteFile: jest.fn(impl || (async ({ fileList }) => ({
      fileList: fileList.map(id => ({ fileID: id, status: 0, errMsg: 'ok' }))
    })))
  }
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000)

describe('recordReportFile — 登记', () => {
  test('成功：写入含 _openid 的记录（云函数端不会自动注入）', async () => {
    const db = makeDb()
    const r = await recordReportFile(db, { openid: 'o1', familyId: 'f1', fileID: 'cloud://a.pdf', filePath: 'reports/o1/f1_1.pdf' })
    expect(r.ok).toBe(true)
    expect(db._added[0]._openid).toBe('o1')
    expect(db._added[0].file_id).toBe('cloud://a.pdf')
    expect(db._added[0].created_at).toBeInstanceOf(Date)
  })

  test('集合不存在 → 建集合后重试成功（不静默失败）', async () => {
    const db = makeDb([], { addThrows: 'collection not exists' })
    // 首轮 add 抛错、建集合后的第二轮成功
    const first = await recordReportFile(db, { openid: 'o1', familyId: 'f1', fileID: 'cloud://a.pdf' })
    expect(first.ok).toBe(false)
    expect(db.createCollection).toHaveBeenCalledTimes(1)
    // 模拟建集合后 add 恢复正常
    db.collection = () => ({ add: async ({ data }) => { db._added.push(data); return { _id: 'x' } } })
    const second = await recordReportFile(db, { openid: 'o1', familyId: 'f1', fileID: 'cloud://a.pdf' })
    expect(second.ok).toBe(true)
  })

  test('缺参数 / 非集合缺失错误 → 返回 ok:false 且不抛错（登记失败不得中断导出）', async () => {
    expect((await recordReportFile(makeDb(), { openid: '', fileID: 'x' })).ok).toBe(false)
    expect((await recordReportFile(makeDb(), { openid: 'o1', fileID: '' })).ok).toBe(false)
    const db = makeDb([], { addThrows: 'network timeout' })
    await expect(recordReportFile(db, { openid: 'o1', fileID: 'x' })).resolves.toEqual({ ok: false, reason: 'error' })
    expect(db.createCollection).not.toHaveBeenCalled()
  })
})

describe('pruneReportFiles — TTL 回收', () => {
  test('超过保留期的记录：删文件 + 删记录；未超期的不动', async () => {
    const db = makeDb([
      { _id: 'r1', file_id: 'cloud://old.pdf', created_at: daysAgo(31) },
      { _id: 'r2', file_id: 'cloud://new.pdf', created_at: daysAgo(3) }
    ])
    const cloud = makeCloud()
    const out = await pruneReportFiles(db, cloud, 30)
    expect(cloud.deleteFile).toHaveBeenCalledWith({ fileList: ['cloud://old.pdf'] })
    expect(out.filesDeleted).toBe(1)
    expect(out.recordsDeleted).toBe(1)
    expect(db._rows.map(r => r._id)).toEqual(['r2']) // 未超期的仍在
  })

  test('**删文件失败 → 记录必须保留**（先删记录就再也找不到文件）', async () => {
    const db = makeDb([{ _id: 'r1', file_id: 'cloud://old.pdf', created_at: daysAgo(31) }])
    const cloud = makeCloud(async ({ fileList }) => ({
      fileList: fileList.map(id => ({ fileID: id, status: -1, errMsg: 'internal error' }))
    }))
    const out = await pruneReportFiles(db, cloud, 30)
    expect(out.filesFailed).toBe(1)
    expect(out.recordsDeleted).toBe(0)
    expect(db._rows.map(r => r._id)).toEqual(['r1'])
  })

  test('deleteFile 抛错 → 同样保留记录（下轮重试）', async () => {
    const db = makeDb([{ _id: 'r1', file_id: 'cloud://old.pdf', created_at: daysAgo(31) }])
    const cloud = makeCloud(async () => { throw new Error('boom') })
    const out = await pruneReportFiles(db, cloud, 30)
    expect(out.filesFailed).toBe(1)
    expect(db._rows.length).toBe(1)
  })

  test('**有条目但无 status → 视为未确认，保留记录**（2026-09-28 复审锁定该判据）', async () => {
    // 原实现 `item.status === 0 || item.status === undefined` 把"没带状态码"当已删 → 清记录；
    // 那与不变式 ① 相反（文件若其实还在，就成永久孤儿、再也没人找得到）。现只认显式 status=0。
    const db = makeDb([{ _id: 'r1', file_id: 'cloud://x.pdf', created_at: daysAgo(31) }])
    const cloud = makeCloud(async ({ fileList }) => ({ fileList: fileList.map(id => ({ fileID: id, errMsg: '' })) }))
    const out = await pruneReportFiles(db, cloud, 30)
    expect(out.filesFailed).toBe(1)
    expect(out.recordsDeleted).toBe(0)
    expect(db._rows.map(r => r._id)).toEqual(['r1'])
  })

  test('文件本就不存在（not exist）也算成功 → 清掉记录，不无限重试', async () => {
    const db = makeDb([{ _id: 'r1', file_id: 'cloud://gone.pdf', created_at: daysAgo(31) }])
    const cloud = makeCloud(async ({ fileList }) => ({
      fileList: fileList.map(id => ({ fileID: id, status: -1, errMsg: 'file not exist' }))
    }))
    const out = await pruneReportFiles(db, cloud, 30)
    expect(out.filesDeleted).toBe(1)
    expect(db._rows.length).toBe(0)
  })

  test('登记残缺（无 file_id）：删记录，不调 deleteFile', async () => {
    const db = makeDb([{ _id: 'r1', created_at: daysAgo(31) }])
    const cloud = makeCloud()
    const out = await pruneReportFiles(db, cloud, 30)
    expect(cloud.deleteFile).not.toHaveBeenCalled()
    expect(out.recordsDeleted).toBe(1)
  })

  test('集合不存在（从未导出过）→ 回收 error 而不抛错，其他清理不受影响', async () => {
    const db = makeDb()
    db.collection = () => ({ where: () => ({ limit: () => ({ get: async () => { throw new Error('collection not exists') } }) }) })
    const out = await pruneReportFiles(db, makeCloud(), 30)
    expect(out.error).toMatch(/not exist/)
    expect(out.recordsDeleted).toBe(0)
  })

  test('统计字段带保留期与集合名（便于日志归因）', async () => {
    const out = await pruneReportFiles(makeDb(), makeCloud(), 30)
    expect(out.collection).toBe(COLLECTION)
    expect(out.retentionDays).toBe(30)
    expect(out).toMatchObject({ scanned: 0, filesDeleted: 0, recordsDeleted: 0, filesFailed: 0 })
  })
})
