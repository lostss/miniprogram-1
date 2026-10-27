/**
 * 三项收口（2026-10-27）
 *   ① 「数据质量」合并章：A7 置信度 + 待完善，同一章两个 block
 *   ② 7d 变化年份表（data_table）：柱图给形状，表给原因
 *   ③ 字段级来源（sourceText）：有存疑的点名，其余统一说自动识别
 */
const { buildReportView } = require('../miniprogram/utils/report-builder')

const thisYear = new Date().getFullYear()

function fam() {
  return {
    name: '张家',
    members: [
      { member_id: 'm1', name: '张先生', role: '本人', age: 40 },
      { member_id: 'm2', name: '妻子', role: '配偶', age: 38 }
    ],
    policies: [
      {
        id: 'p1', member_id: 'm1', insured_name: '张先生', insurance_category: '寿险',
        sum_assured: 500000, annual_premium: 8000, effective_date: (thisYear - 5) + '-01-01',
        insurance_period: '30年', payment_period: '10年', status: 'active',
        field_confidence: { sum_assured: 0.6 }
      },
      {
        id: 'p2', member_id: 'm1', insured_name: '妻子', insurance_category: '重疾险',
        sum_assured: 300000, annual_premium: 5000, effective_date: (thisYear - 5) + '-01-01',
        insurance_period: '30年', payment_period: '20年', status: 'active'
      }
    ]
  }
}

describe('① 数据质量合并章', () => {
  test('置信度条目与待完善条目在同一章（两个 block），不再是两章', () => {
    const view = buildReportView(fam(), {})
    const keys = view.chapters.map((c) => c.key)
    expect(keys).toContain('data_quality')
    expect(keys).not.toContain('risk_alerts')
    expect(keys).not.toContain('pending_data')
    const dq = view.chapters.find((c) => c.key === 'data_quality')
    expect(dq.title).toBe('数据质量')
    const types = dq.customBlocks.map((b) => b.t)
    expect(types).toContain('risk_alerts') // 读到了但不确定
    // 待完善小节只在有缺字段时出现（本夹具保费/保额齐全，可能没有）
    expect(types.every((t) => ['risk_alerts', 'pending_list'].indexOf(t) !== -1)).toBe(true)
  })

  test('章节说明写清两个小节的差别（否则读者以为是系统错误清单）', () => {
    const dq = buildReportView(fam(), {}).chapters.find((c) => c.key === 'data_quality')
    expect(dq.pre).toContain('存疑')
    expect(dq.pre).toContain('缺失')
  })
})

describe('② 7d 变化年份表', () => {
  test('缴费章含 data_table：列 = 年份/年缴保费/较上年/变化原因', () => {
    const view = buildReportView(fam(), {})
    const cal = view.chapters.find((c) => c.key === 'premium_calendar')
    const tb = cal.customBlocks.find((b) => b.t === 'data_table')
    expect(tb).toBeTruthy()
    expect(tb.heads).toEqual(['年份', '年缴保费', '较上年', '变化原因'])
    // 两张长期险各有一次缴费期满 → 至少一行
    expect(tb.rows.length).toBeGreaterThan(0)
    expect(tb.rows[0][0]).toMatch(/年$/)
    expect(tb.rows[0][2].indexOf('−')).toBe(0) // 减号开头（保费下降）
    expect(tb.rows[0][3]).toContain('缴费期满')
  })
})

describe('③ 字段级来源', () => {
  function cards() {
    const view = buildReportView(fam(), {})
    const ap = view.chapters.find((c) => c.key === 'appendix_policies')
    return ap.customBlocks.find((b) => b.t === 'policy_cards').groups
      .reduce((acc, g) => acc.concat(g.subgroups.reduce((a, sg) => a.concat(sg.policies), [])), [])
  }

  test('低置信字段点名"待核验"（保额 0.6）', () => {
    const p = cards().find((x) => x.policy_id === 'p1')
    expect(p.sourceText).toContain('保额待核验')
  })

  test('无存疑字段 → 统一说自动识别（不给一张"全部待核验"的假警报）', () => {
    const p = cards().find((x) => x.policy_id === 'p2')
    expect(p.sourceText).toContain('自动识别')
    expect(p.sourceText).not.toContain('待核验')
  })
})
