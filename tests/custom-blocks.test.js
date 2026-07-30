/**
 * custom-blocks 注册表 + ocr-flow 状态机 单元测试
 */
const cb = require('../miniprogram/utils/custom-blocks')
const flow = require('../miniprogram/utils/ocr-flow')

describe('custom-blocks 注册表', function () {
  test('SUPPORTED_TYPES 声明 6 种类型', function () {
    expect(cb.SUPPORTED_TYPES.sort()).toEqual(['calendar', 'insight_cards', 'overview', 'panorama', 'timeline', 'urgent_list'])
  })

  test('create 补齐默认字段并保留 t', function () {
    const b = cb.create('overview', { rate: 50 })
    expect(b.t).toBe('overview')
    expect(b.rate).toBe(50)
    expect(b.totalGap).toBe(0)
    expect(b.totalCoverage).toBe(0)
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
    expect(cb.validate({ t: 'overview', rate: 50 }).valid).toBe(false)
    expect(cb.validate({ t: 'overview', rate: 50, totalGap: 0, annualPremium: 0, debt: 0, totalCoverage: 0 }).valid).toBe(true)
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

  test('setRecognize 进入 recognize 阶段', function () {
    const p = flow.setRecognize()
    expect(p['ocrMask.phase']).toBe('recognize')
    expect(p['ocrMask.processed']).toBe(0)
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
