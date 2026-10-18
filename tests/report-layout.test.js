/**
 * 报告页信息架构守卫（2026-10-14 建立 → 2026-10-18 IA 重构后重写）
 *
 * 演变：
 *   · 10-14：折叠区 `</block>` 写到页尾，把正文/免责/footer 全吞进「展开保障分析（AI 解读）」，
 *            而 showLegacyBody 默认 false → 首屏看不到正文与合规项。当时的守卫是"折叠区行范围"。
 *   · 10-18：用户决策 **规则类内容 = 一份完整的保单整理报告（常驻）；AI = 页尾进阶报告（手动触发）**。
 *            折叠区整体移除 → 守卫改为**顺序断言**：规则内容在前、AI 在正文之后、合规与页尾常驻。
 *
 * 这类错误不会报错（标签合法、样式正常、单测全绿，只是渲染顺序/范围悄悄变了），
 * 所以必须钉结构而不是钉文案。
 */
const fs = require('fs')
const path = require('path')

const WXML = path.join(__dirname, '..', 'miniprogram', 'pages', 'report', 'index.wxml')
const src = fs.readFileSync(WXML, 'utf8')

// ⚠️ 结构扫描必须在"注释已置空（保留换行 → 行号不变）"的副本上做：
// 本文件注释里出现了 `<block>` / `</block>` 字面文本，不置空会污染嵌套计数（踩过两次）。
const lines = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).split(/\r?\n/)
const plain = src.replace(/<!--[\s\S]*?-->/g, '')

function lineOf(re) {
  const i = lines.findIndex((l) => re.test(l))
  expect(i).toBeGreaterThan(-1)
  return i + 1
}

describe('报告页 IA：规则内容整合进章节、AI 在页尾、合规与页尾常驻', () => {
  test('页面只剩四块：页头 → 正文 → 进阶报告 → 页尾（页面级内容已全部进章节）', () => {
    const order = [
      ['页头标题', /class="title-main"|family\.name/],
      ['正文（章节）', /<report-markdown/],
      ['进阶报告头', /class="adv-head-card"/],
      ['免责声明', /class="report-disclaimer"/],
      ['页尾操作区', /class="report-footer/]
    ]
    const got = order.map(([name, re]) => ({ name, line: lineOf(re) }))
    const sorted = got.slice().sort((a, b) => a.line - b.line)
    expect(got.map((x) => x.name)).toEqual(sorted.map((x) => x.name))
  })

  test('成员规模与待完善已进章节：页面不得再渲染 checkup.groups / checkup.pending', () => {
    expect(plain).not.toContain('checkup.groups')
    expect(plain).not.toContain('checkup.pending')
    expect(plain).not.toContain('checkup.unassigned')
    // 对应内容改由组件渲染
    const comp = fs
      .readFileSync(path.join(__dirname, '..', 'miniprogram', 'components', 'report-markdown', 'index.wxml'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
    expect(comp).toContain("block.t==='pending_list'")
    expect(comp).toContain('node.scaleText')
  })

  test('页面级汇总卡/诊断卡已移除（搬进 chapters.overview，由组件渲染）', () => {
    // 注意：待完善/未归入成员仍用 .sum-card 容器 —— 所以不能按类名断言，要按**概览特有内容**
    expect(plain).not.toContain('checkup.summary.policyCount')
    expect(plain).not.toContain('sum-pair')
    expect(plain).not.toMatch(/class="diag-card"/)
    // 概览内容改由 report-markdown 的 overview block 渲染
    const comp = fs
      .readFileSync(path.join(__dirname, '..', 'miniprogram', 'components', 'report-markdown', 'index.wxml'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
    expect(comp).toContain("block.t==='overview'")
    expect(comp).toContain('block.payoutText')
    expect(comp).toContain('给付型 · 寿险 / 重疾')
  })

  test('折叠机制整体移除（showLegacyBody / legacy-toggle 不得回归）', () => {
    expect(plain).not.toMatch(/showLegacyBody|legacy-toggle/)
  })

  test('正文在进阶报告之前（正则是规则交付物，AI 是加购层）', () => {
    expect(lineOf(/<report-markdown/)).toBeLessThan(lineOf(/class="adv-head-card"/))
  })

  test('AI 生成入口是手动按钮，且不再有"自动生成"承诺文案', () => {
    expect(plain).toContain('bindtap="onDeepAnalysis"')
    expect(plain).toContain('生成进阶报告')
    // 原文案"系统会在信息更新后自动生成分析"已随自动生成一起移除
    expect(plain).not.toContain('系统会在信息更新后自动生成分析')
    expect(plain).not.toContain('保障分析自动更新中')
  })

  test('保额口径：不给「报销额度 + 给付金额」的合计（断言在组件侧）', () => {
    const comp = fs
      .readFileSync(path.join(__dirname, '..', 'miniprogram', 'components', 'report-markdown', 'index.wxml'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
    expect(comp).not.toContain('保障型保额合计')
    // ⚠️ 划分口径必须是**险种**（给付型 / 报销额度）。第一版用"保障型 − 一年期"，
    // 真机立刻自相矛盾：卡片 300 万，而险种明细 寿险100+重疾210=310 万。
    expect(comp).toContain('block.payoutText')
    expect(comp).toContain('block.quotaText')
  })

  test('wxml 标签计数平衡（提前/延后闭合会立即失衡）', () => {
    const cnt = (re) => (plain.match(re) || []).length
    expect(cnt(/<block\b/g)).toBe(cnt(/<\/block>/g))
    // 自闭合 <view ... /> 不存在于本文件；若将来引入需同步调整此断言
    expect(cnt(/<view\b/g)).toBe(cnt(/<\/view>/g))
  })
})
