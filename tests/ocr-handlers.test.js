/**
 * ocrService handlers 单元测试 — 保留两套识别方案
 *
 * 被测对象：cloudfunctions/ocrService/handlers.js
 * 设计契约：
 *   - ocrOnly: fileIds 校验 + OCR 并发 + 成功/失败聚合（不调用 AI）
 *
 * 注：aiExtractBatch / aiExtractParallel 由 batchHandler.test.js / parallelHandler.test.js 覆盖
 *     ocrPhase / aiPhase 被 jest.mock 替换以便控制成功/失败分支。
 *     matchPolicies handler 已下线（清理审计：前端零调用，成员匹配走 dataWrite writePoliciesBatch）。
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

const { ocrOnly } = require('../cloudfunctions/ocrService/handlers')
const { ocrPhase } = require('../cloudfunctions/ocrService/_shared/ocr-core')
const { _desensitizeWithPolicyProtect } = require('../cloudfunctions/ocrService/_shared/ocr-extractor')

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
      const fileIds = Array.from({ length: 10 }, (_, i) => `cloud://env.xxx/temp/oid/f${i}.jpg`)
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
      const res = await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://env.xxx/temp/oid/f1.jpg', 'cloud://env.xxx/temp/oid/f2.jpg'] })
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
      const res = await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://env.xxx/temp/oid/f1.jpg', 'cloud://env.xxx/temp/oid/f2.jpg'] })
      expect(res.code).toBe(200)
      expect(res.data.ocr_results).toEqual([])
      expect(res.data.failures.length).toBe(2)
      expect(res.data.failures[0].error_code).toBe('ocr_failed')
      expect(res.data.failures[0].fileId).toBe('cloud://env.xxx/temp/oid/f1.jpg')
    })

    test('ocrPhase 部分失败 → 同时返回 ocr_results 和 failures', async () => {
      ocrPhase
        .mockResolvedValueOnce({ ocrText: 'A', ocrConfInfo: [], fileId: 'cloud://env.xxx/temp/oid/ok.jpg', t0: 1, t1: 2, t2: 3 })
        .mockRejectedValueOnce(new Error('bad'))
      const res = await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://env.xxx/temp/oid/ok.jpg', 'cloud://env.xxx/temp/oid/bad.jpg'] })
      expect(res.code).toBe(200)
      expect(res.data.ocr_results.length).toBe(1)
      expect(res.data.ocr_results[0].fileId).toBe('cloud://env.xxx/temp/oid/ok.jpg')
      expect(res.data.failures.length).toBe(1)
      expect(res.data.failures[0].fileId).toBe('cloud://env.xxx/temp/oid/bad.jpg')
    })

    test('OCR 识别为空文本 → 标记 ocr_empty', async () => {
      ocrPhase.mockResolvedValue({ ocrText: '', ocrConfInfo: [], fileId: 'cloud://env.xxx/temp/oid/f1.jpg', t0: 1, t1: 2, t2: 3 })
      const res = await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://env.xxx/temp/oid/f1.jpg'] })
      expect(res.data.ocr_results).toEqual([])
      expect(res.data.failures.length).toBe(1)
      expect(res.data.failures[0].error_code).toBe('ocr_empty')
    })

    test('全部成功 → failures 为 undefined', async () => {
      const res = await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://env.xxx/temp/oid/f1.jpg'] })
      expect(res.data.failures).toBeUndefined()
    })

    test('familyId 透传到 ocrPhase', async () => {
      await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://env.xxx/temp/oid/f1.jpg'], familyId: 'fam1' })
      const callArgs = ocrPhase.mock.calls[0][0]
      expect(callArgs.familyId).toBe('fam1')
    })

    test('无 familyId → ocrPhase 收到 null', async () => {
      await ocrOnly(mockDb, 'oid', { fileIds: ['cloud://env.xxx/temp/oid/f1.jpg'] })
      const callArgs = ocrPhase.mock.calls[0][0]
      expect(callArgs.familyId).toBeNull()
    })
  })

  // ===== OCR 审计 H1：计费 OCR 入口频控 =====
  describe('ocrOnly 频控（OCR 审计 H1）', () => {
    test('60s 内已达 10 批 → 429 限流', async () => {
      const db = {
        command: { gte: v => ({ $gte: v }) },
        collection: jest.fn(() => ({
          where: jest.fn(() => ({ count: jest.fn(() => Promise.resolve({ total: 10 })) }))
        }))
      }
      const res = await ocrOnly(db, 'oid', { fileIds: ['cloud://env.xxx/temp/oid/f1.jpg'] })
      expect(res.code).toBe(429)
    })

    test('未超限（5 批）→ 正常执行 OCR', async () => {
      const db = {
        command: { gte: v => ({ $gte: v }) },
        collection: jest.fn(() => ({
          where: jest.fn(() => ({ count: jest.fn(() => Promise.resolve({ total: 5 })) })),
          add: jest.fn(() => Promise.resolve({ _id: 'x' }))
        }))
      }
      const res = await ocrOnly(db, 'oid', { fileIds: ['cloud://env.xxx/temp/oid/f1.jpg'] })
      expect(res.code).toBe(200)
    })

    test('频控查询异常（无 command）→ 放行不阻断 OCR', async () => {
      const db = { collection: () => ({}) }
      const res = await ocrOnly(db, 'oid', { fileIds: ['cloud://env.xxx/temp/oid/f1.jpg'] })
      expect(res.code).toBe(200)
    })
  })

  // ===== OCR 审计 H3：PII 脱敏前保单号保护 =====
  describe('_desensitizeWithPolicyProtect（OCR 审计 H3）', () => {
    test('16 位纯数字保单号（带标签）不被银行卡规则误伤', () => {
      const text = '保单号：1234567890123456，投保人：张三'
      expect(_desensitizeWithPolicyProtect(text)).toContain('1234567890123456')
      expect(_desensitizeWithPolicyProtect(text)).not.toContain('****')
    })

    test('18 位纯数字保单号（带标签）不被误伤', () => {
      const text = '合同号:123456789012345678 保费1000元'
      expect(_desensitizeWithPolicyProtect(text)).toContain('123456789012345678')
    })

    test('无标签的 16 位数字仍保守脱敏（PII 不泄漏）', () => {
      const text = '银行卡 6222021234567890'
      const out = _desensitizeWithPolicyProtect(text)
      expect(out).not.toContain('6222021234567890')
      expect(out).toContain('****')
    })

    test('带标签保单号 + 手机号同现：保单号保留、手机号脱敏', () => {
      const text = '保单号:1234567890123456 手机号13812345678'
      const out = _desensitizeWithPolicyProtect(text)
      expect(out).toContain('1234567890123456')
      expect(out).not.toContain('13812345678')
    })

    test('字母数字混合保单号（含标签）原样保留', () => {
      const text = '保单号：P12345678901234567890，保额50万'
      const out = _desensitizeWithPolicyProtect(text)
      expect(out).toContain('P12345678901234567890')
    })
  })
})
