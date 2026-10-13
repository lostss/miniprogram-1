/**
 * report-share 单测 — 报告分享域纯逻辑（从 pages/report/index.js 剥离）
 */
const { buildShareTitle, buildSharePath, buildReportMeta, ensureShareToken, shareExpireHint } = require('../miniprogram/utils/report-share')

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

  // 2026-09-20 流程审计 P2-6：无 token 时原返回 owner 形态的 ?familyId= 链接 →
  // 客户以自己的 openid 打开后按 owner 分支调 getFamily，看到 404「客户不存在」/ 401「登录异常」。
  test('无 token → 仍带 share=1（客户侧得到明确的"链接已失效"，而非 owner 404）', () => {
    const p = buildSharePath('', 'fam_1')
    expect(p).toBe('/pages/report/index?share=1')
    expect(p).not.toContain('familyId') // 不得退化成 owner 形态（familyId 在共享分支无任何消费方）
  })

  test('share=1 与页面共享分支的处置配套（缺它则退回裸 404）', () => {
    // 页面 onLoad：`if (o.share === '1' || token)` → 进共享分支 → token 为空 ⇒ showModal「链接已失效」。
    // 本断言锁死"路径参数"与"页面分支"的配对，任一侧被改都会红。
    const fs = require('fs')
    const path = require('path')
    const page = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/report/index.js'), 'utf8')
    expect(page).toContain("if (o.share === '1' || token)")
    expect(page).toContain('缺少分享凭证')
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

describe('ensureShareToken — token 懒生成（2026-09-19 UX4：连 expiresAt 一起返回）', () => {
  test('成功返回 token + expiresAt（后端一直有 expiresAt，原先只取 token 就丢了）', async () => {
    const exp = Date.now() + 7 * 86400000
    const api = async () => ({ ok: true, data: { token: 'tok_1', expiresAt: exp } })
    expect(await ensureShareToken(api, 'fam_1')).toEqual({ token: 'tok_1', expiresAt: exp })
  })

  test('后端未给 expiresAt → 归零（不抛错，视图侧文案为空即不渲染）', async () => {
    const api = async () => ({ ok: true, data: { token: 'tok_1' } })
    expect(await ensureShareToken(api, 'fam_1')).toEqual({ token: 'tok_1', expiresAt: 0 })
  })

  test('无 token → null（不能返回只有 expiresAt 的空壳）', async () => {
    const api = async () => ({ ok: true, data: { expiresAt: Date.now() } })
    expect(await ensureShareToken(api, 'fam_1')).toBeNull()
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

describe('shareExpireHint — 剩余有效期文案（UX4）', () => {
  test('7 天后到期 → 剩余 7 天', () => {
    expect(shareExpireHint(Date.now() + 7 * 86400000)).toBe('分享链接有效期剩余 7 天')
  })

  test('不足一天 → 仍显示 1 天（向上取整，不显示 0 天）', () => {
    expect(shareExpireHint(Date.now() + 3600 * 1000)).toBe('分享链接有效期剩余 1 天')
  })

  test('已过期 → 提示会自动重新生成（而非静默）', () => {
    expect(shareExpireHint(Date.now() - 1000)).toContain('已过期')
  })

  test('缺省/无效时间戳 → 空串（视图 wx:if 不渲染）', () => {
    expect(shareExpireHint(0)).toBe('')
    expect(shareExpireHint(undefined)).toBe('')
    expect(shareExpireHint(null)).toBe('')
  })
})
