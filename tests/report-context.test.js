/**
 * report-context 纯函数测试
 * 架构审计第 13 轮候选 #5：补单测
 *
 * 覆盖 buildSummaryMd / buildPrevReportMd / buildReportContext 三段上下文构建
 */
const {
  buildSummaryMd,
  buildPrevReportMd,
  buildReportContext,
  buildGapSnapshot
} = require('../cloudfunctions/reportAI/report-context')

describe('buildSummaryMd', () => {
  test('空输入 → 仅标题行', () => {
    const md = buildSummaryMd([], null)
    expect(md).toContain('保单汇总数据')
    expect(md).toContain('年保费合计：0元')
    expect(md).toContain('有效保单：0份')
    expect(md).toContain('已失效/过期：0份')
  })

  test('policies 为 null → 不抛错', () => {
    expect(() => buildSummaryMd(null, {})).not.toThrow()
  })

  test('active 保单累加年保费 + 总保额', () => {
    const policies = [
      { status: 'active', annual_premium: 5000, sum_assured: 500000 },
      { status: 'active', annual_premium: 3000, sum_assured: 300000 },
      { status: 'expired', annual_premium: 2000, sum_assured: 100000 }
    ]
    const md = buildSummaryMd(policies, { income: '20' })
    expect(md).toContain('年保费合计：8000元') // 5000+3000，不含 expired
    expect(md).toContain('占家庭年收入 4.0%') // 8000 / (20*10000) * 100 = 4.0
    expect(md).toContain('有效保单总保额：80万') // (500000+300000)/10000
    expect(md).toContain('有效保单：2份 | 已失效/过期：1份')
  })

  test('无 status 字段视为 active', () => {
    const policies = [{ annual_premium: 1000, sum_assured: 100000 }] // 无 status
    const md = buildSummaryMd(policies, {})
    expect(md).toContain('有效保单：1份')
    expect(md).toContain('年保费合计：1000元')
  })

  test('income 为 0 → 不计算占收入比（防 -% 泄漏）', () => {
    const md = buildSummaryMd([{ status: 'active', annual_premium: 1000 }], { income: 0 })
    expect(md).not.toContain('占家庭年收入')
    expect(md).toContain('不计算占收入比')
  })

  test('income 缺失 → 不计算占收入比（防 -% 泄漏）', () => {
    const md = buildSummaryMd([{ status: 'active', annual_premium: 1000 }], {})
    expect(md).not.toContain('占家庭年收入')
    expect(md).toContain('不计算占收入比')
  })

  test('snap 含 debt / fixed_expense → 显示', () => {
    const md = buildSummaryMd([], { debt: '房贷100万', fixed_expense: '8000元/月' })
    expect(md).toContain('家庭负债：房贷100万')
    expect(md).toContain('固定支出：8000元/月')
  })

  test('snap 不含 debt / fixed_expense → 不显示该行', () => {
    const md = buildSummaryMd([], {})
    expect(md).not.toContain('家庭负债')
    expect(md).not.toContain('固定月支出')
  })

  test('income 字符串数字也能解析', () => {
    const md = buildSummaryMd([{ status: 'active', annual_premium: 5000 }], { income: '10' })
    expect(md).toContain('占家庭年收入 5.0%') // 5000 / (10*10000) * 100
  })
})

describe('buildPrevReportMd', () => {
  test('空输入 → 空字符串', () => {
    expect(buildPrevReportMd(null)).toBe('')
    expect(buildPrevReportMd({})).toBe('')
  })

  test('只有 last_conclusion', () => {
    const md = buildPrevReportMd({ last_conclusion: '当前保障充足' })
    expect(md).toContain('上一版结论')
    expect(md).toContain('当前保障充足')
    expect(md).not.toContain('上一版摘要')
  })

  test('只有 last_summary', () => {
    const md = buildPrevReportMd({ last_summary: '建议加保重疾' })
    expect(md).toContain('上一版摘要')
    expect(md).toContain('建议加保重疾')
    expect(md).not.toContain('上一版结论')
  })

  test('两者都有 → 两段都显示', () => {
    const md = buildPrevReportMd({ last_conclusion: '结论A', last_summary: '摘要B' })
    expect(md).toContain('上一版结论**：结论A')
    expect(md).toContain('上一版摘要**：摘要B')
  })

  test('包含禁止照抄提示', () => {
    const md = buildPrevReportMd({ last_conclusion: 'X' })
    expect(md).toContain('禁止照抄')
    expect(md).toContain('以当前数据为准')
  })
})

