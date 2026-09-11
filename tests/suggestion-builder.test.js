/**
 * suggestion-builder 纯函数测试
 * 架构审计第 13 轮候选 #4：补单测
 */
const { buildSuggestions } = require('../cloudfunctions/conversationAI/suggestion-builder')

describe('buildSuggestions', () => {
  test('空输入返回空数组', () => {
    expect(buildSuggestions(null)).toEqual({ suggestions: [], pending_confirms: [] })
    expect(buildSuggestions([])).toEqual({ suggestions: [], pending_confirms: [] })
    expect(buildSuggestions(undefined)).toEqual({ suggestions: [], pending_confirms: [] })
  })

  test('低置信度 addFact → 不生成卡片（② 默认执行+撤销，undo 兜底）', () => {
    const toolResults = [{
      toolName: 'addFact',
      toolCallId: 'tc1',
      success: true,
      args: { predicate: '拥有保障', objectValue: '重疾险50万', confidence: 0.4 },
      result: { code: 200, data: { factId: 'fact_001' } }
    }]
    const { suggestions, pending_confirms } = buildSuggestions(toolResults)
    expect(suggestions).toHaveLength(0)
    expect(pending_confirms).toHaveLength(0)
  })

  test('高置信度 addFact → 不生成卡片', () => {
    const toolResults = [{
      toolName: 'addFact',
      success: true,
      args: { predicate: '拥有保障', objectValue: '重疾险', confidence: 0.9 },
      result: { code: 200, data: { factId: 'fact_002' } }
    }]
    const r = buildSuggestions(toolResults)
    expect(r.suggestions).toHaveLength(0)
    expect(r.pending_confirms).toHaveLength(0)
  })

  test('置信度边界值 0.6 → 不生成卡片（< 0.6 才生成）', () => {
    const toolResults = [{
      toolName: 'addFact',
      success: true,
      args: { predicate: '拥有保障', objectValue: '医疗险', confidence: 0.6 },
      result: { code: 200, data: { factId: 'fact_003' } }
    }]
    const r = buildSuggestions(toolResults)
    expect(r.suggestions).toHaveLength(0)
  })

  test('addFact 无 factId → 不生成卡片', () => {
    const toolResults = [{
      toolName: 'addFact',
      success: true,
      args: { predicate: '拥有保障', objectValue: '医疗险', confidence: 0.3 },
      result: { code: 200, data: {} }
    }]
    const r = buildSuggestions(toolResults)
    expect(r.suggestions).toHaveLength(0)
  })

  test('upsertMember needsConfirm → 生成 CONFIRM/KEEP 卡片对', () => {
    const toolResults = [{
      toolName: 'upsertMember',
      success: true,
      args: { memberName: '张三', data: { name: '张三', age: 35 } },
      result: {
        needsConfirm: true,
        data: { memberId: 'mem_001', proposed: { name: '张三', age: 35 } }
      }
    }]
    const { suggestions, pending_confirms } = buildSuggestions(toolResults)
    expect(suggestions).toEqual(['确认覆盖「张三」', '保留原值'])
    expect(pending_confirms).toHaveLength(2)
    expect(pending_confirms[0].action).toBe('CONFIRM')
    expect(pending_confirms[0].type).toBe('member_confirm')
    expect(pending_confirms[0].memberName).toBe('张三')
    expect(pending_confirms[0].memberId).toBe('mem_001')
    expect(pending_confirms[0].proposed).toEqual({ name: '张三', age: 35 })
    expect(pending_confirms[1].action).toBe('KEEP')
    expect(pending_confirms[1].type).toBe('member_confirm')
  })

  test('删除类 needsConfirm+confirmType=delete → 生成 CONFIRM/KEEP 卡片对', () => {
    const toolResults = [{
      toolName: 'deletePolicy',
      success: true,
      args: {},
      result: {
        needsConfirm: true,
        confirmType: 'delete',
        toolName: 'deletePolicy',
        target: '平安福',
        payload: { policyId: 'pol_001' }
      }
    }]
    const { suggestions, pending_confirms } = buildSuggestions(toolResults)
    expect(suggestions).toEqual(['确认删除平安福', '取消'])
    expect(pending_confirms).toHaveLength(2)
    expect(pending_confirms[0]).toMatchObject({
      action: 'CONFIRM',
      type: 'delete_confirm',
      toolName: 'deletePolicy',
      payload: { policyId: 'pol_001' },
      target: '平安福'
    })
    expect(pending_confirms[1]).toMatchObject({
      action: 'KEEP',
      type: 'delete_confirm',
      toolName: 'deletePolicy'
    })
  })

  test('多工具混合场景（addFact 全部默认执行，仅删除类生成卡片）', () => {
    const toolResults = [
      // addFact（高/低置信度均不生成——② 默认执行+撤销）
      { toolName: 'addFact', success: true, args: { confidence: 0.9 }, result: { data: { factId: 'f1' } } },
      { toolName: 'addFact', success: true, args: { predicate: '备注', objectValue: '想加保', confidence: 0.3 }, result: { data: { factId: 'f2' } } },
      // 删除（生成 2 个）
      { toolName: 'deleteMember', success: true, args: {}, result: { needsConfirm: true, confirmType: 'delete', toolName: 'deleteMember', target: '李四', payload: { memberId: 'm1' } } }
    ]
    const { suggestions, pending_confirms } = buildSuggestions(toolResults)
    expect(suggestions).toHaveLength(2) // 仅 2 个 delete
    expect(pending_confirms).toHaveLength(2)
    expect(pending_confirms.filter(p => p.type === 'fact_confirm')).toHaveLength(0)
    expect(pending_confirms.filter(p => p.type === 'delete_confirm')).toHaveLength(2)
  })

  test('addFact 长文本 → 仍不生成卡片（分支已移除）', () => {
    const longValue = '这是一段非常长的事实描述文本超过二十个字符应该被截断处理只保留前二十个字符'
    const toolResults = [{
      toolName: 'addFact',
      success: true,
      args: { predicate: '备注', objectValue: longValue, confidence: 0.4 },
      result: { data: { factId: 'f_long' } }
    }]
    const { suggestions, pending_confirms } = buildSuggestions(toolResults)
    expect(suggestions).toHaveLength(0)
    expect(pending_confirms).toHaveLength(0)
  })
})
