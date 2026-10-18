/**
 * 原文出处的"落库 + 展示"链路（2026-10-18）
 *
 * 上一轮只校验、不保存 —— 校验完就把 AI 摘录的片段丢了，代理人只能看到"这个数被标了待核对"，
 * 看不到"AI 说它抄自哪句话"。这一轮把 field_evidence 存进保单并展示在附录保单卡上，
 * 构成 v2.0「结论可溯源」的最小闭环。
 *
 * 关键约束：只存 4 个白名单键、只存非空字符串 —— 防 prompt 漂移时把任意内容落库。
 */
const { buildPolicyFromExtract } = require('../cloudfunctions/_shared/ocr-core')

const conf = { overallConf: 0.9, fieldConf: { sum_assured: 0.95 }, ocrReliable: true, autoConfirmed: true }
const product = { product_name: '测试重疾', sum_assured: 300000, annual_premium: 5000 }
const basic = { policy_number: 'P1', contract_effective_date: '2024-01-15' }

describe('buildPolicyFromExtract — field_evidence 白名单落库', () => {
  test('只保留 4 个关键键，其它键丢弃（防 prompt 漂移写脏数据）', () => {
    const policies = buildPolicyFromExtract([product], basic, Object.assign({}, conf, {
      fieldEvidence: {
        sum_assured: '基本保险金额：30万元',
        annual_premium: '年缴保费：5,000元',
        effective_date: '2024年01月15日',
        policy_number: 'P1',
        product_name: '不该被保存的键',
        whatever: 'x'
      }
    }))
    expect(policies[0].field_evidence).toEqual({
      sum_assured: '基本保险金额：30万元',
      annual_premium: '年缴保费：5,000元',
      effective_date: '2024年01月15日',
      policy_number: 'P1'
    })
  })

  test('空串/非字符串不落库（避免存一堆空值）', () => {
    const policies = buildPolicyFromExtract([product], basic, Object.assign({}, conf, {
      fieldEvidence: { sum_assured: '   ', annual_premium: 5000, effective_date: null }
    }))
    expect(policies[0].field_evidence).toEqual({})
  })

  test('没有 evidence（老 prompt / 非保单图）→ 空对象，绝不 undefined', () => {
    const policies = buildPolicyFromExtract([product], basic, Object.assign({}, conf, {}))
    expect(policies[0].field_evidence).toEqual({})
  })
})

describe('附录保单卡展示（只有 owner、且有的才显示）', () => {
  const fs = require('fs')
  const path = require('path')
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
  const { buildChapters } = require('../miniprogram/utils/report-builder')

  test('卡片数据里带 evidence 行，格式为「保额：…　·　保费：…」', () => {
    const customer = {
      name: '李阳勇',
      members: [{ member_id: 'm1', name: '李阳勇', role: '本人', age: 40 }],
      policies: [{
        id: 'p1', product_name: '测试重疾', insurance_category: '重疾险', insured_name: '李阳勇',
        sum_assured: 300000, annual_premium: 5000, effective_date: '2024-01-15', status: 'active',
        insurance_period: '终身',
        field_evidence: { sum_assured: '基本保险金额：30万元', annual_premium: '年缴保费：5,000元' }
      }]
    }
    const ch = buildChapters(customer, {})
    const block = ch.find((x) => x.key === 'appendix_policies').customBlocks.find((b) => b.t === 'policy_cards')
    const card = block.groups[0].subgroups[0].policies[0]
    expect(card.evidence).toContain('保额：基本保险金额：30万元')
    expect(card.evidence).toContain('保费：年缴保费：5,000元')
  })

  test('没有 evidence → 空串（wxml 用 wx:if 整行不渲染）', () => {
    const customer = {
      name: 'X',
      members: [{ member_id: 'm1', name: 'X', role: '本人' }],
      policies: [{ id: 'p1', product_name: 'A', insurance_category: '重疾险', insured_name: 'X', status: 'active' }]
    }
    const ch = buildChapters(customer, {})
    const block = ch.find((x) => x.key === 'appendix_policies').customBlocks.find((b) => b.t === 'policy_cards')
    expect(block.groups[0].subgroups[0].policies[0].evidence).toBe('')
  })

  test('WXML 只在 owner 显示（客户版不该看到"抄的哪句话"这种内部口径）', () => {
    const wxml = read('miniprogram/components/report-markdown/index.wxml')
    expect(wxml).toContain('pc-evidence')
    expect(wxml).toMatch(/wx:if="\{\{p\.evidence && !readonly\}\}"/)
  })
})
