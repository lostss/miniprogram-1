/**
 * 「保单整理报告」视图组装契约（探索版 · MVP 内测）
 *
 * 这份报告要在客户面前打开，所以本套件钉的不是"渲染对不对"，而是它**不许越界**：
 *   ① 只出结果不出建议（输出里不得出现建议词）
 *   ② 不确定不猜（缺字段/低置信/被保人未匹配必须进 pending，不得静默归到某个成员）
 *   ③ 数据红线（输出不得带 `_openid`）
 * 外加归集与汇总的算术正确性。
 */
const {
  buildCheckupReport, toPolicyCard, REPORT_REQUIRED_FIELDS
} = require('../miniprogram/utils/checkup/organize')
const { CORE_FIELDS } = require('../miniprogram/utils/ocr-confidence')

const P = (o) => Object.assign({
  id: 'p1', product_name: '安立宝少儿重大疾病保险', insurance_category: '重疾险',
  insurance_type: '传统型', insured_name: '张小某', sum_assured: 500000, annual_premium: 1830,
  payment_method: '年交', insurance_period: '2024-01-15 ~ 2054-01-14', effective_date: '2024-01-15',
  status: 'active', member_id: 'm2', field_confidence: {}
}, o)
const M = (o) => Object.assign({ _id: 'x', member_id: 'm1', name: '张某', role: '本人', age: 43 }, o)

describe('checkup/organize — 归集与汇总', () => {
  test('按 member_id 归组，且**含无保单成员**', () => {
    const r = buildCheckupReport({
      family: {
        family_name: '张家庭',
        members: [M(), M({ member_id: 'm2', name: '张小某', role: '子女', age: 8 })],
        policies: [P()]
      }
    })
    expect(r.groups.map(g => g.name)).toEqual(['张某', '张小某'])
    expect(r.groups[0].policyCount).toBe(0)
    expect(r.groups[0].source).toBe('代理人补充')
    expect(r.groups[1].policyCount).toBe(1)
    expect(r.summary.membersWithoutPolicy).toEqual(['张某'])
  })

  test('无 member_id 时按被保人姓名精确匹配（不模糊）', () => {
    const r = buildCheckupReport({
      family: { members: [M({ member_id: 'm2', name: '张小某' })], policies: [P({ member_id: '', insured_name: '张小某' })] }
    })
    expect(r.groups[0].policyCount).toBe(1)
    expect(r.groups[0].source).toBe('来自保单')
    const r2 = buildCheckupReport({
      family: { members: [M({ member_id: 'm2', name: '张小某' })], policies: [P({ member_id: '', insured_name: '张小' })] }
    })
    expect(r2.groups[0].policyCount).toBe(0)
    expect(r2.unassigned.length).toBe(1)
  })

  test('汇总：总保额 / 一年期短险单列 / 年缴保费 / 已覆盖险种枚举', () => {
    const r = buildCheckupReport({
      family: {
        members: [M()],
        policies: [
          P({ id: 'p1', insurance_category: '医疗险', sum_assured: 4000000, annual_premium: 1200, insurance_period: '1年' }),
          P({ id: 'p2', insurance_category: '重疾险', sum_assured: 500000, annual_premium: 1830, insurance_period: '2024-01-15 ~ 2054-01-14' })
        ]
      }
    })
    expect(r.summary.policyCount).toBe(2)
    expect(r.summary.totalSumAssured).toBe(4500000)
    expect(r.summary.totalSumAssuredText).toBe('450万')
    expect(r.summary.shortTermCount).toBe(1)
    expect(r.summary.shortTermSumAssured).toBe(4000000)
    expect(r.summary.annualPremium).toBe(3030)
    expect(r.summary.categories).toEqual(['重疾险', '医疗险'])
  })

  test('险种枚举只列「已覆盖」，不出现"缺/不足/建议"这类判断词', () => {
    const r = buildCheckupReport({ family: { members: [M()], policies: [P()] } })
    const text = JSON.stringify(r)
    expect(r.summary.categories).toEqual(['重疾险'])
    ;['建议', '推荐', '应该', '优先', '不足', '缺口'].forEach((w) => expect(text).not.toContain(w))
  })

  test('已软删的成员与保单不进入视图', () => {
    const r = buildCheckupReport({
      family: {
        members: [M(), M({ member_id: 'm9', name: '已删', status: 'deleted' })],
        policies: [P(), P({ id: 'p9', status: 'deleted' })]
      }
    })
    expect(r.summary.memberCount).toBe(1)
    expect(r.summary.policyCount).toBe(1)
  })
})

