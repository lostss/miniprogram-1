/**
 * 续保 / 批改冲突判定（2026-10-18）
 *
 * 原行为：同保单号 + 同产品名命中库中记录就**无条件 skip**（去重是对的，但把"续期/批改"一并吞了）。
 * 后果：用户以为更新了，库里仍是旧保费/旧保额；而报告里的缺口、保费占比、回本年限全部据此计算。
 *
 * 判定原则：**只看本次真的读到的字段** —— 本次为空（OCR 没读出来）不算"变更"，
 * 否则每张图漏读一个字段就会天天弹"要不要覆盖"。
 */
const { diffPolicyConflict } = require('../cloudfunctions/dataWrite/policy-write')

describe('diffPolicyConflict — 续保/批改 vs 完全一致', () => {
  const existing = { sum_assured: 300000, annual_premium: 5000, effective_date: '2023-01-01' }

  test('完全一致 → 无冲突（纯重复上传，静默跳过即可）', () => {
    expect(diffPolicyConflict(existing, { ...existing })).toEqual([])
  })

  test('保费变了（续期最常见）→ 冲突，并指出字段', () => {
    expect(diffPolicyConflict(existing, { ...existing, annual_premium: 5600 })).toEqual(['annual_premium'])
  })

  test('保额变了（批改）→ 冲突', () => {
    expect(diffPolicyConflict(existing, { ...existing, sum_assured: 500000 })).toEqual(['sum_assured'])
  })

  test('生效日变了（新保单年度）→ 冲突', () => {
    expect(diffPolicyConflict(existing, { ...existing, effective_date: '2024-01-01' })).toEqual(['effective_date'])
  })

  test('多个字段同时变 → 全部列出（前端据此拼提示文案）', () => {
    const r = diffPolicyConflict(existing, { sum_assured: 500000, annual_premium: 5600, effective_date: '2024-01-01' })
    expect(r.sort()).toEqual(['annual_premium', 'effective_date', 'sum_assured'])
  })

  test('本次没读到的字段不算变更（空值 ≠ 批改，是 OCR 缺字段）', () => {
    expect(diffPolicyConflict(existing, { sum_assured: 0, annual_premium: '', effective_date: '' })).toEqual([])
    expect(diffPolicyConflict(existing, {})).toEqual([])
  })

  test('金额相等但类型不同（字符串/数字）不误报', () => {
    expect(diffPolicyConflict(existing, { sum_assured: '300000', annual_premium: '5000' })).toEqual([])
  })

  test('库中缺字段（历史数据）→ 只要本次有值就算冲突，不会当成一致', () => {
    expect(diffPolicyConflict({}, { annual_premium: 5000 })).toEqual(['annual_premium'])
  })
})

describe('冲突确认后走 updatePolicy（不自己拼 update，避免绕开 facts 同步）', () => {
  const fs = require('fs')
  const path = require('path')
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

  test('overwritePolicies 复用 savePolicyData（= dataWrite.updatePolicy）', () => {
    const src = read('miniprogram/utils/ocr-flow.js')
    expect(src).toContain('async function overwritePolicies')
    expect(src).toMatch(/savePolicyData\(\{\s*familyId: familyId,\s*policyId: c\.policyId/)
    expect(src).toContain('overwritePolicies,')
  })

  test('保存链在 skip 之后仍会问用户（否则冲突被静默吞掉）', () => {
    const comp = read('miniprogram/components/ocr-flow/index.js')
    expect(comp).toContain('ok.conflicts')
    expect(comp).toContain('覆盖更新')
    expect(comp).toContain('保留原值')
  })

  test('服务端把 conflict 聚合进批次结果（含 policyId 与可编辑字段快照）', () => {
    const src = read('cloudfunctions/dataWrite/policy-write.js')
    expect(src).toContain('conflicts.push')
    expect(src).toContain('_pickEditable(doc)')
    // conflicts 里的 incoming 必须是"可编辑字段"快照，前端直接拿去 updatePolicy
    expect(src).toMatch(/incoming: cf\.incoming/)
  })
})
