/**
 * report-dedup — 报告重复度检查（2026-09-22 数据质量批次 2）
 *
 * 背景：prompt 第 9 条早已规定"同一句判断或口号全篇最多出现 2 次"（2026-09-10 线上实测：
 * 同一结论在 7 个模块各说一遍），但那条规则只是文字、没有机器校验。真实报告实测：
 * 「寿险为零／拿不到一分寿险赔付」出现在 5 个模块、「航空意外专属」4 个模块。
 *
 * 本文件同时**显式记录该检测器的已知局限**（只能抓字面重复、抓不到改写）——
 * 它是可观测性与重写触发器，不是质量门禁。
 */
const { findRepetitions, buildRetryHint, FIELDS, RETRY_MIN_FIELDS } = require('../cloudfunctions/reportAI/report-dedup')

// 一段文案出现在指定几段里
function mk(fieldMap) {
  const base = { portrait: '', summary: '', review: '', analysis: '', plan: '', conclusion: '', suggestions: '' }
  return Object.assign(base, fieldMap)
}

describe('findRepetitions — 字面重复检测', () => {
  // 夹具按**真实报告**的分布来：2026-09-22 实测「寿险为零 / 拿不到一分寿险赔付」
  // 出现在 结论、摘要、review、建议 四处（核心洞察里的那处不在本检测器的 7 段内）
  test('同一句话出现在 4 段 → 命中，且够重写门槛（真实报告的违规分布）', () => {
    const hits = findRepetitions(mk({
      summary: '李阳勇寿险为零，家庭缺口集中在他身上。',
      review: '看下来李阳勇寿险为零，医疗险倒是够用。',
      conclusion: '他倒下时家里拿不到一分寿险赔付——李阳勇寿险为零。',
      suggestions: '为李阳勇补充定期寿险：目前李阳勇寿险为零。'
    }))
    expect(hits.length).toBe(1) // 相邻滑窗已合并、并扩展成完整短语
    expect(hits[0].phrase).toBe('李阳勇寿险为零')
    expect(hits[0].count).toBe(4)
    expect(hits[0].fields.sort()).toEqual(['conclusion', 'review', 'suggestions', 'summary'])
    expect(hits[0].count).toBeGreaterThanOrEqual(RETRY_MIN_FIELDS) // → 会触发一次重写
  })

  test('只出现在 2 段 → 不命中（阈值内）', () => {
    const hits = findRepetitions(mk({
      summary: '李阳勇寿险为零。',
      review: '李阳勇寿险为零，医疗险够用。'
    }))
    expect(hits).toEqual([])
  })

  test('标点/全角差异不影响判定（gram 先剥标点）', () => {
    const hits = findRepetitions(mk({
      summary: '李阳勇寿险为零，缺口集中。',
      review: '李阳勇寿险为零！医疗险够用。',
      suggestions: '李阳勇寿险为零（最要紧）。'
    }))
    expect(hits.some(h => h.phrase === '李阳勇寿险为零')).toBe(true)
  })

  test('suggestions 为数组时同样处理（AI 偶发输出数组）', () => {
    const hits = findRepetitions(mk({
      summary: '李阳勇寿险为零，缺口集中。',
      review: '李阳勇寿险为零，医疗险够用。',
      suggestions: ['建议一：李阳勇寿险为零，需补齐', '建议二：意外险也要看']
    }))
    expect(hits.some(h => h.count >= 3)).toBe(true)
  })

  test('按跨段数降序，且不超过回传上限', () => {
    const hits = findRepetitions(mk({
      portrait: '甲甲甲甲甲甲甲',
      summary: '乙乙乙乙乙乙乙',
      review: '甲甲甲甲甲甲甲 乙乙乙乙乙乙乙',
      analysis: '甲甲甲甲甲甲甲',
      plan: '甲甲甲甲甲甲甲 乙乙乙乙乙乙乙'
    }))
    expect(hits.length).toBe(2) // 甲跨 4 段、乙跨 3 段
    expect(hits[0].count).toBeGreaterThanOrEqual(hits[hits.length - 1].count)
    expect(hits.length).toBeLessThanOrEqual(8)
  })

  test('空/缺失字段安全（不抛错、不误报）', () => {
    expect(findRepetitions({})).toEqual([])
    expect(findRepetitions(null)).toEqual([])
    expect(findRepetitions(mk({ summary: '很短' }))).toEqual([])
  })

  // ⚠️ 已知局限，显式钉住：改写的重复抓不到。这不是 bug —— 正因如此它只用于
  // 记日志与"最多重写一次"，绝不做质量门禁（报告不能因为啰嗦而失败）。
  test('已知局限：语义改写抓不到（"寿险为零" vs "拿不到一分寿险赔付"）', () => {
    const hits = findRepetitions(mk({
      summary: '李阳勇寿险为零。',
      review: '李阳勇没有身故保障。',
      analysis: '他若倒下家里拿不到一分赔付。'
    }))
    expect(hits).toEqual([])
  })

  test('字段清单与报告契约一致（7 段正文）', () => {
    expect(FIELDS).toEqual(['portrait', 'summary', 'review', 'analysis', 'plan', 'conclusion', 'suggestions'])
  })

  test('重写门槛高于记日志门槛（防合法术语触发双倍 token）', () => {
    expect(RETRY_MIN_FIELDS).toBeGreaterThan(3)
  })
})

describe('buildRetryHint — 重写提示', () => {
  test('点出具体的重复串与涉及模块（泛泛说"不要重复"已被证明无效）', () => {
    const hint = buildRetryHint([{ phrase: '李阳勇寿险为零', fields: ['summary', 'review', 'suggestions'], count: 3 }])
    expect(hint).toContain('李阳勇寿险为零')
    expect(hint).toContain('3 个模块')
    expect(hint).toContain('summary/review/suggestions')
  })

  test('同时重申篇幅约束（plan 450 字、正文 1800-2400）', () => {
    const hint = buildRetryHint([])
    expect(hint).toContain('1800-2400')
    expect(hint).toContain('plan 不超过 450 字')
    expect(hint).toContain('只输出一个 JSON 对象')
  })
})
