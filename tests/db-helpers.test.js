/**
 * db-helpers.safeQueryAll 单测（2026-09-10 新增）
 *
 * 背景：CloudBase 服务端单次 get 上限 100 条，超出被静默截断。
 * safeQueryAll 通过 skip 分页取全量，是"报告缺保障"事故（v2-context 只读到 100/118 条）的通用修法。
 */
const { safeQueryAll } = require('../cloudfunctions/conversationAI/_shared/db-helpers')

// 按页返回数据的 db 桩：记录每次调用参数，便于断言分页与 _openid 注入
function makeDb(pages) {
  const calls = []
  let i = 0
  const db = {
    _calls: calls,
    collection: (name) => ({
      where: (w) => ({
        skip: (n) => ({
          limit: (l) => ({
            get: () => {
              calls.push({ name, where: w, skip: n, limit: l })
              return Promise.resolve({ data: pages[i++] || [] })
            }
          })
        })
      })
    })
  }
  return db
}

describe('safeQueryAll — 分页取全量', () => {
  test('不足一页：单次查询即返回，truncated=false', async () => {
    const db = makeDb([[{ _id: 'a' }, { _id: 'b' }]])
    const r = await safeQueryAll(db, 'facts', { family_id: 'f1' }, 'o1')
    expect(r.data).toHaveLength(2)
    expect(r.truncated).toBe(false)
    expect(db._calls).toHaveLength(1)
    expect(db._calls[0].where._openid).toBe('o1') // _openid 强制注入
    expect(db._calls[0].limit).toBe(100)
  })

  test('满页 + 不满页：自动翻页并合并结果', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ _id: 'p' + i }))
    const page2 = Array.from({ length: 18 }, (_, i) => ({ _id: 'q' + i }))
    const db = makeDb([page1, page2])
    const r = await safeQueryAll(db, 'facts', { family_id: 'f1' }, 'o1')
    expect(r.data).toHaveLength(118) // 118 条（正是报告事故里的真实数量）
    expect(r.truncated).toBe(false)
    expect(db._calls.map(c => c.skip)).toEqual([0, 100])
  })

  test('达到 maxPages 仍有数据：truncated=true（不静默）', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ _id: 'x' + i }))
    const db = makeDb([full, full, full])
    const r = await safeQueryAll(db, 'facts', { family_id: 'f1' }, 'o1', { maxPages: 3 })
    expect(r.data).toHaveLength(300)
    expect(r.truncated).toBe(true)
    expect(db._calls).toHaveLength(3)
  })

  test('查询异常：不抛出，记日志并返回已取数据', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      collection: () => ({
        where: () => ({
          skip: () => ({ limit: () => ({ get: () => Promise.reject(new Error('db down')) }) })
        })
      })
    }
    const r = await safeQueryAll(db, 'facts', { family_id: 'f1' }, 'o1')
    expect(r.data).toEqual([])
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
