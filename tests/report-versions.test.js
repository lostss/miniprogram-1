/**
 * report-versions 测试
 * 架构审计第 13 轮候选 #5：补单测
 *
 * 覆盖 archivePrevious 的归档路径、清理旧版本、异常降级
 */
const { archivePrevious } = require('../cloudfunctions/reportAI/report-versions')

// 抑制 console.error
let errSpy
beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errSpy.mockRestore() })

/**
 * 构造 mock db，链式 where().orderBy().skip().limit().get() + collection().add()/.doc().remove()
 */
function makeMockDb({ addResult = { _id: 'r_new' }, staleList = [] } = {}) {
  const removeFn = jest.fn().mockResolvedValue({ stats: { removed: 1 } })
  const docFn = jest.fn().mockReturnValue({ remove: removeFn })
  const getFn = jest.fn().mockResolvedValue({ data: staleList })
  const limitFn = jest.fn().mockReturnValue({ get: getFn })
  const skipFn = jest.fn().mockReturnValue({ limit: limitFn })
  const orderByFn = jest.fn().mockReturnValue({ skip: skipFn })
  const whereFn = jest.fn().mockReturnValue({ orderBy: orderByFn })
  const addFn = jest.fn().mockResolvedValue(addResult)
  const collectionFn = jest.fn().mockReturnValue({
    add: addFn,
    where: whereFn,
    doc: docFn
  })
  return {
    collection: collectionFn,
    _add: addFn,
    _where: whereFn,
    _orderBy: orderByFn,
    _skip: skipFn,
    _limit: limitFn,
    _get: getFn,
    _doc: docFn,
    _remove: removeFn
  }
}

const baseArgs = {
  familyId: 'fam_001',
  openid: 'op_test',
  prevFamily: {
    last_portrait: '上一版画像',
    last_review: '上一版检视',
    last_plan: '上一版计划',
    last_analysis_at: new Date('2026-01-01'),
    completeness_score: 85
  },
  keepVersions: 3,
  now: new Date('2026-07-27')
}

describe('archivePrevious - 无上一版', () => {
  test('prevFamily 无 last_* → 直接返回，不调 db', async () => {
    const db = makeMockDb()
    await archivePrevious(db, { ...baseArgs, prevFamily: {} })
    expect(db.collection).not.toHaveBeenCalled()
  })

  test('prevFamily 只有 last_portrait → 走归档路径', async () => {
    const db = makeMockDb()
    await archivePrevious(db, { ...baseArgs, prevFamily: { last_portrait: 'X' } })
    expect(db.collection).toHaveBeenCalled()
  })

  test('prevFamily 只有 last_review → 走归档路径', async () => {
    const db = makeMockDb()
    await archivePrevious(db, { ...baseArgs, prevFamily: { last_review: 'X' } })
    expect(db.collection).toHaveBeenCalled()
  })

  test('prevFamily 只有 last_plan → 走归档路径', async () => {
    const db = makeMockDb()
    await archivePrevious(db, { ...baseArgs, prevFamily: { last_plan: 'X' } })
    expect(db.collection).toHaveBeenCalled()
  })
})

describe('archivePrevious - 归档成功路径', () => {
  test('add 写入 reports 集合，含 family_id/_openid/version_at/saved_at', async () => {
    const db = makeMockDb()
    await archivePrevious(db, baseArgs)
    expect(db._add).toHaveBeenCalledTimes(1)
    const added = db._add.mock.calls[0][0].data
    expect(added.family_id).toBe('fam_001')
    expect(added._openid).toBe('op_test')
    expect(added.version_at).toEqual(baseArgs.prevFamily.last_analysis_at)
    expect(added.saved_at).toEqual(baseArgs.now)
    expect(added.completeness_score).toBe(85)
    // toReadReport 把 last_portrait 映射为 portrait
    expect(added.portrait).toBe('上一版画像')
    expect(added.review).toBe('上一版检视')
    expect(added.plan).toBe('上一版计划')
  })

  test('version_at 退化为 updated_at', async () => {
    const db = makeMockDb()
    const updated_at = new Date('2026-06-01')
    await archivePrevious(db, {
      ...baseArgs,
      prevFamily: { last_portrait: 'X', last_analysis_at: null, updated_at }
    })
    expect(db._add.mock.calls[0][0].data.version_at).toEqual(updated_at)
  })

  test('version_at 完全缺失 → 退化为 now', async () => {
    const db = makeMockDb()
    await archivePrevious(db, {
      ...baseArgs,
      prevFamily: { last_portrait: 'X' } // 无 last_analysis_at / updated_at
    })
    expect(db._add.mock.calls[0][0].data.version_at).toEqual(baseArgs.now)
  })

  test('completeness_score 缺失 → 0', async () => {
    const db = makeMockDb()
    await archivePrevious(db, {
      ...baseArgs,
      prevFamily: { last_portrait: 'X' } // 无 completeness_score
    })
    expect(db._add.mock.calls[0][0].data.completeness_score).toBe(0)
  })
})

describe('archivePrevious - 清理旧版本', () => {
  test('查询链：where → orderBy(version_at desc) → skip(keepVersions) → limit(50) → get', async () => {
    const db = makeMockDb({ staleList: [] })
    await archivePrevious(db, baseArgs)
    expect(db._where).toHaveBeenCalledWith({ family_id: 'fam_001', _openid: 'op_test' })
    expect(db._orderBy).toHaveBeenCalledWith('version_at', 'desc')
    expect(db._skip).toHaveBeenCalledWith(3) // keepVersions=3
    expect(db._limit).toHaveBeenCalledWith(50)
    expect(db._get).toHaveBeenCalled()
  })

  test('stale 列表有 2 条 → 调 doc().remove() 2 次', async () => {
    const db = makeMockDb({
      staleList: [{ _id: 'r1' }, { _id: 'r2' }]
    })
    await archivePrevious(db, baseArgs)
    expect(db._doc).toHaveBeenCalledTimes(2)
    expect(db._doc).toHaveBeenCalledWith('r1')
    expect(db._doc).toHaveBeenCalledWith('r2')
    expect(db._remove).toHaveBeenCalledTimes(2)
  })

  test('stale 为空 → 不调 remove', async () => {
    const db = makeMockDb({ staleList: [] })
    await archivePrevious(db, baseArgs)
    expect(db._remove).not.toHaveBeenCalled()
  })

  test('stale.data 为 undefined → 不抛错', async () => {
    const db = makeMockDb()
    db._get.mockResolvedValue({}) // 无 data 字段
    await expect(archivePrevious(db, baseArgs)).resolves.toBeUndefined()
  })

  test('单条 remove 失败 → 不影响其他删除（catch 兜底）', async () => {
    const db = makeMockDb({ staleList: [{ _id: 'r1' }, { _id: 'r2' }] })
    db._remove.mockRejectedValueOnce(new Error('remove failed'))
    await archivePrevious(db, baseArgs)
    // 第二条仍被调用
    expect(db._remove).toHaveBeenCalledTimes(2)
  })
})

describe('archivePrevious - 异常降级', () => {
  test('add 抛错 → console.error，不向上抛', async () => {
    const db = makeMockDb()
    db._add.mockRejectedValue(new Error('DB down'))
    await expect(archivePrevious(db, baseArgs)).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    expect(errSpy.mock.calls[0][0]).toContain('版本归档失败')
  })

  test('where.get 抛错 → console.error，不向上抛', async () => {
    const db = makeMockDb()
    db._get.mockRejectedValue(new Error('query failed'))
    await expect(archivePrevious(db, baseArgs)).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
  })
})
