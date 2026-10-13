/**
 * familyPortrait compact 渲染测试
 * 覆盖：保费/生效日注入、截断分档（≤4 完整摘要 / >4 全保单名）
 */

const { buildPortrait, renderPortraitMarkdown } = require('../cloudfunctions/_shared/familyPortrait')

// 构造最小画像（直接走 buildPortrait 的输入形状：members + facts）
function makePortrait(facts) {
  const members = [
    { member_id: 'm1', name: '李阳勇', role: '本人', birth_date: '1990-06-15', status: 'active' }
  ]
  return buildPortrait(members, facts)
}

// facts 三元组（policy 节点属性 + 成员边；buildPortrait 读取 snake_case + status:active）
function policyFacts(id, attrs) {
  const ref = `${attrs['产品名']}(${id.slice(-6)})`
  const out = [
    { subject_type: 'member', subject_id: 'm1', subject_name: '李阳勇', predicate: '拥有保障', object_type: 'policy', object_id: id, object_value: ref, source: 'ocr', confidence: 0.9, status: 'active' },
    { subject_type: 'policy', subject_id: id, subject_name: ref, predicate: '险种', object_type: 'literal', object_value: attrs['险种'], source: 'ocr', confidence: 0.9, status: 'active' }
  ]
  if (attrs['保额']) out.push({ subject_type: 'policy', subject_id: id, subject_name: ref, predicate: '保额', object_type: 'literal', object_value: attrs['保额'], source: 'ocr', confidence: 0.9, status: 'active' })
  if (attrs['年缴保费']) out.push({ subject_type: 'policy', subject_id: id, subject_name: ref, predicate: '年缴保费', object_type: 'literal', object_value: attrs['年缴保费'], source: 'ocr', confidence: 0.9, status: 'active' })
  if (attrs['生效日']) out.push({ subject_type: 'policy', subject_id: id, subject_name: ref, predicate: '生效日', object_type: 'literal', object_value: attrs['生效日'], source: 'ocr', confidence: 0.9, status: 'active' })
  return out
}

describe('renderPortraitMarkdown compact 渲染', () => {

  test('≤4 份保单：完整摘要含保费/生效日', () => {
    const facts = policyFacts('pol_1', { '产品名': '平安福', '险种': '重疾', '保额': '50万', '年缴保费': '8000元', '生效日': '2024-01-15' })
    const portrait = makePortrait(facts)
    const md = renderPortraitMarkdown(portrait, { compact: true })
    expect(md).toContain('平安福')
    expect(md).toContain('重疾')
    expect(md).toContain('50万')
    expect(md).toContain('保费8000元')
    expect(md).toContain('生效2024-01-15')
  })

  test('>4 份保单：列出全部保单名，不截断', () => {
    let facts = []
    for (let i = 1; i <= 6; i++) {
      facts = facts.concat(policyFacts(`pol_${i}`, { '产品名': `保单${i}号`, '险种': '重疾' }))
    }
    const portrait = makePortrait(facts)
    const md = renderPortraitMarkdown(portrait, { compact: true })
    expect(md).toContain('已有保障（6份）')
    for (let i = 1; i <= 6; i++) expect(md).toContain(`保单${i}号`)
  })

  test('无保费/生效日：不输出空占位', () => {
    const facts = policyFacts('pol_1', { '产品名': '守护者', '险种': '意外' })
    const portrait = makePortrait(facts)
    const md = renderPortraitMarkdown(portrait, { compact: true })
    expect(md).toContain('守护者(pol_1)(意外,待确认,有效)')
    expect(md).not.toContain('保费,')
    expect(md).not.toContain('生效,')
  })

})

// ============ 2026-09-14 事实体系重构：非标信息参与深度分析 ============
function memberFact(over) {
  return Object.assign({
    subject_type: 'member', subject_id: 'm1', subject_name: '李阳勇',
    predicate: '', object_type: 'literal', object_value: '',
    confidence: 0.9, source: 'conversation', status: 'active',
    created_at: new Date().toISOString()
  }, over)
}

