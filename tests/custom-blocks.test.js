/**
 * custom-blocks 注册表 + ocr-flow 状态机 单元测试
 */
const cb = require('../miniprogram/utils/custom-blocks')
const flow = require('../miniprogram/utils/ocr-flow')

describe('classifyBatchResults — 识别结果分流分组（收编 _procRefresh）', function () {
  test('高置信保单进 success、低置信进 review（assessPolicy 判定）', function () {
    const cls = flow.classifyBatchResults(
      [
        { product_name: '康宁', insurance_category: '重疾', auto_confirmed: true },
        { product_name: 'e生保', insurance_category: '医疗', auto_confirmed: false }
      ], [], [], {})
    expect(cls.success.length).toBe(1)
    expect(cls.success[0].product_name).toBe('康宁')
    expect(cls.success[0].low).toBe(false)
    expect(cls.review.length).toBe(1)
    expect(cls.review[0].product_name).toBe('e生保')
    expect(cls.review[0].low).toBe(true)
  })

  test('现价表恒进 success', function () {
    const cls = flow.classifyBatchResults([], [{ product_name: '康宁现价表' }], [], {})
    expect(cls.success.length).toBe(1)
    expect(cls.success[0].kind).toBe('cash')
    expect(cls.success[0].insurance_category).toBe('现金价值表')
  })

  test('错误项 → error 卡片（错误码文案 + 缩略图回退）', function () {
    const cls = flow.classifyBatchResults([], [], [{ fileId: 'f1', error_code: 'ocr_empty' }], { f1: 'thumb.jpg' })
    expect(cls.error.length).toBe(1)
    expect(cls.error[0].fileId).toBe('f1')
    expect(cls.error[0].thumb).toBe('thumb.jpg')
    expect(cls.error[0].retrying).toBe(false)
    expect(typeof cls.error[0].error).toBe('string')
  })

  test('空输入 → 空三组', function () {
    const cls = flow.classifyBatchResults([], [], [], {})
    expect(cls.success).toEqual([])
    expect(cls.review).toEqual([])
    expect(cls.error).toEqual([])
  })
})

describe('custom-blocks 注册表', function () {
  test('SUPPORTED_TYPES 声明 7 种类型（overview/urgent_list/insight_cards/dashboard 已下线）', function () {
    expect(cb.SUPPORTED_TYPES.sort()).toEqual(['calendar', 'family_tree', 'finance', 'panorama', 'policy_cards', 'risk_alerts', 'timeline'])
  })

  test('finance 默认字段补齐', function () {
    const b = cb.create('finance', {})
    expect(b.t).toBe('finance')
    expect(b.income).toBe(0)
    expect(b.debt).toBe(0)
    expect(b.expense).toBe(0)
  })

  test('family_tree 默认 nodes 补齐', function () {
    const b = cb.create('family_tree', {})
    expect(b.t).toBe('family_tree')
    expect(b.nodes).toEqual([])
  })

  test('risk_alerts 默认 items 空数组（disclaimer 字段已移除）', function () {
    const b = cb.create('risk_alerts', {})
    expect(b.items).toEqual([])
    expect(b.disclaimer).toBeUndefined()
  })

  test('policy_cards 默认 groups 空数组', function () {
    const b = cb.create('policy_cards', {})
    expect(b.groups).toEqual([])
  })

  test('create 补齐默认字段并保留 t', function () {
    const b = cb.create('panorama', { heads: ['成员'] })
    expect(b.t).toBe('panorama')
    expect(b.heads).toEqual(['成员'])
    expect(b.cats).toEqual([])
    expect(b.rows).toEqual([])
  })

  test('create 支持可选 section', function () {
    const b = cb.create('timeline', { items: [] }, '保障关键时点')
    expect(b.t).toBe('timeline')
    expect(b.section).toBe('保障关键时点')
  })

  test('create 未知类型不抛错，原样返回', function () {
    const b = cb.create('unknown_type', { foo: 1 })
    expect(b.t).toBe('unknown_type')
    expect(b.foo).toBe(1)
  })

  test('normalize 补齐缺失字段', function () {
    const b = cb.normalize({ t: 'panorama', heads: ['成员'] })
    expect(b.heads).toEqual(['成员'])
    expect(b.cats).toEqual([])
    expect(b.rows).toEqual([])
  })

  test('validate 检测必填字段缺失', function () {
    expect(cb.validate({ t: 'finance', income: 1 }).valid).toBe(false)
    expect(cb.validate({ t: 'finance', income: 1, debt: 0, expense: 0 }).valid).toBe(true)
  })

  test('validate 未知类型返回 invalid', function () {
    const r = cb.validate({ t: 'unknown' })
    expect(r.valid).toBe(false)
    expect(r.missing[0]).toBe('t:unknown')
  })
})

describe('ocr-flow 状态机', function () {
  test('defaultState 包含完整字段集', function () {
    const s = flow.defaultState()
    expect(s.visible).toBe(false)
    expect(s.phase).toBe('')
    expect(s.totalPolicies).toBe(0)
    expect(s.confirming).toBe(false)
    expect(Array.isArray(s._policies)).toBe(true)
    expect(s._cashValues).toBeNull()
  })

  test('start 返回 upload 阶段 patch', function () {
    const p = flow.start(5)
    expect(p['ocrMask.visible']).toBe(true)
    expect(p['ocrMask.phase']).toBe('upload')
    expect(p['ocrMask.total']).toBe(5)
    expect(p['ocrMask.uploaded']).toBe(0)
  })

  test('setDone 携带 policies/cashValues + 可选 extra', function () {
    const policies = [{ name: 'p1' }]
    const cv = [{ year: 1 }]
    const p = flow.setDone(policies, cv, { 'ocrMask.matched': true })
    expect(p['ocrMask.phase']).toBe('done')
    expect(p['ocrMask.totalPolicies']).toBe(1)
    expect(p['ocrMask._policies']).toBe(policies)
    expect(p['ocrMask._cashValues']).toBe(cv)
    expect(p['ocrMask.matched']).toBe(true)
  })

  test('setConfirming 转换为布尔', function () {
    expect(flow.setConfirming(1)['ocrMask.confirming']).toBe(true)
    expect(flow.setConfirming(0)['ocrMask.confirming']).toBe(false)
  })

  test('hide 只改 visible/phase，保留 _policies', function () {
    const p = flow.hide()
    expect(p['ocrMask.visible']).toBe(false)
    expect(p['ocrMask.phase']).toBe('')
    expect(p['ocrMask._policies']).toBeUndefined()
  })

  test('reset 重置所有字段', function () {
    const p = flow.reset()
    expect(p['ocrMask.visible']).toBe(false)
    expect(p['ocrMask.phase']).toBe('')
    expect(p['ocrMask._policies']).toEqual([])
    expect(p['ocrMask.confirming']).toBe(false)
  })
})
