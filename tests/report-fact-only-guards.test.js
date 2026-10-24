/**
 * 纯事实边界守卫（2026-10-24）
 *
 * 三条都是"客户手里那份报告"的红线，肉眼看不出、只能靠断言：
 *   ① 分享 payload 不得携带 AI 叙事（建议/画像/结论）—— 客户链接里出现建议 = 定位失效
 *   ② 全仓不得再出现旧名「保障检视报告」（定位已改为「家庭保单化验单」）
 *   ③ 概览的保障型/储蓄型构成必须是**年缴保费**口径（不是保额），且不标百分比
 *
 * 另附成员卡片的四条（无保单成员、固定五行、支柱排序、储蓄年领占位）。
 */
const fs = require('fs')
const path = require('path')
const { buildReportView } = require('../miniprogram/utils/report-builder')

const root = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

describe('① 分享 payload 不得携带 AI 叙事', () => {
  test('share.js 在返回前显式删除 portrait / suggestions / plan 等字段', () => {
    const src = read('cloudfunctions/dataQuery/share.js')
    // 必须有一段剥离逻辑（字段名逐个列出，避免"删了全家桶却漏了 core_insights"）
    ;['portrait', 'suggestions', 'plan', 'conclusion', 'core_insights'].forEach((k) => {
      expect(src).toContain("'" + k + "'")
    })
    expect(src).toMatch(/delete family\.report\[/)
  })
})

describe('② 旧名「保障检视报告」全仓清零', () => {
  const dirs = ['miniprogram', 'cloudfunctions']
  const hit = []
  const walk = (dir) => {
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).forEach((e) => {
      if (e.name === 'node_modules') return
      const rel = path.join(dir, e.name)
      if (e.isDirectory()) return walk(rel)
      if (!/\.(js|wxml|wxss|json)$/.test(e.name)) return
      const text = fs.readFileSync(path.join(root, rel), 'utf8')
      if (text.includes('保障检视报告')) hit.push(rel)
    })
  }
  dirs.forEach(walk)

  test('不得再出现（含 PDF 元数据、空态文案、分享标题）', () => {
    expect(hit).toEqual([])
  })
})

describe('③ 概览构成按年缴保费口径', () => {
  function fam() {
    return {
      name: '张家',
      members: [{ member_id: 'm1', name: '张先生', role: '本人', age: 38 }],
      policies: [
        // 保障型：重疾 保额 50 万 / 保费 6000；储蓄型：年金 保额 20 万 / 保费 18000
        { id: 'p1', insured_name: '张先生', insurance_category: '重疾险', sum_assured: 500000, annual_premium: 6000, status: 'active', effective_date: '2020-01-01', insurance_period: '终身' },
        { id: 'p2', insured_name: '张先生', insurance_category: '年金', sum_assured: 200000, annual_premium: 18000, status: 'active', effective_date: '2021-01-01', insurance_period: '终身' }
      ]
    }
  }

  test('两段金额 = 年缴保费（不是保额）', () => {
    const view = buildReportView(fam(), {})
    const ov = view.chapters[0].customBlocks.find((b) => b.t === 'overview')
    const prot = ov.mixBars.find((b) => b.key === 'prot')
    const sav = ov.mixBars.find((b) => b.key === 'sav')
    // 6000 元 / 1.8 万 —— 若误用保额会得到 50 万 / 20 万
    expect(prot.text).toBe('6000元')
    expect(sav.text).toBe('1.8万')
  })

  test('构成条不标百分比（方案：环心标合计，不标百分比）', () => {
    const comp = read('miniprogram/components/report-markdown/index.wxml')
    const i = comp.indexOf('ov-mix-val')
    expect(i).toBeGreaterThan(-1)
    // 只看这一行：`{{item.pct}}%` 在别处（柱状高度 style）是合法的
    const line = comp.slice(i, i + 200)
    expect(line).not.toContain('%')
  })
})

describe('④ 成员卡片四修', () => {
  function fam() {
    return {
      name: '张家',
      members: [
        { member_id: 'm1', name: '张先生', role: '本人', age: 38 },
        { member_id: 'm2', name: '母亲', role: '父母', age: 65 }
      ],
      policies: [
        { id: 'p1', insured_name: '张先生', insurance_category: '重疾险', sum_assured: 500000, annual_premium: 6000, status: 'active', effective_date: '2020-01-01', insurance_period: '终身', payment_period: '20年' }
      ]
    }
  }

  test('无任何保单的成员也有卡片（并标记 noPolicy）', () => {
    const view = buildReportView(fam(), {})
    const mc = view.chapters.find((c) => c.key === 'member_cards').customBlocks.find((b) => b.t === 'member_cards')
    const mom = mc.members.find((m) => m.name === '母亲')
    expect(mom).toBeTruthy()
    expect(mom.noPolicy).toBe(true)
    expect(mom.footNote).toBe('无任何保单')
  })

  test('有保单的成员固定五行（没有的险种也给 — 行）', () => {
    const view = buildReportView(fam(), {})
    const mc = view.chapters.find((c) => c.key === 'member_cards').customBlocks.find((b) => b.t === 'member_cards')
    const zs = mc.members.find((m) => m.name === '张先生')
    expect(zs.rows.length).toBe(5)
    expect(zs.rows.map((r) => r.cat)).toEqual(['意外', '医疗', '重疾', '寿险', '储蓄'])
    // 没有的险种显示 —（不是空串，也不是 "未知"）
    expect(zs.rows.find((r) => r.cat === '寿险').sumText).toBe('—')
  })

  test('成员顺序：经济支柱（按投保人推断）优先', () => {
    const f = fam()
    // 母亲为张先生投保 → 母亲是推断出的支柱；她无保单但必须排第一
    f.policies[0].policyholder_name = '母亲'
    const view = buildReportView(f, {})
    const mc = view.chapters.find((c) => c.key === 'member_cards').customBlocks.find((b) => b.t === 'member_cards')
    expect(mc.members[0].name).toBe('母亲')
  })

  test('储蓄行优先显示年领（annuity_payout 存在时）', () => {
    const f = fam()
    f.policies.push({ id: 'p2', insured_name: '张先生', insurance_category: '年金', sum_assured: 100000, annual_premium: 3000, annuity_payout: 12000, status: 'active', effective_date: '2022-01-01', insurance_period: '终身' })
    const view = buildReportView(f, {})
    const mc = view.chapters.find((c) => c.key === 'member_cards').customBlocks.find((b) => b.t === 'member_cards')
    const zs = mc.members.find((m) => m.name === '张先生')
    expect(zs.rows.find((r) => r.cat === '储蓄').sumText).toBe('年领 1.2万')
  })
})

describe('⑤ 缴费月历：月份未知桶 + 口径说明', () => {
  test('没有可解析生效月的保单进"月份未知"，不混进 12 格', () => {
    const f = {
      name: '张家',
      members: [{ member_id: 'm1', name: '张先生', role: '本人', age: 38 }],
      policies: [
        { id: 'p1', insured_name: '张先生', insurance_category: '重疾险', sum_assured: 500000, annual_premium: 6000, status: 'active', insurance_period: '终身' }
      ]
    }
    const view = buildReportView(f, {})
    const cal = view.chapters.find((c) => c.key === 'premium_calendar').customBlocks.find((b) => b.t === 'calendar')
    expect(cal.unknownText).toContain('月份未知')
    expect(cal.basisText).toContain('生效月估算')
    // 12 格全部为 "-"（这笔保费没有落到任何月份）
    expect(cal.items.every((x) => x.v === '-')).toBe(true)
  })
})