describe('非标事实按 kind 分组（替代旧谓词白名单）', () => {
  const member = { member_id: 'm1', name: '李阳勇', role: '本人', birth_date: '1990-06-15', status: 'active' }

  test('约束/关系/线索/其他事实全部保留（旧白名单会静默丢弃）', () => {
    const facts = [
      memberFact({ predicate: '公司团险在职有效', object_value: '离职即失效', kind: 'constraint' }),
      memberFact({ predicate: '华贵大麦定海为夫妻共保', object_value: '李阳勇、谢敏同为被保人', kind: 'relation' }),
      memberFact({ predicate: '公司年金计划', object_value: '可能有，待确认', kind: 'lead' }),
      memberFact({ predicate: '房贷余额', object_value: '200万', axis: '房贷余额' })
    ]
    const g = buildPortrait([member], facts).members[0].factsByKind
    expect(g.constraint).toHaveLength(1)
    expect(g.relation).toHaveLength(1)
    expect(g.lead).toHaveLength(1)
    expect(g.fact).toHaveLength(1)
  })

  test('非标事实进入渲染（compact 与非 compact 都要带上）', () => {
    const facts = [memberFact({ predicate: '公司团险在职有效', object_value: '离职即失效', kind: 'constraint' })]
    const p = buildPortrait([member], facts)
    expect(renderPortraitMarkdown(p, { compact: true })).toContain('离职即失效')
    expect(renderPortraitMarkdown(p, { compact: false })).toContain('分析约束')
  })

  test('kind 缺省按谓词推断：配偶 → relation', () => {
    const facts = [memberFact({ predicate: '配偶', object_value: '谢敏', object_type: 'member' })]
    const g = buildPortrait([member], facts).members[0].factsByKind
    expect(g.relation).toHaveLength(1)
  })

  test('已进结构化字段的属性槽不重复进分组', () => {
    const facts = [memberFact({ predicate: '个人年收入', object_value: '30万', axis: '个人年收入' })]
    const mp = buildPortrait([member], facts).members[0]
    expect(mp.income).toBe('30万')
    expect(mp.factsByKind.fact).toHaveLength(0)
  })

  test('自由谓词 + 同义归一：写"年薪"也能落到收入字段', () => {
    const facts = [memberFact({ predicate: '年薪', object_value: '35万' })]
    const mp = buildPortrait([member], facts).members[0]
    expect(mp.income).toBe('35万')
    expect(mp.factsByKind.fact).toHaveLength(0)
  })
})

describe('孤儿保障多维度点亮（综合型产品不再只取首个命中）', () => {
  test('"重疾+医疗综合团险" 同时点亮两个维度', () => {
    const member = { member_id: 'm1', name: '李阳勇', role: '本人', birth_date: '1990-06-15', status: 'active' }
    const facts = [memberFact({ predicate: '公司提供保障', object_value: '重疾+医疗综合团险', object_type: 'literal', object_id: '' })]
    const cov = buildPortrait([member], facts).members[0].coverage
    expect(cov['重疾险'].status).toBe('unknown')
    expect(cov['医疗险'].status).toBe('unknown')
  })
})

// ============ 2026-09-15 覆盖权威收敛（架构审查候选 1） ============
function authPolicy(over) {
  return Object.assign({
    id: 'pol_1', member_id: 'm1', product_name: '平安福', insurance_category: '重疾险',
    sum_assured: 500000, annual_premium: 8000, effective_date: '2024-01-15',
    insurance_period: '终身', payment_period: '20年', status: 'active', source: 'ocr', confidence: 0.9
  }, over)
}

