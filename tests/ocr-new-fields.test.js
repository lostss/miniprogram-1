/**
 * 三个新字段的采集链路（2026-10-27）
 *
 * 上一轮只做到「编辑 Sheet 可手动录入 + 写库白名单」，OCR 从不产出这三个字段，
 * 结果报告里永远是「未采集 / 按生效月估算」。这条链路补的是：
 *   prompt 提取 → buildPolicyFromExtract 映射 → writePolicy 落库 → 报告消费
 *
 * 重点钉住两条**不会报错但会写错数**的规则：
 *   ① 缺值存 0（= 未采集），不是 null、不是空串
 *   ② 越界值归 0，**不夹到边界**（13 号不能变成 12 月、120% 不能变成 100%）
 */
const path = require('path')
const fs = require('fs')

const CORE = path.join(__dirname, '..', 'cloudfunctions', 'ocrService', '_shared', 'ocr-core.js')
const PROMPT = path.join(__dirname, '..', 'cloudfunctions', 'ocrService', 'prompts.js')
const WRITE = path.join(__dirname, '..', 'cloudfunctions', 'dataWrite', 'policy-write.js')

const { buildPolicyFromExtract } = require(CORE)

function build(contractBasic, product) {
  return buildPolicyFromExtract(
    [Object.assign({ product_name: 'XX年金', insurance_category: '年金', sum_assured: 100000, annual_premium: 3000 }, product)],
    Object.assign({ policy_number: 'P1', insurance_company: '平安人寿', contract_effective_date: '2020-01-01', policyholder_name: '张三', insured_name: '张三' }, contractBasic),
    { overallConf: 0.9, fieldConf: {}, ocrReliable: true, autoConfirmed: false }
  )[0]
}

describe('① prompt 里确实要求提取这三个字段', () => {
  const src = fs.readFileSync(PROMPT, 'utf8')
  test('同义词表与 JSON 模板都包含 payment_month / beneficiary_ratio / annuity_payout', () => {
    ;['payment_month', 'beneficiary_ratio', 'annuity_payout'].forEach((k) => {
      // 同义词引导 + 模板各出现至少一次
      expect(src.split(k).length).toBeGreaterThan(2)
    })
  })

  test('明确写了「只在原文明确写出时提取」，禁止用生效日/法定推算', () => {
    expect(src).toContain('只在原文明确写出时提取')
    expect(src).toContain('不要用生效日推算')
    expect(src).toContain('"法定"不是比例')
  })
})

describe('② buildPolicyFromExtract 映射与边界', () => {
  test('正常值透传', () => {
    const p = build({ payment_month: 3, beneficiary_ratio: 100 }, { annuity_payout: 12000 })
    expect(p.payment_month).toBe(3)
    expect(p.beneficiary_ratio).toBe(100)
    expect(p.annuity_payout).toBe(12000)
  })

  test('缺值 → 0（= 未采集），不是 null/空串', () => {
    const p = build({}, {})
    expect(p.payment_month).toBe(0)
    expect(p.beneficiary_ratio).toBe(0)
    expect(p.annuity_payout).toBe(0)
  })

  test('越界归 0，不夹到边界（错值比缺值更糟）', () => {
    expect(build({ payment_month: 13 }).payment_month).toBe(0)
    expect(build({ payment_month: -1 }).payment_month).toBe(0)
    expect(build({ beneficiary_ratio: 120 }).beneficiary_ratio).toBe(0)
    expect(build({ beneficiary_ratio: 0 }).beneficiary_ratio).toBe(0)
  })
})

describe('③ writePolicy 落库时不能丢这三个字段', () => {
  const src = fs.readFileSync(WRITE, 'utf8')
  test('doc 组装里包含三个键（提取了却在写入时丢掉 = 永远未采集）', () => {
    ;['beneficiary_ratio', 'payment_month', 'annuity_payout'].forEach((k) => {
      expect(src).toContain(k + ':')
    })
  })

  test('同一套边界规则（否则 OCR 归 0、手动编辑却写 120）', () => {
    expect(src).toContain('n >= 1 && n <= 12')
    expect(src).toContain('n > 0 && n <= 100')
  })
})

describe('④ 报告侧把 0 当"未采集"而不是"填错了"', () => {
  const AL = path.join(__dirname, '..', 'miniprogram', 'utils', 'anomaly-list.js')
  const { buildAnomalies } = require(AL)
  const NOW = new Date('2026-06-01')

  function pol(over) {
    return Object.assign({
      id: 'p1', product_name: 'XX重疾', insurance_category: '重疾险', sum_assured: 500000,
      annual_premium: 3000, effective_date: '2020-01-01', insurance_period: '终身',
      status: 'active', beneficiary_name: '张三', beneficiary_ratio: 0
    }, over)
  }

  test('ratio=0（未采集）→ 聚合一条，不逐条列成"比例 0%"', () => {
    const g = buildAnomalies({ policies: [pol({}), pol({ id: 'p2' })], now: NOW })
    const a3 = g.find((x) => x.code === 'A3')
    expect(a3).toBeTruthy()
    expect(a3.count).toBe(2)
    // 只聚合一条，且文案是"未采集"而不是"比例 0%"
    expect(a3.items.length).toBe(1)
    expect(a3.items[0].detail).toContain('未采集')
    // 不能写成"受益比例 0%…"（那是"填错了"的语气）；100% 是提示语里的目标值，不算
    expect(a3.items[0].detail).not.toContain('比例 0%')
  })

  test('ratio=120（填错）→ 逐条列，并写明应在 1–100%', () => {
    const g = buildAnomalies({ policies: [pol({ beneficiary_ratio: 120 })], now: NOW })
    const a3 = g.find((x) => x.code === 'A3')
    expect(a3.items.length).toBe(1)
    expect(a3.items[0].detail).toContain('120%')
  })
})
