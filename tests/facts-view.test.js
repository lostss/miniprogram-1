/**
 * facts-view 客户档案视图测试（2026-09-14）
 *
 * 契约：按「信息稳定性」分四档，而不是按时间流水。
 *   1) 保单节点属性不进档案（会被人员信息淹没）
 *   2) 稳定属性（axis 命中）按成员聚合、常驻不截断
 *   3) kind=constraint 进「需要留意」；kind=lead 进「待核实」
 *   4) 客户版：不给线索、不给时间线、只保留已确认客观信息
 */
const { buildFactsView, TIMELINE_MAX } = require('../miniprogram/utils/facts-view')

function fact(over) {
  return Object.assign({
    _id: 'f_' + Math.random().toString(36).slice(2, 8),
    subject_type: 'member',
    subject_id: 'm1',
    subject_name: '李阳勇',
    predicate: '',
    axis: '',
    kind: 'fact',
    object_value: '',
    confidence: 0.9,
    source: 'conversation',
    created_at: new Date().toISOString()
  }, over)
}

describe('facts-view 分档', () => {
  test('保单节点属性不进档案', () => {
    const facts = [
      fact({ subject_type: 'policy', subject_id: 'pol_1', predicate: '保额', object_value: '50万' }),
      fact({ predicate: '职业', axis: '职业', object_value: '工程师' })
    ]
    const v = buildFactsView(facts)
    expect(v.total).toBe(1)
    expect(v.members).toHaveLength(1)
  })

  test('关键属性按成员聚合、按展示槽顺序排列', () => {
    const facts = [
      fact({ predicate: '职业', axis: '职业', object_value: '工程师' }),
      fact({ predicate: '年薪', axis: '个人年收入', object_value: '30万' }),
      fact({ subject_id: 'm2', subject_name: '谢敏', predicate: '职业', axis: '职业', object_value: '教师' })
    ]
    const v = buildFactsView(facts)
    expect(v.members).toHaveLength(2)
    // 收入 在 职业 之前（DISPLAY_AXES 顺序）
    expect(v.members[0].text).toBe('收入 30万 · 职业 工程师')
    expect(v.members[1].name).toBe('谢敏')
  })

  test('同槽多值合并（健康异常可多条）', () => {
    const facts = [
      fact({ predicate: '健康异常', axis: '健康异常', object_value: '高血压' }),
      fact({ predicate: '健康异常', axis: '健康异常', object_value: '高血脂' })
    ]
    const v = buildFactsView(facts)
    expect(v.members[0].text).toBe('健康 高血压、高血脂')
  })

  test('constraint 进「需要留意」，lead 进「待核实」，都不进时间线', () => {
    const facts = [
      fact({ predicate: '公司团险在职有效', object_value: '离职即失效', kind: 'constraint' }),
      fact({ predicate: '公司年金计划', object_value: '可能有', kind: 'lead' })
    ]
    const v = buildFactsView(facts)
    expect(v.constraints).toHaveLength(1)
    expect(v.leads).toHaveLength(1)
    expect(v.timeline).toHaveLength(0)
    expect(v.constraints[0].text).toBe('公司团险在职有效：离职即失效')
  })

  test('非标信息（axis 为空）落时间线，按时间倒序', () => {
    const old = new Date(Date.now() - 86400000 * 3).toISOString()
    const facts = [
      fact({ predicate: '夫妻共保', object_value: '李、谢同为被保人', created_at: old }),
      fact({ predicate: '公司年金', object_value: '待确认' })
    ]
    const v = buildFactsView(facts)
    expect(v.timeline).toHaveLength(2)
    expect(v.timeline[0].text).toContain('公司年金')
    expect(v.timeline[0].timeText).toBe('今天')
  })

  test('时间线截断仅作用于时间线，关键属性不截断', () => {
    const facts = [fact({ predicate: '职业', axis: '职业', object_value: '工程师' })]
    for (let i = 0; i < TIMELINE_MAX + 5; i++) {
      facts.push(fact({ predicate: '备注' + i, object_value: 'v' + i }))
    }
    const v = buildFactsView(facts)
    expect(v.members).toHaveLength(1)
    expect(v.timeline).toHaveLength(TIMELINE_MAX)
    expect(v.truncated).toBe(true)
  })

  test('空输入 → empty，卡片不渲染', () => {
    expect(buildFactsView([]).empty).toBe(true)
    expect(buildFactsView(null).empty).toBe(true)
  })
})

describe('facts-view 客户版规则', () => {
  test('不给线索、不给时间线', () => {
    const facts = [
      fact({ predicate: '公司年金计划', object_value: '可能有', kind: 'lead' }),
      fact({ predicate: '夫妻共保', object_value: '李、谢同为被保人' }),
      fact({ predicate: '职业', axis: '职业', object_value: '工程师' })
    ]
    const v = buildFactsView(facts, { shared: true })
    expect(v.leads).toHaveLength(0)
    expect(v.timeline).toHaveLength(0)
    expect(v.members).toHaveLength(1)
  })

  test('只保留已确认的客观信息（低置信度被过滤）', () => {
    const facts = [
      fact({ predicate: '职业', axis: '职业', object_value: '工程师', confidence: 0.9 }),
      fact({ predicate: '收入', axis: '个人年收入', object_value: '30万', confidence: 0.4 })
    ]
    const v = buildFactsView(facts, { shared: true })
    expect(v.members[0].text).toBe('职业 工程师')
  })

  test('约束保留给客户（但不含线索）', () => {
    const facts = [
      fact({ predicate: '公司团险在职有效', object_value: '离职即失效', kind: 'constraint', confidence: 0.9 }),
      fact({ predicate: '低置信约束', object_value: 'x', kind: 'constraint', confidence: 0.3 })
    ]
    const v = buildFactsView(facts, { shared: true })
    expect(v.constraints).toHaveLength(1)
    expect(v.constraints[0].text).toContain('离职即失效')
  })
})
