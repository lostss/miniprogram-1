/**
 * cleanup 定时任务 — PDF 保留期与日志保留期**解耦**（2026-09-20 复核批次 B）
 *
 * 回归点：报告 PDF 的保留期不能跟随日志的默认 90 天（产品口径是 30 天）。
 * 这两者看起来就是同一个概念（都叫"保留期"），极易被后人"顺手统一成一个 retentionDays"
 * 改回去 —— 故此处用断言锁死：改 retentionDays 不得影响 PDF，反之亦然。
 */
process.env.NODE_ENV = 'production'

jest.mock('wx-server-sdk', () => {
  const command = {
    lt: (v) => ({ op: 'lt', v }),
    in: (arr) => ({ op: 'in', arr })
  }
  const collection = jest.fn(() => ({
    where: () => ({
      remove: async () => ({ stats: { removed: 0 } }),
      limit: () => ({ get: async () => ({ data: [] }) })
    }),
    add: async () => ({ _id: 'x' })
  }))
  return {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    // 定时触发无用户上下文 → 走 prune 分支
    getWXContext: jest.fn(() => ({})),
    database: jest.fn(() => ({ command, collection, createCollection: jest.fn() }))
  }
})

const cleanup = require('../cloudfunctions/cleanup/index')

describe('cleanup · prune 保留期', () => {
  test('定时任务：PDF 保留期 30 天，且 report_files 统计进入 results', async () => {
    const r = await cleanup.main({})
    expect(r.code).toBe(200)
    const pdf = r.results.filter(x => x.collection === 'report_files')
    expect(pdf.length).toBe(1)
    expect(pdf[0].retentionDays).toBe(30)
    // 4 个日志/事实集合的清理仍在（未被 PDF 那一步挤掉）
    const logs = r.results.filter(x => ['agent_logs', 'operation_logs', 'undo_logs', 'facts'].includes(x.collection))
    expect(logs.length).toBe(4)
  })

  test('改 retentionDays **不影响** PDF 保留期（解耦的核心断言）', async () => {
    const r = await cleanup.main({ retentionDays: 7 })
    expect(r.results.filter(x => x.collection === 'report_files')[0].retentionDays).toBe(30)
  })

  test('reportRetentionDays 可独立覆盖 PDF 保留期', async () => {
    const r = await cleanup.main({ reportRetentionDays: 3 })
    expect(r.results.filter(x => x.collection === 'report_files')[0].retentionDays).toBe(3)
  })

  test('保留期入参非法/越界 → 夹到 [1,365]', async () => {
    const r1 = await cleanup.main({ reportRetentionDays: -5 })
    expect(r1.results.filter(x => x.collection === 'report_files')[0].retentionDays).toBe(1)
    const r2 = await cleanup.main({ reportRetentionDays: 9999 })
    expect(r2.results.filter(x => x.collection === 'report_files')[0].retentionDays).toBe(365)
  })
})
