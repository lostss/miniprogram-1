/**
 * ocrService handlers 单元测试 — 方案 B：ocrOnly + aiExtract + ocrSingle 兼容入口
 *
 * 被测对象：cloudfunctions/ocrService/handlers.js
 * 设计契约：
 *   - ocrOnly: fileIds 校验 + OCR 并发 + 成功/失败聚合（不调用 AI）
 *   - aiExtract: fileId/ocrText 校验 + aiPhase 调用 + error_code 透传
 *   - ocrSingle: 兼容后备入口（ocrPhase + aiPhase 串行）
 *   - matchPolicies: 缺参返回 400；异常经 wrapError 返回 { code: 500, msg: '成员匹配失败：...' }
 *
 * ocrPhase / aiPhase / matchPoliciesToMembers 被 jest.mock 替换以便控制成功/失败分支。
 */
jest.mock('wx-server-sdk', () => ({
  init: jest.fn(),
  DYNAMIC_CURRENT_ENV: 'env-mock',
  database: () => ({ command: {} }),
  getWXContext: () => ({ OPENID: 'mock_openid' })
}))

jest.mock('../cloudfunctions/ocrService/_shared/ocr-core', () => ({
  processOneImage: jest.fn(),
  ocrPhase: jest.fn().mockResolvedValue({ ocrText: 'OCR结果', ocrConfInfo: [], fileId: 'cloud://test', t0: 1000, t1: 1100, t2: 1200 }),
  aiPhase: jest.fn().mockResolvedValue({ success: true, policiesCount: 1, policies: [{ product_name: '测试保单' }], cashValueData: null })
}))

jest.mock('../cloudfunctions/ocrService/_shared/member-matcher', () => ({
  matchPoliciesToMembers: jest.fn()
}))

const { ocrSingle, ocrOnly, aiExtract, matchPolicies } = require('../cloudfunctions/ocrService/handlers')
const { ocrPhase, aiPhase } = require('../cloudfunctions/ocrService/_shared/ocr-core')
const { matchPoliciesToMembers } = require('../cloudfunctions/ocrService/_shared/member-matcher')

const mockDb = { collection: () => ({}) }

