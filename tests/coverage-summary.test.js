/**
 * 保额按险种拆分（coverage-summary 跨树契约）单元测试
 *
 * 2026-10-14 用户决策：「不再展示单一总保额，按保障类型统计」。
 * 理由：医疗险 400 万报销年限额 + 重疾 30 万保险金额相加没有意义（前者是报销上限、后者是给付金额），
 * 混算会让客户把报销额度当成"能拿到手的钱"。
 *
 * 本组守住三类：
 *  ① 三分桶口径：保障型 / 储蓄型 / **未标注**（不并入任何一类 —— 并入哪个方向都可能高估）
 *  ② 边界：expired 排除、只列金额>0、按金额降序、万口径取整
 *  ③ 接线：报告页 / PDF / AI 上下文**三处消费同一契约**（此前是三份独立实现，最容易再裂）
 */
const { summarizeCoverage, isSavingsCat, SAVINGS_CATS } = require('../miniprogram/utils/coverage-summary')

function pol(cat, wan, over) {
  return Object.assign({ status: 'active', insurance_category: cat, sum_assured: wan * 10000 }, over || {})
}

describe('coverage-summary — 三分桶口径', () => {
  test('保障型（重疾/医疗/意外/寿险）与储蓄型（年金/增额寿/终身寿）分列', () => {
    const r = summarizeCoverage([
      pol('重疾险', 30), pol('医疗险', 400), pol('意外险', 20), pol('寿险', 100),
      pol('年金', 50), pol('增额终身寿', 20), pol('终身寿险', 10)
    ])
    expect(r.protectionW).toBe(550)
    expect(r.savingsW).toBe(80)
    expect(r.totalW).toBe(630)
    // 中文串的 Array.sort 按码位序，不用它比对顺序；这里只验证集合
    expect(new Set(r.byCat.filter(x => x.kind === 'savings').map(x => x.cat))).toEqual(new Set(['年金', '增额终身寿', '终身寿险']))
  })

  test('险种缺失 → 第三桶「其他」（未标注），**不并入**保障型也不并入储蓄型', () => {
    const r = summarizeCoverage([pol('重疾险', 30), { status: 'active', sum_assured: 200000 }])
    expect(r.protectionW).toBe(30)
    expect(r.savingsW).toBe(0)
    expect(r.unknownW).toBe(20)
    expect(r.totalW).toBe(50)
    const other = r.byCat.find(x => x.cat === '其他')
    expect(other.kind).toBe('unknown')
  })

  test('裸词险种归一到规范词（医疗 → 医疗险），不产生重复分类行', () => {
    const r = summarizeCoverage([pol('医疗', 100), pol('医疗险', 200)])
    expect(r.byCat.filter(x => x.cat === '医疗险')).toHaveLength(1)
    expect(r.byCat.find(x => x.cat === '医疗险').w).toBe(300)
  })

  test('isSavingsCat / SAVINGS_CATS 与 thresholds 的键一致（年金/增额终身寿/终身寿险）', () => {
    expect(SAVINGS_CATS).toEqual(['年金', '增额终身寿', '终身寿险'])
    expect(isSavingsCat('年金险')).toBe(true) // 归一后再判
    expect(isSavingsCat('重疾险')).toBe(false)
    expect(isSavingsCat('')).toBe(false)
  })
})

describe('coverage-summary — 边界', () => {
  test('非 active 保单不计入', () => {
    const r = summarizeCoverage([pol('重疾险', 30), Object.assign(pol('寿险', 999), { status: 'expired' })])
    expect(r.protectionW).toBe(30)
    expect(r.policyCount).toBe(1)
  })

  test('一年期短险单独累计（与"按险种拆"是两件事：一个是类型、一个是时效）', () => {
    const r = summarizeCoverage([
      pol('医疗险', 400, { insurance_period: '1年', coverage_term: 1 }),
      pol('重疾险', 30)
    ])
    expect(r.shortTermW).toBe(400)
    expect(r.protectionW).toBe(430)
  })

  test('只列金额 > 0 的险种；按金额降序', () => {
    const r = summarizeCoverage([pol('重疾险', 30), pol('医疗险', 400), pol('意外险', 0)])
    expect(r.byCat.map(x => x.cat)).toEqual(['医疗险', '重疾险'])
  })

  test('万口径取整到 0.1（元 → 万）', () => {
    const r = summarizeCoverage([{ status: 'active', insurance_category: '重疾险', sum_assured: 123456 }])
    expect(r.protectionW).toBe(12.3)
  })

  test('空输入 → 全 0 且结构完整', () => {
    const r = summarizeCoverage([])
    expect(r.byCat).toEqual([])
    expect([r.protectionW, r.savingsW, r.unknownW, r.totalW, r.shortTermW]).toEqual([0, 0, 0, 0, 0])
  })
})

describe('保额拆分接线（防第四份实现 / 防只改一处）', () => {
  const fs = require('fs')
  const path = require('path')
  const root = path.join(__dirname, '..')

  test('三个消费面都引用同一契约', () => {
    const normalizer = fs.readFileSync(path.join(root, 'miniprogram', 'utils', 'report', 'data-normalizer.js'), 'utf8')
    const pdf = fs.readFileSync(path.join(root, 'cloudfunctions', 'reportPdf', 'index.js'), 'utf8')
    const ctx = fs.readFileSync(path.join(root, 'cloudfunctions', 'reportAI', 'report-context.js'), 'utf8')
    expect(normalizer).toContain("require('../coverage-summary')")
    expect(pdf).toContain("require('./_shared/coverage-summary')")
    expect(ctx).toContain("require('./_shared/coverage-summary')")
  })

  test('报告页摘要卡不再渲染单一"总保额"，改为按类展示', () => {
    const wxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'report', 'index.wxml'), 'utf8')
    expect(wxml).not.toContain('>总保额<')
    expect(wxml).toContain('保障型保额')
    expect(wxml).toContain('summaryCards.byCat')
    expect(wxml).toContain('summaryCards.unknown')
  })

  test('PDF 摘要不再输出"总保额"字样', () => {
    const pdf = fs.readFileSync(path.join(root, 'cloudfunctions', 'reportPdf', 'index.js'), 'utf8')
    expect(pdf).not.toContain("'总保额(万)'")
    expect(pdf).toContain('保障型保额(万)')
  })

  test('AI 提示词明确禁止把不同险种保额相加成"总保额"', () => {
    const prompts = fs.readFileSync(path.join(root, 'cloudfunctions', 'reportAI', 'prompts.js'), 'utf8')
    expect(prompts).toContain('禁止**相加成一个"总保额"数字')
  })

  test('契约已登记进 CONTRACT_FILES（否则前端副本静默漂移）', () => {
    const sync = fs.readFileSync(path.join(root, 'scripts', 'sync-shared.js'), 'utf8')
    expect(sync).toContain("'coverage-summary.js'")
  })
})
