/**
 * report-share 单测 — 报告分享域纯逻辑（从 pages/report/index.js 剥离）
 */
const { buildShareTitle, buildSharePath, buildReportMeta, ensureShareToken } = require('../miniprogram/utils/report-share')

describe('buildShareTitle — 分享标题（三行中性化）', () => {
  test('家庭名 + 日期 → 三行标题', () => {
    const t = buildShareTitle('李阳勇家庭', '2026年08月08日 14:30')
    expect(t).toBe('李阳勇家庭保障检视报告\n保障一览\n2026年08月08日 14:30')
  })

  test('家庭名已含"家庭"后缀不重复拼接', () => {
    const t = buildShareTitle('李**家庭', '2026-08-08')
    expect(t.startsWith('李**家庭保障检视报告')).toBe(true)
    expect(t.indexOf('家庭家庭')).toBe(-1)
  })

  test('空名称兜底"家庭"', () => {
    const t = buildShareTitle('', '')
    expect(t.startsWith('家庭保障检视报告')).toBe(true)
  })

  test('超长截断至 60 字', () => {
    const t = buildShareTitle('非常非常非常非常非常非常非常非常非常非常长的家庭名称', '2026年08月08日 14:30')
    expect(t.length).toBeLessThanOrEqual(60)
  })
})

describe('buildSharePath — 分享路径', () => {
  test('token 优先（客户版）', () => {
    expect(buildSharePath('abc123', 'fam_1')).toBe('/pages/report/index?token=abc123&share=1')
  })

  test('无 token 兜底 familyId（旧路径）', () => {
    expect(buildSharePath('', 'fam_1')).toBe('/pages/report/index?familyId=fam_1')
  })
})

describe('buildReportMeta — 报告封面元数据', () => {
  test('updated_at 优先', () => {
    const r = buildReportMeta({ updated_at: '2026-01-02T03:04:05', last_analysis_at: '2025-01-01T00:00:00' })
    expect(r.dateTime).toMatch(/^2026年01月02日 03:04$/)
  })

  test('无 updated_at 用 last_analysis_at 兜底', () => {
    const r = buildReportMeta({ last_analysis_at: '2025-06-15T12:30:00' })
    expect(r.dateTime).toMatch(/^2025年06月15日 12:30$/)
  })

  test('无时间字段回退当前时间（仍合法格式）', () => {
    const r = buildReportMeta({})
    expect(r.dateTime).toMatch(/^\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}$/)
  })

  test('无效日期回退当前时间', () => {
    const r = buildReportMeta({ updated_at: 'not-a-date' })
    expect(r.dateTime).toMatch(/^\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}$/)
  })
})

describe('ensureShareToken — token 懒生成', () => {
  test('成功返回 token', async () => {
    const api = async () => ({ ok: true, data: { token: 'tok_1' } })
    expect(await ensureShareToken(api, 'fam_1')).toBe('tok_1')
  })

  test('失败静默返回 null', async () => {
    const api = async () => ({ ok: false, code: 500 })
    expect(await ensureShareToken(api, 'fam_1')).toBeNull()
  })

  test('api 抛错静默返回 null', async () => {
    const api = async () => { throw new Error('network') }
    expect(await ensureShareToken(api, 'fam_1')).toBeNull()
  })

  test('cid 为空直接返回 null（不调 api）', async () => {
    const api = jest.fn()
    expect(await ensureShareToken(api, '')).toBeNull()
    expect(api).not.toHaveBeenCalled()
  })
})