describe('ocrService handlers', () => {
  beforeEach(() => {
    // mockReset 清理实现+调用记录，再重置默认成功返回值
    // 避免 mockRejectedValue 残留影响后续测试
    ocrPhase.mockReset()
    aiPhase.mockReset()
    ocrPhase.mockResolvedValue({ ocrText: 'OCR结果', ocrConfInfo: [], fileId: 'cloud://test', t0: 1000, t1: 1100, t2: 1200 })
    aiPhase.mockResolvedValue({ success: true, policiesCount: 1, policies: [{ product_name: '测试保单' }], cashValueData: null })
  })

  // ============================================================
  // ocrOnly — 方案 B 阶段 1：仅 OCR 并发
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

    test('超过 10 张 → 400', async () => {
      const fileIds = Array.from({ length: 11 }, (_, i) => `cloud://f${i}`)
      const res = await ocrOnly(mockDb, 'oid', { fileIds })
      expect(res.code).toBe(400)
      expect(res.msg).toContain('10')
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
  // aiExtract — 方案 B 阶段 2：单图 AI 提取
  // ============================================================
  describe('aiExtract 参数校验', () => {
    test('缺 fileId → 400', async () => {
      const res = await aiExtract(mockDb, 'oid', { ocrText: 'x' })
      expect(res.code).toBe(400)
      expect(res.msg).toContain('fileId')
    })

    test('缺 ocrText → 400', async () => {
      const res = await aiExtract(mockDb, 'oid', { fileId: 'cloud://f1' })
      expect(res.code).toBe(400)
      expect(res.msg).toContain('ocrText')
    })

    test('ocrText 非字符串 → 400', async () => {
      const res = await aiExtract(mockDb, 'oid', { fileId: 'cloud://f1', ocrText: 123 })
      expect(res.code).toBe(400)
    })
  })

  describe('aiExtract AI 调用', () => {
    test('成功 → 返回 policies + cash_value_data', async () => {
      aiPhase.mockResolvedValue({
        success: true,
        policies: [{ product_name: '保单A' }],
        cashValueData: { product_name: 'CV', cash_values: [] },
        document_type: 'mixed'
      })
      const res = await aiExtract(mockDb, 'oid', {
        fileId: 'cloud://f1', ocrText: 'OCR文本', ocrConfInfo: [], t0: 1, t1: 2, t2: 3
      })
      expect(aiPhase).toHaveBeenCalledTimes(1)
      expect(res.code).toBe(200)
      expect(res.data.policies.length).toBe(1)
      expect(res.data.cash_value_data).not.toBeNull()
      expect(res.data.document_type).toBe('mixed')
    })

    test('aiPhase 返回 success:false → error_code 透传', async () => {
      aiPhase.mockResolvedValue({
        success: false,
        error: 'AI服务繁忙',
        error_code: '429'
      })
      const res = await aiExtract(mockDb, 'oid', {
        fileId: 'cloud://f1', ocrText: 'OCR文本'
      })
      expect(res.code).toBe(200)
      expect(res.data.policies).toEqual([])
      expect(res.data.error_code).toBe('429')
      expect(res.data.error).toBe('AI服务繁忙')
    })

    test('aiPhase 抛异常 → error_code 透传（statusCode 优先）', async () => {
      const err = new Error('boom')
      err.statusCode = 429
      aiPhase.mockRejectedValue(err)
      const res = await aiExtract(mockDb, 'oid', {
        fileId: 'cloud://f1', ocrText: 'OCR文本'
      })
      expect(res.code).toBe(200)
      expect(res.data.policies).toEqual([])
      expect(res.data.error_code).toBe('429')
    })

    test('aiPhase 抛异常无 statusCode → error_code=ai_exception', async () => {
      aiPhase.mockRejectedValue(new Error('network'))
      const res = await aiExtract(mockDb, 'oid', {
        fileId: 'cloud://f1', ocrText: 'OCR文本'
      })
      expect(res.data.error_code).toBe('ai_exception')
    })

    test('ocrConfInfo/t0/t1/t2 缺省 → 用默认值兜底', async () => {
      aiPhase.mockResolvedValue({ success: true, policies: [] })
      await aiExtract(mockDb, 'oid', { fileId: 'cloud://f1', ocrText: 'OCR文本' })
      const callArgs = aiPhase.mock.calls[0][0]
      expect(callArgs.ocrConfInfo).toEqual([])
      expect(callArgs.t0).toBeGreaterThan(0)
    })

    test('familyId 透传到 aiPhase', async () => {
      aiPhase.mockResolvedValue({ success: true, policies: [] })
      await aiExtract(mockDb, 'oid', { fileId: 'cloud://f1', ocrText: 'x', familyId: 'fam1' })
      const callArgs = aiPhase.mock.calls[0][0]
      expect(callArgs.familyId).toBe('fam1')
    })

    test('无 cashValueData → cash_value_data 为 null', async () => {
      aiPhase.mockResolvedValue({ success: true, policies: [], cashValueData: null })
      const res = await aiExtract(mockDb, 'oid', { fileId: 'cloud://f1', ocrText: 'x' })
      expect(res.data.cash_value_data).toBeNull()
    })
  })

  // ============================================================
  // ocrSingle — 兼容后备入口（保持原有契约）
  // ============================================================
  describe('ocrSingle 参数校验', () => {
    test('缺 fileIds → 400', async () => {
      const res = await ocrSingle(mockDb, 'oid', {})
      expect(res.code).toBe(400)
      expect(res.msg).toContain('fileIds')
    })

    test('fileIds 非数组 → 400', async () => {
      const res = await ocrSingle(mockDb, 'oid', { fileIds: 'cloud://x' })
      expect(res.code).toBe(400)
    })

    test('fileIds 空数组 → 400', async () => {
      const res = await ocrSingle(mockDb, 'oid', { fileIds: [] })
      expect(res.code).toBe(400)
    })

    test('超过 10 张 → 400', async () => {
      const fileIds = Array.from({ length: 11 }, (_, i) => `cloud://f${i}`)
      const res = await ocrSingle(mockDb, 'oid', { fileIds })
      expect(res.code).toBe(400)
      expect(res.msg).toContain('10')
    })

    test('fileId 非 cloud:// 协议 → 400', async () => {
      const res = await ocrSingle(mockDb, 'oid', { fileIds: ['http://example.com/a.png'] })
      expect(res.code).toBe(400)
      expect(res.msg).toContain('cloud://')
    })
  })

  describe('ocrSingle 兼容入口聚合', () => {
    test('合法 fileIds → 触发 ocrPhase + aiPhase', async () => {
      const res = await ocrSingle(mockDb, 'oid', { fileIds: ['cloud://f1'] })
      expect(ocrPhase).toHaveBeenCalledTimes(1)
      expect(aiPhase).toHaveBeenCalledTimes(1)
      expect(res.code).toBe(200)
      expect(res.data.count).toBe(1)
    })

    test('ocrPhase 抛异常 → failures 聚合 error_code=ocr_failed', async () => {
      ocrPhase.mockRejectedValue(new Error('OCR 识别失败'))
      const res = await ocrSingle(mockDb, 'oid', { fileIds: ['cloud://f1'] })
      expect(res.code).toBe(200)
      expect(res.data.policies).toEqual([])
      expect(res.data.failures.length).toBe(1)
      expect(res.data.failures[0].fileId).toBe('cloud://f1')
      expect(res.data.failures[0].error_code).toBe('ocr_failed')
    })

    test('全部失败 → 返回首项 error_code', async () => {
      ocrPhase.mockRejectedValue(new Error('boom'))
      const res = await ocrSingle(mockDb, 'oid', { fileIds: ['cloud://f1', 'cloud://f2'] })
      expect(res.code).toBe(200)
      expect(res.data.error_code).toBe('ocr_failed')
      expect(res.data.count).toBe(0)
      expect(res.data.failures.length).toBe(2)
    })

    test('aiPhase 成功带 cashValueData → 聚合到 cash_values', async () => {
      ocrPhase.mockResolvedValue({ ocrText: 'x', ocrConfInfo: [], fileId: 'cloud://f1', t0: 1, t1: 2, t2: 3 })
      aiPhase.mockResolvedValue({
        success: true,
        policies: [],
        cashValueData: { product_name: 'CV', cash_values: [] }
      })
      const res = await ocrSingle(mockDb, 'oid', { fileIds: ['cloud://f1'] })
      expect(res.data.cash_values.length).toBe(1)
      expect(res.data.cash_values[0].product_name).toBe('CV')
    })

    test('全部成功无失败 → failures 为 undefined', async () => {
      const res = await ocrSingle(mockDb, 'oid', { fileIds: ['cloud://f1'] })
      expect(res.data.failures).toBeUndefined()
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
