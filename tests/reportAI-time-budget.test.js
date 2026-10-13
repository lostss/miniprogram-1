/**
 * reportAI 时间预算不变量（2026-09-28，收尾 dsh 审计 ④ 的残留疑点）
 *
 * 疑点原文：「`_canRetryParseFailure`（重写与解析重试共用）的判定是预测式的，但**那 5s 尾部预留
 * 是否够重写后的 DB 往返，未验**」。
 *
 * 结论：够，且余量很大（约 10~100×）—— 依据见 README 2026-09-28 行的证据链。本文件钉住的是
 * **让"5s 一定存在"成立的那些不变量**，防止有人日后把预算改坏：
 *   ① 判定式必须保证：最大允许 spentMs + 单次超时 ≤ 函数时限 − 尾部预留（尾部一定有 5s）
 *   ② 去重重写与解析重试**共用同一判定**（重写不能绕过预算检查）
 *   ③ 尾部步骤顺序：释放 CAS 锁必须早于 advanceStage / 写日志（锁被函数杀在半路 = 30s 误节流）
 */
const path = require('path')
const fs = require('fs')
const { _canRetryParseFailure } = require('../cloudfunctions/reportAI/index')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'reportAI', 'index.js'), 'utf-8')

describe('reportAI 时间预算不变量', () => {
  test('① 通过判定的最大耗时 + 单次超时，不击穿函数时限（尾部预留必然还剩满额）', () => {
    // 二分出"仍允许重试"的最大 spentMs（不引用实现里的常量，只验证性质）
    let ok = 0
    for (let ms = 0; ms <= 60000; ms += 100) {
      if (_canRetryParseFailure(ms)) ok = ms
    }
    expect(ok).toBeGreaterThan(0)
    // 该点再发一次 40s 后仍须留出尾部空间：40s 来自实现（ATTEMPT_TIMEOUT_MS），
    // 函数时限 60s —— 断言"最坏总耗时 <= 55s"，即尾部至少 5s
    expect(ok + 40000).toBeLessThanOrEqual(55000)
    // 且不该保守到离谱（否则重试形同虚设）：边界应落在 15s 附近
    expect(ok).toBeGreaterThanOrEqual(14000)
    expect(ok).toBeLessThanOrEqual(15000)
  })

  test('② 判定是"预测式"：耗时越多越不可能重试（单调）', () => {
    expect(_canRetryParseFailure(0)).toBe(true)
    expect(_canRetryParseFailure(10000)).toBe(true)
    expect(_canRetryParseFailure(20000)).toBe(false)
    expect(_canRetryParseFailure(40000)).toBe(false)
  })

  test('③ 去重重写与解析重试共用同一判定（重写不得绕过预算）', () => {
    // 去重重写处（retryWorthy）必须先过 _canRetryParseFailure
    expect(SRC).toMatch(/retryWorthy\.length\s*>\s*0\s*&&\s*_canRetryParseFailure\(/)
    // 解析失败重试处同样
    expect(SRC).toMatch(/if\s*\(!_canRetryParseFailure\(/)
    // 预算不足时必须有"未重写"的告警（否则静默退化，事后无从发现）
    expect(SRC).toContain('剩余时间不足，未重写')
  })

  test('④ 尾部顺序：先释放 CAS 锁，再 advanceStage / 写日志（半路被杀不留下 30s 误节流）', () => {
    const iRelease = SRC.indexOf('await _releaseLock()')
    const iAdvance = SRC.indexOf('await advanceStage(db, familyId, openid)')
    const iLog = SRC.indexOf("action: 'report_generate'")
    expect(iRelease).toBeGreaterThan(-1)
    expect(iAdvance).toBeGreaterThan(iRelease)
    expect(iLog).toBeGreaterThan(iRelease)
  })

  test('⑤ 单次调用无内部重试层（否则 40s 假设不成立，预算整体失真）', () => {
    // reportAI 不得引入 withRetry（retry.js 默认 maxAttempts=1，但若被显式用于本链路，
    // "单次 40s 上界"就不成立 → 预算需重算）
    expect(SRC).not.toMatch(/withRetry|maxAttempts/)
    // 超时以 timeoutMs 传入且只有一个 timeoutMs 取值来源（ATTEMPT_TIMEOUT_MS）
    expect(SRC).toMatch(/timeoutMs:\s*ATTEMPT_TIMEOUT_MS/)
  })
})
