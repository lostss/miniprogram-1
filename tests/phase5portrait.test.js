const { buildPortrait } = require('../cloudfunctions/_shared/familyPortrait')

const member = () => ({ member_id: 'm1', name: '甲', birth_date: '1990-01-01', role: '本人', occupation: '', health: '' })
const OLD = new Date(Date.now() - 800 * 24 * 3600 * 1000).toISOString()
const NOW = new Date().toISOString()
function fact(over) {
  return Object.assign({
    subject_type: 'member', subject_id: 'm1', subject_name: '甲',
    predicate: '职业', object_type: 'literal', object_value: '', object_value_type: 'string',
    confidence: 0.9, source: 'conversation', status: 'active', created_at: NOW, updated_at: NOW
  }, over)
}

describe('B3 时间衰减 + 5.2b 防降级', () => {
  test('旧 conversation 事实衰减，新事实优先', () => {
    const facts = [
      fact({ object_value: '旧职业', created_at: OLD, updated_at: OLD }),
      fact({ object_value: '新职业' })
    ]
    const p = buildPortrait([member()], facts)
    expect(p.members[0].occupation).toBe('新职业')
  })

  test('agent_confirmed 不衰减，优先于新 conversation 事实', () => {
    const facts = [
      fact({ object_value: '确认职业', source: 'agent_confirmed', confidence: 1, created_at: OLD, updated_at: OLD }),
      fact({ object_value: '新职业' })
    ]
    const p = buildPortrait([member()], facts)
    expect(p.members[0].occupation).toBe('确认职业')
  })

  test('agent_confirmed 旧事实不被普通事实 versioned 覆盖（画像优先）', () => {
    const facts = [
      fact({ object_value: '确认职业', source: 'agent_confirmed', confidence: 1, created_at: OLD, updated_at: OLD }),
      fact({ object_value: '覆盖职业', confidence: 1 })
    ]
    const p = buildPortrait([member()], facts)
    expect(p.members[0].occupation).toBe('确认职业')
  })
})
