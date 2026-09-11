/**
 * edit-form 单测 — 编辑表单配置（含 suspicious 数据异常视觉引导）
 */
const { buildEditConfig } = require('../miniprogram/utils/edit-form')

describe('buildEditConfig policy — suspicious 数据异常视觉引导', () => {
  function fields(p) { return buildEditConfig({ mode: 'policy', family: {}, member: p }).editFields }

  test('suspicious 状态保单：保额字段强制 tone=low（数据异常定位）', () => {
    const p = {
      status: 'suspicious',
      product_name: '测试医疗险',
      annual_premium: 800,
      sum_assured: 0,
      confidence: 0.99,
      field_confidence: { product_name: 0.99, annual_premium: 0.99 }
    }
    const fs = fields(p)
    const sum = fs.find(f => f.key === 'sum_assured')
    expect(sum).toBeDefined()
    expect(sum.tone).toBe('low')
  })

  test('非 suspicious（保额>0）保单：保额字段不因数据异常强制 tone（沿用置信度）', () => {
    const p = {
      status: 'active',
      product_name: '正常保单',
      annual_premium: 800,
      sum_assured: 2000000,
      confidence: 0.99,
      field_confidence: { product_name: 0.99, annual_premium: 0.99 }
    }
    const fs = fields(p)
    const sum = fs.find(f => f.key === 'sum_assured')
    expect(sum.tone).toBe('')
  })

  test('无显式 status 但保额=0且保费>0（calcStatus 同构判定）→ 保额字段 tone=low', () => {
    const p = {
      product_name: '异常数据',
      annual_premium: 500,
      sum_assured: 0,
      confidence: 0.99
    }
    const fs = fields(p)
    const sum = fs.find(f => f.key === 'sum_assured')
    expect(sum.tone).toBe('low')
  })

  test('suspicious 不影响其他字段（仅 sum_assured 定位）', () => {
    const p = {
      status: 'suspicious',
      product_name: '测试',
      annual_premium: 800,
      sum_assured: 0,
      confidence: 0.99,
      field_confidence: { product_name: 0.99, annual_premium: 0.99 }
    }
    const fs = fields(p)
    expect(fs.find(f => f.key === 'annual_premium').tone).toBe('')
    expect(fs.find(f => f.key === 'product_name').tone).toBe('')
  })
})

describe('buildUpdateData policy — P1-F1 清空字段须真实发送（此前空值门控丢弃导致静默失败）', () => {
  const { buildUpdateData } = require('../miniprogram/utils/edit-form')

  test('清空保单号 → payload 含空串（服务端 POLICY_EDITABLE 支持清空）', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', policy_number: '' }, {}, 'pid_1')
    expect(r.updatePolicy.data.policy_number).toBe('')
  })

  test('非空保单号正常发送；未提供的字段不进 payload', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', policy_number: 'P123' }, {}, 'pid_1')
    expect(r.updatePolicy.data.policy_number).toBe('P123')
    expect(r.updatePolicy.data.insurer).toBeUndefined()
    expect(r.updatePolicy.data.sum_assured).toBeUndefined()
  })

  test('清空保额 → 传空串（保留空语义，不换算成 0）', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', sum_assured: '' }, {}, 'pid_1')
    expect(r.updatePolicy.data.sum_assured).toBe('')
  })

  test('非空保额仍按万→元换算', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', sum_assured: '50' }, {}, 'pid_1')
    expect(r.updatePolicy.data.sum_assured).toBe(500000)
  })

  // 2026-09-11：P1-F1 修复时漏了这两个日期字段——它们仍用 truthy 门控，
  // 清空（'' 为 falsy）被静默丢弃 → 提示保存成功但 DB 仍旧值，下次打开"复原"。
  // 服务端侧已确认可安全接收空串：POLICY_EDITABLE 含两者，且 effective_date 的
  // 格式校验显式短路空串（`v !== ''`），不会因此报 400。
  test('清空生效日期 → payload 含空串（不再被 truthy 门控丢弃）', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', effective_date: '' }, {}, 'pid_1')
    expect(r.updatePolicy.data).toHaveProperty('effective_date')
    expect(r.updatePolicy.data.effective_date).toBe('')
  })

  test('清空状态生效日期 → payload 含空串', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', status_effective_date: '' }, {}, 'pid_1')
    expect(r.updatePolicy.data).toHaveProperty('status_effective_date')
    expect(r.updatePolicy.data.status_effective_date).toBe('')
  })

  test('未提供生效日期 → 不进 payload（避免误清空既有值）', () => {
    const r = buildUpdateData('policy', { product_name: '测试险' }, {}, 'pid_1')
    expect(r.updatePolicy.data.effective_date).toBeUndefined()
    expect(r.updatePolicy.data.status_effective_date).toBeUndefined()
  })
})