describe('buildPortrait 权威保单源（与缺口矩阵同源）', () => {
  const member = { member_id: 'm1', name: '李阳勇', role: '本人', birth_date: '1990-06-15', status: 'active' }

  test('facts 缺 policy 记录时权威源仍判定已覆盖（原实现误报"无保障"）', () => {
    // 回归点：facts 里没有任何 policy 节点（policyToFacts 未跑/失败）→
    // 旧实现据此判定"该成员无任何保障"，这正是 prompts「禁止仅凭画像判定无保障」的根因
    const facts = [memberFact({ predicate: '职业', axis: '职业', object_value: '工程师' })]
    const mp = buildPortrait([member], facts, { policies: [authPolicy()] }).members[0]
    expect(mp.coverage['重疾险'].status).toBe('covered')
    expect(mp.policies).toHaveLength(1)
    expect(mp.policies[0].name).toBe('平安福')
    expect(mp.policies[0].orphan).toBe(false)
  })

  test('保额按元→万换算（不出现 500000万）', () => {
    const md = renderPortraitMarkdown(buildPortrait([member], [], { policies: [authPolicy()] }), { compact: true })
    expect(md).toContain('50万')
    expect(md).not.toContain('500000')
  })

  test('未传 policies 时回退 facts 派生（旧路径行为不变）', () => {
    const facts = [memberFact({ predicate: '职业', axis: '职业', object_value: '工程师' })]
    const mp = buildPortrait([member], facts).members[0]
    expect(mp.coverage['重疾险'].status).toBe('missing')
    expect(mp.policies).toHaveLength(0)
  })

  test('对话补充的孤儿保障不被权威源覆盖掉（团险）', () => {
    const facts = [memberFact({ predicate: '公司提供保障', object_value: '重疾+医疗综合团险', object_type: 'literal', object_id: '' })]
    const mp = buildPortrait([member], facts, { policies: [] }).members[0]
    expect(mp.coverage['重疾险'].status).toBe('unknown')
    expect(mp.coverage['医疗险'].status).toBe('unknown')
    expect(mp.policies.some(p => p.orphan)).toBe(true)
  })

  test('手动终止状态计入 missing（而非 unknown）', () => {
    for (const st of ['surrendered', 'lapsed', 'claim_terminated', 'cancelled', 'expired']) {
      const mp = buildPortrait([member], [], { policies: [authPolicy({ status: st })] }).members[0]
      expect(mp.coverage['重疾险'].status).toBe('missing')
    }
  })

  test('状态文案覆盖全部 9 态：退保显示"退保"而非"待确认"', () => {
    const md = renderPortraitMarkdown(buildPortrait([member], [], { policies: [authPolicy({ status: 'surrendered' })] }), { compact: false })
    expect(md).toContain('退保')
  })
})

// ============ 2026-09-22 报告链路审计 P1 回归 ============
describe('孤儿保障关键词表必须只产出规范词（防字典漂移炸掉整份报告）', () => {
  const member = { member_id: 'm1', name: '李阳勇', role: '本人', birth_date: '1990-06-15', status: 'active' }

  // 事故：STANDARD_COVERAGE 把 '年金险' 规范为 '年金' 后，_CATEGORY_KW 的右值仍写 '年金险'
  // → coverage['年金险'] 为 undefined → `coverage[dim].status` 抛 TypeError
  // → buildPortrait 抛出 → v2-context 在 report 场景调用它 → **整份报告生成 500**。
  test('"公司年金" 孤儿保障不抛错，且点亮"年金"维度', () => {
    const facts = [memberFact({ predicate: '公司提供保障', object_value: '公司年金', object_type: 'literal', object_id: '' })]
    let mp
    expect(() => { mp = buildPortrait([member], facts).members[0] }).not.toThrow()
    expect(mp.coverage['年金'].status).toBe('unknown')
  })

  test('每个关键词产出的维度都必须是 coverage 矩阵里真实存在的键', () => {
    // 覆盖 _CATEGORY_KW 的每一个关键词，任何一个映射到不存在维度都会抛错
    const cases = ['百万医疗', '重疾保障', '定期寿险', '综合意外', '企业年金', '教育金储备', '防癌险', '长期护理险']
    for (const name of cases) {
      const facts = [memberFact({ predicate: '拥有保障', object_value: name, object_type: 'literal', object_id: '' })]
      expect(() => buildPortrait([member], facts)).not.toThrow()
    }
  })
})

describe('同一成员同险种多张保单：保额累加（与缺口矩阵同口径）', () => {
  const member = { member_id: 'm1', name: '李阳勇', role: '本人', birth_date: '1990-06-15', status: 'active' }

  test('两张医疗险 400 万 + 800 万 → 矩阵 1200 万（原实现只留最后一张 = 800）', () => {
    const policies = [
      authPolicy({ id: 'pol_a', insurance_category: '医疗险', sum_assured: 4000000 }),
      authPolicy({ id: 'pol_b', insurance_category: '医疗险', sum_assured: 8000000 })
    ]
    const mp = buildPortrait([member], [], { policies }).members[0]
    expect(mp.coverage['医疗险'].amount).toBe(1200)
    expect(mp.coverage['医疗险'].status).toBe('covered')
  })

  test('已终止保单不计入保额（与"active 才计入已有保额"一致），但不会丢掉有效那张', () => {
    const policies = [
      authPolicy({ id: 'pol_a', insurance_category: '医疗险', sum_assured: 4000000, status: 'surrendered' }),
      authPolicy({ id: 'pol_b', insurance_category: '医疗险', sum_assured: 8000000, status: 'active' })
    ]
    const mp = buildPortrait([member], [], { policies }).members[0]
    expect(mp.coverage['医疗险'].amount).toBe(800)
    expect(mp.coverage['医疗险'].status).toBe('covered')
  })
})
