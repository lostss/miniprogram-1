/**
 * ocrService handlers 单元测试 — 保留两套识别方案
 *
 * 被测对象：cloudfunctions/ocrService/handlers.js
 * 设计契约：
 *   - ocrOnly: fileIds 校验 + OCR 并发 + 成功/失败聚合（不调用 AI）
 *   - matchPolicies: 缺参返回 400；异常经 wrapError 返回 { code: 500, msg: '成员匹配失败：...' }
 *
 * 注：aiExtractBatch / aiExtractParallel 由 batchHandler.test.js / parallelHandler.test.js 覆盖
 *     ocrPhase / aiPhase / matchPoliciesToMembers 被 jest.mock 替换以便控制成功/失败分支。
 */
jest.mock('wx-server-sdk', () => ({
  init: jest.fn(),
  DYNAMIC_CURRENT_ENV: 'env-mock',
  database: () => ({ command: {} }),
  getWXContext: () => ({ OPENID: 'mock_openid' })
}))

jest.mock('../cloudfunctions/ocrService/_shared/ocr-core', () => ({
  ocrPhase: jest.fn().mockResolvedValue({ ocrText: 'OCR结果', ocrConfInfo: [], fileId: 'cloud://test', t0: 1000, t1: 1100, t2: 1200 }),
  aiPhase: jest.fn().mockResolvedValue({ success: true, policiesCount: 1, policies: [{ product_name: '测试保单' }], cashValueData: null })
}))

jest.mock('../cloudfunctions/ocrService/_shared/member-matcher', () => ({
  matchPoliciesToMembers: jest.fn()
}))

const { ocrOnly, matchPolicies } = require('../cloudfunctions/ocrService/handlers')
const { ocrPhase } = require('../cloudfunctions/ocrService/_shared/ocr-core')
const { matchPoliciesToMembers } = require('../cloudfunctions/ocrService/_shared/member-matcher')

const mockDb = { collection: () => ({}) }

