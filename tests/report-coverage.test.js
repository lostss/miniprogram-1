/**
 * report-coverage 单元测试 — facts 一致性护栏
 *
 * 被测对象：cloudfunctions/reportAI/report-coverage.js · buildStructuredCoverage
 * 设计契约：
 *   - structuredMd：保单清单 Markdown 表（OCR 入库 · 覆盖现状以本表为准）
 *   - hintsMd：数据一致性提示（facts 决策优先于保单库），无提示时为空串
 *
 * 关键护栏：
 *   1. facts.predicate='备注' 含"删除/作废/退保/..."关键词 → 生成"按已删除处理"hint
 *   2. facts.predicate='拥有保障'/'公司提供保障' 的 object_id 不在 policies 中 → 生成"待确认"hint
 *   3. deleted/cancelled 状态的保单不进 structuredMd 表
 *   4. 现价表 cashValues 透传到 ctx.cashMap 供列渲染
 */
const { buildStructuredCoverage } = require('../cloudfunctions/reportAI/report-coverage')

describe('buildStructuredCoverage', () => {
  const basePolicy = {
    id: 'pol_001',
    product_name: '国寿福',
    insurance_category: '重疾险',
    sum_assured: 500000,
    insured_name: '张三',
    status: 'active',
    effective_date: '2024-01-01',
    insurance_period: '终身',
    annual_premium: 12000
  }

  describe('structuredMd 表生成', () => {
    test('空 policies 返回空 structuredMd', () => {
      const r = buildStructuredCoverage([], [], [])
      expect(r.structuredMd).toBe('')
      expect(r.hintsMd).toBe('')
    })

    test('deleted/cancelled 状态的保单不入表', () => {
      const r = buildStructuredCoverage([
        { ...basePolicy, status: 'deleted' },
        { ...basePolicy, id: 'pol_002', status: 'cancelled' }
      ], [], [])
      expect(r.structuredMd).toBe('')
    })

    test('active 保单入表，含表头与数据行', () => {
      const r = buildStructuredCoverage([basePolicy], [], [])
      expect(r.structuredMd).toContain('## 结构化保单清单')
      expect(r.structuredMd).toContain('国寿福')
      expect(r.structuredMd).toContain('重疾险')
      expect(r.structuredMd).toContain('50') // 保额 500000/10000=50 万
      expect(r.structuredMd).toContain('张三')
      expect(r.structuredMd).toContain('有效')
    })
  })

  describe('cashValue 现价/回本列', () => {
    test('cashValues 含 latest_value 时现价列展示', () => {
      const cashValues = [{ policy_id: 'pol_001', latest_value: 8000 }]
      const r = buildStructuredCoverage([basePolicy], [], cashValues)
      expect(r.structuredMd).toContain('8000')
    })

    test('cashValues.cash_values 中 v >= annual_premium * y 时回本列展示"第Y年"', () => {
      // 数值审计 #5：回本按保额比例换算表值（sum_assured=50万 → scale=50）
      // annual_premium=12000，表值×50 与 累计保费比较：y3 时 800*50=40000 >= 36000 → 第3年回本
      const cashValues = [{
        policy_id: 'pol_001',
        latest_value: 40000,
        cash_values: [
          { y: 1, v: 100 }, { y: 2, v: 300 }, { y: 3, v: 800 }
        ]
      }]
      const r = buildStructuredCoverage([basePolicy], [], cashValues)
      expect(r.structuredMd).toContain('第3年')
    })

    test('cash_values 全部 < annual_premium * y 时回本列展示 "-"', () => {
      const cashValues = [{
        policy_id: 'pol_001',
        latest_value: 5000,
        cash_values: [{ y: 1, v: 100 }, { y: 2, v: 200 }]
      }]
      const r = buildStructuredCoverage([basePolicy], [], cashValues)
      // 现价列按已缴年数取行（effective_date 2024 起 paidYears=2 → y2=200），回本应为 "-"
      expect(r.structuredMd).toContain('200')
      expect(r.structuredMd).not.toContain('第1年')
    })
  })

  describe('hintsMd — 删除类决策一致性', () => {
    test('备注含"删除"关键词且保单 active → 生成"按已删除处理"hint', () => {
      const facts = [{
        predicate: '备注',
        object_value: '客户确认删除国寿福保单',
        subject_name: '张三'
      }]
      const r = buildStructuredCoverage([basePolicy], facts, [])
      expect(r.hintsMd).toContain('数据一致性提示')
      expect(r.hintsMd).toContain('国寿福')
      expect(r.hintsMd).toContain('已删除')
    })

    test('备注含"作废"关键词 → 生成 hint', () => {
      const facts = [{
        predicate: '备注',
        object_value: '作废国寿福',
        subject_name: ''
      }]
      const r = buildStructuredCoverage([basePolicy], facts, [])
      expect(r.hintsMd).toContain('已删除')
    })

    test('备注含"退保"关键词 → 生成 hint', () => {
      const facts = [{ predicate: '备注', object_value: '退保国寿福' }]
      const r = buildStructuredCoverage([basePolicy], facts, [])
      expect(r.hintsMd).toContain('已删除')
    })

    test('备注不含删除关键词 → 不生成 hint', () => {
      const facts = [{
        predicate: '备注',
        object_value: '客户咨询国寿福的现金价值'
      }]
      const r = buildStructuredCoverage([basePolicy], facts, [])
      expect(r.hintsMd).toBe('')
    })

    test('保单已 deleted 状态时不生成冲突 hint', () => {
      const facts = [{
        predicate: '备注',
        object_value: '删除国寿福'
      }]
      const r = buildStructuredCoverage([{ ...basePolicy, status: 'deleted' }], facts, [])
      // 保单已 deleted（不入表），但 hintsMd 是否生成取决于 policies 中是否能找到 matched
      // 实际逻辑：deleted 状态的保单仍在 policies 数组中（仅被 buildPolicyTable 过滤），matched 仍可能找到
      // 但 matched.status === 'deleted' 时不生成 hint
      // 此处验证：deleted 状态不生成"已删除"hint
      expect(r.hintsMd).not.toContain('按「已删除」处理')
    })

    test('非删除类谓词（如"爱好"）不触发删除 hint', () => {
      const facts = [{
        predicate: '爱好',
        object_value: '删除了某些记录' // 含"删除"但谓词不在白名单
      }]
      const r = buildStructuredCoverage([basePolicy], facts, [])
      expect(r.hintsMd).toBe('')
    })

    test('"有特征"谓词且值匹配产品名 → 触发删除 hint', () => {
      const facts = [{
        predicate: '有特征',
        object_value: '国寿福已经删除' // '有特征' 在白名单内，且值含产品名
      }]
      const r = buildStructuredCoverage([basePolicy], facts, [])
      expect(r.hintsMd).toContain('已删除')
    })
  })

  describe('hintsMd — 孤儿保障', () => {
    test('拥有保障 object_id 不在 policies → 生成"待确认"hint', () => {
      const facts = [{
        predicate: '拥有保障',
        subject_name: '张三',
        object_id: 'pol_missing',
        object_value: '保额100万'
      }]
      const r = buildStructuredCoverage([basePolicy], facts, [])
      expect(r.hintsMd).toContain('待确认')
      expect(r.hintsMd).toContain('张三')
      expect(r.hintsMd).toContain('保额100万')
    })

    test('公司提供保障 object_id 不在 policies → 生成"待确认"hint', () => {
      const facts = [{
        predicate: '公司提供保障',
        subject_name: '李四',
        object_id: 'pol_orphan',
        object_value: '团体医疗'
      }]
      const r = buildStructuredCoverage([basePolicy], facts, [])
      expect(r.hintsMd).toContain('待确认')
      expect(r.hintsMd).toContain('李四')
    })

    test('拥有保障 object_id 在 policies 中 → 不生成孤儿 hint', () => {
      const facts = [{
        predicate: '拥有保障',
        subject_name: '张三',
        object_id: 'pol_001', // 与 basePolicy.id 一致
        object_value: '保额50万'
      }]
      const r = buildStructuredCoverage([basePolicy], facts, [])
      expect(r.hintsMd).not.toContain('待确认')
    })

    test('拥有保障无 object_id → 不生成孤儿 hint', () => {
      const facts = [{
        predicate: '拥有保障',
        subject_name: '张三',
        object_id: '',
        object_value: '保额50万'
      }]
      const r = buildStructuredCoverage([basePolicy], facts, [])
      expect(r.hintsMd).not.toContain('待确认')
    })
  })

  describe('综合', () => {
    test('多 facts 多 policies → hints 聚合', () => {
      const policies = [
        basePolicy,
        { ...basePolicy, id: 'pol_002', product_name: '平安福', status: 'active' }
      ]
      const facts = [
        { predicate: '备注', object_value: '删除平安福' },
        { predicate: '拥有保障', subject_name: '李四', object_id: 'pol_999', object_value: '未知保单' }
      ]
      const r = buildStructuredCoverage(policies, facts, [])
      expect(r.hintsMd).toContain('平安福')
      expect(r.hintsMd).toContain('李四')
      // 两条 hint
      const hintCount = (r.hintsMd.match(/^- /gm) || []).length
      expect(hintCount).toBeGreaterThanOrEqual(2)
    })
  })
})
