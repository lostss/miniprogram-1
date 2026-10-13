/**
 * report-coverage 单元测试 — facts 一致性护栏
 *
 * 被测对象：cloudfunctions/reportAI/report-coverage.js · buildStructuredCoverage
 * 设计契约：
 *   - structuredMd：保单清单 Markdown 表（OCR 入库 · 覆盖现状以本表为准）
 *   - hintsMd：数据一致性提示（facts 决策优先于保单库），无提示时为空串
 *
 * 关键护栏：
 *   1. facts 值含"删除/作废/退保/..."关键词且命中保单名 → 生成"按已删除处理"hint
 *      （2026-09-14 起不再依赖谓词白名单 — 谓词已自由化，"退保决策"这类自然表述也要能命中）
 *   2. facts 保障边（拥有保障/公司提供保障）无法对应到 policies → 生成"待确认"hint
 *      有 object_id 按其比对；无 object_id 退回产品名比对（对话补充的边常为 literal 型，无 id）
 *   3. deleted/cancelled 状态的保单不进 structuredMd 表
 *   4. 现价表 cashValues 透传到 ctx.cashMap 供列渲染
 */
const { buildStructuredCoverage, _renderExpiryAlerts } = require('../cloudfunctions/reportAI/report-coverage')

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

    // 2026-09-22（数据质量批次 3）：主键兜底。保单业务主键是 `id`，但历史/异常文档可能只有 DB 的 `_id`
    // → 原先两处 cashMap 查询恒落空，报告表「现价 / 回本」两列同时显示 `-`（而 reportPdf 早就写 `p.id || p._id`）。
    test('保单只有 _id 时，现价/回本列不再同时为 "-"', () => {
      const p = Object.assign({}, basePolicy, { id: undefined, _id: 'db_001' })
      const cash = { policy_id: 'db_001', cash_values: [{ y: 0, v: 100 }, { y: 20, v: 5000 }] }
      const r = buildStructuredCoverage([p], [], [cash])
      const row = r.structuredMd.split('\n').find(l => l.indexOf('国寿福') !== -1)
      expect(row).toBeTruthy()
      expect(row).not.toMatch(/\|\s*-\s*\|\s*-\s*\|?\s*$/) // 修复前：现价与回本两列同时为 '-'
    })

    test('孤儿保障提示：保单只有 _id 时不得误报（原先 polIds 不含它）', () => {
      const p = Object.assign({}, basePolicy, { id: undefined, _id: 'db_001' })
      const facts = [{ predicate: '拥有保障', object_id: 'db_001', object_value: '国寿福' }]
      const r = buildStructuredCoverage([p], facts, [])
      expect(r.hintsMd).toBe('') // 库里确实有这张保单 → 不产生任何"待确认"提示
    })

    // 2026-09-22 产品决策：一年期默认续保 + 文中提醒。表里「状态=有效」与「保障到期=2021-05-19」
    // 只是两列并列，模型不会自己意识到有问题 → 必须在表下显式写出并要求它在结论里提及。
    test('载明期限已过但 status=active → 清单下方给出提醒（含"续保"与具体保单）', () => {
      const p = Object.assign({}, basePolicy, {
        product_name: '康健华尊医疗保险', insured_name: '李阳勇',
        insurance_period: '至2021年05月19日', effective_date: '2020-05-20'
      })
      const r = buildStructuredCoverage([p], [], [])
      expect(r.structuredMd).toContain('载明保障期限已过的保单')
      expect(r.structuredMd).toContain('康健华尊医疗保险')
      expect(r.structuredMd).toContain('2021-05-19')
      expect(r.structuredMd).toContain('续保')
    })

    test('未过期的 active 保单不进提醒段（不制造噪声）', () => {
      const r = buildStructuredCoverage([Object.assign({}, basePolicy, { insurance_period: '终身' })], [], [])
      expect(r.structuredMd).not.toContain('载明保障期限已过的保单')
    })

    test('_renderExpiryAlerts：非一年期与一年期分别成段（措辞不同）', () => {
      const md = _renderExpiryAlerts([
        { product_name: 'A', insured_name: '甲', expiryText: '2021-05-19', isOneYear: false },
        { product_name: 'B', insured_name: '乙', expiryText: '2026-03-19', isOneYear: true }
      ])
      expect(md).toContain('非一年期产品')
      expect(md).toContain('一年期产品')
      // 2026-09-28 口径修正（与 reportPdf 对齐）：一年期那支**不得**再断言"按保证续保默认仍有效"
      // —— isOneYearPolicy 判不出是否保证续保，对意外险等是不成立的承诺（客户会以为仍在保）。
      // 断言方向与 tests/report-pdf-notes.test.js 的同主题用例一致：正措辞在、旧断言不在。
      expect(md).toContain('是否保证续保以条款为准')
      expect(md).not.toContain('默认仍有效')
      expect(md).not.toContain('保证续保**默认')
      // 非一年期在前（更需人工核实）
      expect(md.indexOf('非一年期产品')).toBeLessThan(md.indexOf('一年期产品'))
      expect(_renderExpiryAlerts([])).toBe('')
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
      // 现价列按已缴年数取行（effective_date 2024 起 paidYears=2 → y2=200），
      // 并按保额比例换算（sum_assured=50万 → scale=50，200×50=10000）；回本应为 "-"
      expect(r.structuredMd).toContain('10000')
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

    test('拥有保障无 object_id 且名称对不上库内产品 → 生成"待确认"hint（2026-09-14 改进）', () => {
      // 对话补充的保障边常为 literal 型（无 object_id），旧实现直接续过 →
      // "库里没有的保障"反而静默无提示（最该提示的情况）。现改为退回产品名比对。
      const facts = [{
        predicate: '拥有保障',
        subject_name: '张三',
        object_id: '',
        object_value: '保额50万'
      }]
      const r = buildStructuredCoverage([basePolicy], facts, [])
      expect(r.hintsMd).toContain('待确认')
    })

    test('拥有保障无 object_id 但名称命中库内产品 → 不生成孤儿 hint', () => {
      const facts = [{
        predicate: '拥有保障',
        subject_name: '张三',
        object_id: '',
        object_value: '国寿福(001)'
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

// ============ 2026-09-22 报告链路审计 P1 回归 ============
describe('已缴年 / 累计保费：脏生效日不得产出字面量 NaN', () => {
  // 事故：effective_date 是 OCR 文本，库里真实存在 '2020年5月' 这类脏值（见 writePoliciesBatch 夹具）
  // → new Date(脏值).getFullYear() 为 NaN → Math.max(0, NaN) = NaN → 表里写出 "NaN"，
  // 而这段 markdown 直接进 AI 上下文、prompt 又要求"直接引用系统预计算值" → 模型把 NaN 抄进报告。
  // 同一函数的「保障到期」列一直有 contract_effective_date 兜底，只有这两列漏了。
  const dirty = {
    id: 'pol_dirty', product_name: '重疾A', insurance_category: '重疾险',
    sum_assured: 500000, insured_name: '张三', status: 'active',
    effective_date: '2020年5月', annual_premium: 5000
  }

  test('脏生效日 → 已缴年/累计保费渲染为 -，绝不出现 NaN', () => {
    const md = buildStructuredCoverage([dirty], [], []).structuredMd
    expect(md).not.toContain('NaN')
    const row = md.split('\n').find(l => l.indexOf('重疾A') !== -1)
    expect(row).toBeTruthy()
    // 该行最后两列（已缴年/累计保费）应为 -
    expect(row.split('|').map(s => s.trim()).filter(Boolean).slice(-3).join(' ')).toContain('-')
  })

  test('contract_effective_date 优先于 effective_date（与全项目口径一致）', () => {
    const p = Object.assign({}, dirty, { contract_effective_date: String(new Date().getFullYear() - 3) + '-01-01' })
    const md = buildStructuredCoverage([p], [], []).structuredMd
    const row = md.split('\n').find(l => l.indexOf('重疾A') !== -1)
    // 生效日列显示 contract_effective_date（与已缴年依据同一个日期）
    expect(row).toContain(String(new Date().getFullYear() - 3) + '-01-01')
    expect(md).not.toContain('NaN')
  })

  test('正常生效日仍照常计算（本条原先钉的是「年差」旧口径，2026-09-27 修正）', () => {
    // ⚠️ 本条原期望 5×5000=25000，来自旧实现「当前年 − 生效年」（不看周年）—— 而 2021-03-15 生效的保单
    // 到 2026-09-27 已缴 **6** 期保费（每年周年日缴一次）→ 25000 本身就是少算 1 年的结果。
    // 与前端 chapter-builder（原先 +1，同一保单显示 6）相差 1 年，即 dsh 审计 ①。
    // 现两处都走契约 policyYearAt（周年制）。此处固定 now 以摆脱"跑测试当天"的影响。
    const p = Object.assign({}, dirty, { effective_date: '2021-03-15', annual_premium: 5000 })
    const md = buildStructuredCoverage([p], [], [], new Date(2026, 8, 27)).structuredMd
    const row = md.split('\n').find(l => l.indexOf('重疾A') !== -1)
    const cells = row.split('|').map(s => s.trim()).filter(Boolean)
    expect(cells[7]).toBe('6')     // 已缴年（第 6 保单年度）
    expect(cells[8]).toBe('30000') // 累计保费 = 6 × 5000
  })

  test('周年日未到 → 仍是上一保单年度（old「当前年−生效年+1」在此会多算 1 年）', () => {
    const p = Object.assign({}, dirty, { effective_date: '2021-03-15', annual_premium: 5000 })
    const md = buildStructuredCoverage([p], [], [], new Date(2026, 1, 20)).structuredMd // 2026-02-20，周年未到
    const row = md.split('\n').find(l => l.indexOf('重疾A') !== -1)
    const cells = row.split('|').map(s => s.trim()).filter(Boolean)
    expect(cells[7]).toBe('5')
    expect(cells[8]).toBe('25000')
  })
})