describe('checkup/organize — 待完善（不确定就标出来）', () => {
  test('关键字段缺失 → pending.missing_field，逐字段点名', () => {
    const r = buildCheckupReport({
      family: { members: [M({ member_id: 'm2', name: '张小某' })], policies: [P({ sum_assured: 0, annual_premium: 0, insurance_period: '' })] }
    })
    const item = r.pending.find(x => x.kind === 'missing_field')
    expect(item.policyId).toBe('p1')
    expect(item.detail).toContain('保额')
    expect(item.detail).toContain('年缴保费')
    expect(item.detail).toContain('保障期间')
  })

  test('低置信字段（< 0.95）→ pending.low_confidence，且保单卡带标记', () => {
    const r = buildCheckupReport({
      family: {
        members: [M({ member_id: 'm2', name: '张小某' })],
        policies: [P({ field_confidence: { product_name: 0.99, sum_assured: 0.8, insured_name: 0.5 } })]
      }
    })
    const item = r.pending.find(x => x.kind === 'low_confidence')
    expect(item.detail).toContain('保额')
    expect(item.detail).toContain('被保人')
    expect(item.detail).not.toContain('产品名') // 0.99 达标，不进来
    expect(r.groups[0].policies[0].lowConfidence).toBe(true)
  })

  test('非年交保单：不许把该字段写成「年缴保费」，并进 pending 标出未年化', () => {
    const r = buildCheckupReport({
      family: {
        members: [M({ member_id: 'm2', name: '张小某' })],
        policies: [P({ payment_method: '月交', annual_premium: 500 })]
      }
    })
    const card = r.groups[0].policies[0]
    expect(card.premiumLabel).toBe('每期保费（月交）')
    expect(card.premiumIsAnnual).toBe(false)
    expect(r.summary.premiumNote).toContain('1 张非年交保单')
    const item = r.pending.find(x => x.kind === 'premium_basis')
    expect(item.detail).toContain('月交')
    expect(item.detail).toContain('未年化')
  })

  test('年交/趸交/未填：按年缴口径展示，不进 pending（不制造噪音）', () => {
    const r = buildCheckupReport({
      family: {
        members: [M({ member_id: 'm2', name: '张小某' })],
        policies: [P({ id: 'p1', payment_method: '年交' }), P({ id: 'p2', payment_method: '趸交' }), P({ id: 'p3', payment_method: '' })]
      }
    })
    r.groups[0].policies.forEach((c) => {
      expect(c.premiumLabel).toBe('年缴保费')
      expect(c.premiumIsAnnual).toBe(true)
    })
    expect(r.summary.premiumNote).toBe('')
    expect(r.pending.filter(x => x.kind === 'premium_basis').length).toBe(0)
  })

  test('被保人未匹配 → 不归入任何成员，进 unassigned 与 pending', () => {
    const r = buildCheckupReport({ family: { members: [M()], policies: [P({ member_id: '', insured_name: '陌生人' })] } })
    expect(r.groups[0].policyCount).toBe(0)
    expect(r.unassigned.length).toBe(1)
    const item = r.pending.find(x => x.kind === 'unassigned')
    expect(item.detail).toContain('陌生人')
    expect(item.detail).toContain('不在成员名单')
  })
})

describe('checkup/organize — 契约与边界', () => {
  test('空输入不崩', () => {
    const r = buildCheckupReport()
    expect(r.header.familyName).toBe('—')
    expect(r.summary.policyCount).toBe(0)
    expect(r.groups).toEqual([])
    expect(r.unassigned).toEqual([])
    expect(r.pending).toEqual([])
    expect(buildCheckupReport({}).summary.totalSumAssuredText).toBe('0元')
  })

  test('数据红线：输出不含 _openid 与内部工作线索字段', () => {
    const doc = P({ _openid: 'o_owner', memo: '客户很在意保费', deal_status: 'hot' })
    const r = buildCheckupReport({ family: { _openid: 'o_owner', members: [M({ _openid: 'o_owner' })], policies: [doc] } })
    const text = JSON.stringify(r)
    expect(text).not.toContain('o_owner')
    expect(text).not.toContain('memo')
    expect(text).not.toContain('deal_status')
    expect(Object.keys(toPolicyCard(doc))).not.toContain('_openid')
  })

  test('整理关键字段清单恒为 CORE_FIELDS 超集（CORE_FIELDS 增项而此处漏跟即红）', () => {
    CORE_FIELDS.forEach((f) => expect(REPORT_REQUIRED_FIELDS).toContain(f))
  })

  test('金额展示走 amount.js 口径（元 → ≥1万转万）', () => {
    const r = buildCheckupReport({ family: { members: [M({ member_id: 'm2', name: '张小某' })], policies: [P({ sum_assured: 10000, annual_premium: 5000 })] } })
    const card = r.groups[0].policies[0]
    expect(card.sumAssuredText).toBe('1万')
    expect(card.annualPremiumText).toBe('5000元')
  })

  test('一年期短险标注（短险单列依据）', () => {
    expect(toPolicyCard(P({ insurance_period: '1年' })).shortTerm).toBe(true)
    expect(toPolicyCard(P({ insurance_period: '至2050-06-01' })).shortTerm).toBe(false)
  })
})