describe('buildReportContext', () => {
  test('上下文以「数据口径说明」开头（2026-09-10 口径前移，降低误用概率）', () => {
    const r = buildReportContext({ v2ctx: { markdown: 'V2' }, policies: [], familyMeta: {} })
    expect(r.indexOf('## 数据口径说明')).toBe(0)
    expect(r).toContain('以「结构化保单清单」为准')
    expect(r).toContain('按成员个人年收入计算')
  })

  test('空输入 → 仅返回 summaryMd（buildSummaryMd 总是非空）', () => {
    const r = buildReportContext({})
    expect(r).toContain('保单汇总数据')
    expect(r).toContain('年保费合计：0元')
    // 不含 v2ctx/structured/hints/prev
    expect(r).not.toContain('上一版')
  })

  test('仅 v2ctx.markdown → v2ctx + summaryMd 拼接', () => {
    const r = buildReportContext({
      v2ctx: { markdown: '## 客户画像\n张三' },
      policies: [],
      familyMeta: {}
    })
    expect(r).toContain('## 客户画像\n张三')
    expect(r).toContain('保单汇总数据') // summaryMd 总会被拼接
    // 顺序：v2ctx 在 summary 之前
    expect(r.indexOf('## 客户画像')).toBeLessThan(r.indexOf('保单汇总数据'))
  })

  test('多段拼接顺序：v2ctx → summary → structured → hints → prev', () => {
    const r = buildReportContext({
      v2ctx: { markdown: 'V2_MARKDOWN', datasets: { facts: [], cashValues: [] } },
      policies: [{ status: 'active', annual_premium: 1000 }],
      familyMeta: { financial_snapshot: {}, last_conclusion: 'PREV_CONCLUSION' }
    })
    expect(r).toContain('V2_MARKDOWN')
    expect(r).toContain('保单汇总数据')
    expect(r).toContain('上一版结论')
    // 验证顺序：v2ctx 在 summary 之前
    expect(r.indexOf('V2_MARKDOWN')).toBeLessThan(r.indexOf('保单汇总数据'))
    expect(r.indexOf('保单汇总数据')).toBeLessThan(r.indexOf('上一版结论'))
  })

  test('v2ctx.datasets 缺失 → facts/cashValues 退化为空数组', () => {
    expect(() => buildReportContext({
      v2ctx: { markdown: 'X' }, // 无 datasets
      policies: [],
      familyMeta: {}
    })).not.toThrow()
  })

  test('familyMeta.financial_snapshot 缺失 → snap 退化为 {}', () => {
    const r = buildReportContext({
      v2ctx: { markdown: 'X', datasets: {} },
      policies: [],
      familyMeta: {} // 无 financial_snapshot
    })
    expect(r).toContain('年保费合计：0元')
  })

  test('facts 含删除标记 → 触发 buildCoverageHints 生成一致性提示', () => {
    // buildStructuredCoverage 内部调用 buildCoverageHints：facts.predicate='备注' + 含"删除"关键词
    // + policies 中有匹配产品名且 status !== 'deleted' → 生成提示
    const r = buildReportContext({
      v2ctx: { markdown: 'V2', datasets: { facts: [
        { subject_name: '张三', predicate: '备注', object_value: '已删除平安福', object_id: '' }
      ], cashValues: [] } },
      policies: [{ id: 'p1', product_name: '平安福', status: 'active', insured_name: '张三' }],
      familyMeta: {}
    })
    expect(r).toContain('数据一致性提示')
  })
})