describe('ocrService handlers', () => {
  beforeEach(() => {
    // mockReset 清理实现+调用记录，再重置默认成功返回值
    // 避免 mockRejectedValue 残留影响后续测试
    ocrPhase.mockReset()
    ocrPhase.mockResolvedValue({ ocrText: 'OCR结果', ocrConfInfo: [], fileId: 'cloud://test', t0: 1000, t1: 1100, t2: 1200 })
  })

  // ============================================================
  // ocrOnly — 阶段 1：仅 OCR 并发
  // ============================================================
  describe('ocrOnly 参数校验', () => {
    test('缺 fileIds → 400', async () => {
      const res = await ocrOnly(mockDb, 'oid', {})
      expect(res.code).toBe(400)
      expect(res.msg).toContain('fileIds')
    })

    test('fileIds 非数组 → 400', async () => {
      const res = await ocrOnly(mockDb, 'oid', { fileIds: 'cloud://x' })
      expect(res.code).toBe(400)
    })

    test('fileIds 空数组 → 400', async () => {
      const res = await ocrOnly(mockDb, 'oid', { fileIds: [] })
      expect(res.code).toBe(400)
    })

    test('超过 9 张 → 400', async () => {
      const fileIds = Array.from({ length: 10 }, (_, i) => `cloud://f${i}`)
      const res = await ocrOnly(mockDb, 'oid', { fileIds })
      expect(res.code).toBe(400)
      expect(res.msg).toContain('9')
    })

    test('fileId 非 cloud:// 协议 → 400', async () => {
      const res = await ocrOnly(mockDb, 'oid', { fileIds: ['http://example.com/a.png'] })
      expect(res.code).toBe(400)
      expect(res.msg).toContain('cloud://')
    })
  })

  describe('ocrOnly OCR 聚合', () => {
    test('合法 fileIds → 并发触发 ocrPhase，返回 ocr_results', async () => {
      const res = await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://f1', 'cloud://f2'] })
      expect(ocrPhase).toHaveBeenCalledTimes(2)
      expect(res.code).toBe(200)
      expect(res.data.ocr_results.length).toBe(2)
      expect(res.data.ocr_results[0]).toHaveProperty('fileId')
      expect(res.data.ocr_results[0]).toHaveProperty('ocrText')
      expect(res.data.ocr_results[0]).toHaveProperty('ocrConfInfo')
      expect(res.data.ocr_results[0]).toHaveProperty('t0')
      expect(res.data.failures).toBeUndefined()
    })

    test('ocrPhase 全部失败 → ocr_results 空, failures 聚合', async () => {
      ocrPhase.mockRejectedValue(new Error('OCR 识别失败'))
      const res = await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://f1', 'cloud://f2'] })
      expect(res.code).toBe(200)
      expect(res.data.ocr_results).toEqual([])
      expect(res.data.failures.length).toBe(2)
      expect(res.data.failures[0].error_code).toBe('ocr_failed')
      expect(res.data.failures[0].fileId).toBe('cloud://f1')
    })

    test('ocrPhase 部分失败 → 同时返回 ocr_results 和 failures', async () => {
      ocrPhase
        .mockResolvedValueOnce({ ocrText: 'A', ocrConfInfo: [], fileId: 'cloud://ok', t0: 1, t1: 2, t2: 3 })
        .mockRejectedValueOnce(new Error('bad'))
      const res = await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://ok', 'cloud://bad'] })
      expect(res.code).toBe(200)
      expect(res.data.ocr_results.length).toBe(1)
      expect(res.data.ocr_results[0].fileId).toBe('cloud://ok')
      expect(res.data.failures.length).toBe(1)
      expect(res.data.failures[0].fileId).toBe('cloud://bad')
    })

    test('OCR 识别为空文本 → 标记 ocr_empty', async () => {
      ocrPhase.mockResolvedValue({ ocrText: '', ocrConfInfo: [], fileId: 'cloud://f1', t0: 1, t1: 2, t2: 3 })
      const res = await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://f1'] })
      expect(res.data.ocr_results).toEqual([])
      expect(res.data.failures.length).toBe(1)
      expect(res.data.failures[0].error_code).toBe('ocr_empty')
    })

    test('全部成功 → failures 为 undefined', async () => {
      const res = await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://f1'] })
      expect(res.data.failures).toBeUndefined()
    })

    test('familyId 透传到 ocrPhase', async () => {
      await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://f1'], familyId: 'fam1' })
      const callArgs = ocrPhase.mock.calls[0][0]
      expect(callArgs.familyId).toBe('fam1')
    })

    test('无 familyId → ocrPhase 收到 null', async () => {
      await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://f1'] })
      const callArgs = ocrPhase.mock.calls[0][0]
      expect(callArgs.familyId).toBeNull()
    })
  })

  // ============================================================
  // matchPolicies
  // ============================================================
  describe('matchPolicies', () => {
    test('缺 familyId → 400', async () => {
      const res = await matchPolicies(mockDb, 'oid', { policies: [] })
      expect(res.code).toBe(400)
      expect(res.msg).toContain('familyId')
    })

    test('policies 非数组 → 400', async () => {
      const res = await matchPolicies(mockDb, 'oid', { familyId: 'f1', policies: 'not-array' })
      expect(res.code).toBe(400)
      expect(res.msg).toContain('policies')
    })

    test('matchPoliciesToMembers 抛错 → wrapError 返回 500 + "成员匹配失败"', async () => {
      matchPoliciesToMembers.mockRejectedValue(new Error('db error'))
      const res = await matchPolicies(mockDb, 'oid', { familyId: 'f1', policies: [{ insured_name: 'A' }] })
      expect(res.code).toBe(500)
      expect(res.msg).toContain('成员匹配失败')
      expect(res.msg).toContain('db error')
    })

    test('matchPoliciesToMembers 成功 → 返回 matched:true', async () => {
      matchPoliciesToMembers.mockResolvedValue({})
      const res = await matchPolicies(mockDb, 'oid', { familyId: 'f1', policies: [{ insured_name: 'A' }] })
      expect(res.code).toBe(200)
      expect(res.data.matched).toBe(true)
    })
  })
})