// 2026-09-10：此前零覆盖 —— 口径在前后端之间漂移过多次（P1-P2 2026-09-05、P1-2 2026-09-10），
// 皆因矩阵的收入基数没有测试锁定。以下用例把「与前端 gap-engine 对齐」写成可执行契约。
describe('buildGapSnapshot（缺口矩阵口径）', () => {
  const _row = (md, name, cat) => md.split('\n').find(l => l.indexOf('| ' + name + ' | ' + cat + ' |') === 0)

  test('寿险按成员个人收入算，不用家庭收入高估（双收入家庭）', () => {
    // 家庭收入 50 万，配偶个人收入 20 万 → 寿险需求 = 负债100 + 5×20 = 200 万
    // （旧实现用家庭收入：100 + 5×50 = 350 万，与前端矩阵对不上）
    const md = buildGapSnapshot(
      [{ status: 'active', member_id: 'm2', insured_name: '李四', insurance_category: '寿险', sum_assured: 2000000 }],
      { income: 50, debt: 100 },
      [
        { member_id: 'm1', name: '张三', role: '本人', income: 30 },
        { member_id: 'm2', name: '李四', role: '配偶', income: 20 }
      ]
    )
    const row = _row(md, '李四', '寿险')
    expect(row).toContain('5×收入20万')
    expect(row).toContain('=200万')
    expect(row).toContain('✅ 已覆盖')
    expect(row).not.toContain('5×收入50万')
  })

  test('支柱个人收入缺失 → 用家庭年收入全额兜底并标注估算', () => {
    const md = buildGapSnapshot([], { income: 50, debt: 0 }, [{ member_id: 'm1', name: '张三', role: '本人' }])
    const row = _row(md, '张三', '寿险')
    expect(row).toContain('5×收入50万')
    expect(row).toContain('按家庭年收入估算')
  })

  test('非支柱收入缺失 → ⚠️ 无法计算，不用 0 收入编造需求', () => {
    const md = buildGapSnapshot([], { income: 50, debt: 0 }, [
      { member_id: 'm1', name: '张三', role: '本人', income: 50 },
      { member_id: 'm2', name: '李四', role: '配偶' }
    ])
    const row = _row(md, '李四', '寿险')
    expect(row).toContain('⚠️ 无法计算')
    expect(row).toContain('年收入缺失无法计算')
    expect(row).not.toContain('❌ 有缺口')
    expect(row).not.toContain('✅ 已覆盖')
    // 重疾/医疗不受收入缺失影响，仍正常判定
    expect(_row(md, '李四', '重疾险')).toContain('❌ 有缺口')
  })

  test('P2-1：保单缺 member_id 但姓名匹配 → 不再出现"已覆盖"与"无任何保障"矛盾行', () => {
    const md = buildGapSnapshot(
      [{ status: 'active', insured_name: '张三', insurance_category: '重疾险', sum_assured: 600000 }],
      { income: 50, debt: 0 },
      [{ member_id: 'm1', name: '张三', role: '本人', income: 50 }]
    )
    expect(_row(md, '张三', '重疾险')).toContain('✅ 已覆盖')
    expect(md).not.toContain('无任何保障')
  })

  test('无保单成员也逐险种给缺口金额（对齐前端粒度，不再只给笼统一行）', () => {
    const md = buildGapSnapshot([], { income: 50, debt: 0 }, [
      { member_id: 'm1', name: '张三', role: '本人', income: 50 },
      { member_id: 'm2', name: '李四', role: '配偶', income: 20 }
    ])
    expect(_row(md, '李四', '重疾险')).toContain('❌ 有缺口')
    expect(_row(md, '李四', '重疾险')).toContain('现有0万<50万')
    expect(_row(md, '李四', '寿险')).toContain('=100万') // 负债0 + 5×个人收入20
    expect(md).not.toContain('无任何保障')
  })

  test('保单 insured_name 不在成员名单 → 仍单独成行（不丢数据）', () => {
    const md = buildGapSnapshot(
      [{ status: 'active', insured_name: '王五', insurance_category: '重疾险', sum_assured: 800000 }],
      { income: 30, debt: 0 },
      [{ member_id: 'm1', name: '张三', role: '本人', income: 30 }]
    )
    expect(_row(md, '王五', '重疾险')).toContain('✅ 已覆盖')
    expect(_row(md, '张三', '重疾险')).toContain('❌ 有缺口')
  })

  test('医疗险 100 万及格线（与前端一致）', () => {
    const md = buildGapSnapshot(
      [{ status: 'active', member_id: 'm1', insurance_category: '医疗险', sum_assured: 500000 }],
      { income: 30, debt: 0 },
      [{ member_id: 'm1', name: '张三', role: '本人', income: 30 }]
    )
    expect(_row(md, '张三', '医疗险')).toContain('❌ 有缺口')
    expect(_row(md, '张三', '医疗险')).toContain('现有50万<100万')
  })

  test('全空家庭 → 单行显式声明（保证 AI 有依据可引用）', () => {
    const md = buildGapSnapshot([], {}, [])
    expect(md).toContain('| 全体 | - | ❌ 无任何保障 |')
    expect(md).toContain('该家庭暂无任何保单')
  })

  test('snap.debt 支持对象形态 { amount, type }', () => {
    const md = buildGapSnapshot([], { income: 30, debt: { amount: 100, type: '房贷' } }, [
      { member_id: 'm1', name: '张三', role: '本人', income: 30 }
    ])
    expect(_row(md, '张三', '寿险')).toContain('负债100万')
  })
})
