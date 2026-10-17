/**
 * 报告页布局结构守卫（2026-10-14）
 *
 * 背景（用户实报 + 真机截图）：`pages/report/index.wxml` 的「展开保障分析（AI 解读）」折叠区
 * 其 `</block>` 原本写到了页尾才闭合，把**保单整理报告的正文**（report-markdown 章节目录 + 全 7 章）、
 * 免责声明、转发/导出 footer 全部包了进去。而 `showLegacyBody` 默认 `false`
 * → 首屏只剩页头 + 汇总卡 + 按成员整理，正文与页尾（含合规免责、转发/导出按钮）全部不可见。
 *
 * 这类错误**不会报错**：标签闭合合法、WXSS 正常、单测全绿，只是渲染范围悄悄变大。
 * 故用"折叠区范围"断言钉住，而不是只断言"某段文案存在"。
 */
const fs = require('fs')
const path = require('path')

const WXML = path.join(__dirname, '..', 'miniprogram', 'pages', 'report', 'index.wxml')
const src = fs.readFileSync(WXML, 'utf8')

// ⚠️ 结构扫描必须在"注释已置空（保留换行 → 行号不变）"的副本上做：
// 本文件注释里出现了 `<block>` / `</block>` 字面文本（讲"用 <block> 拆开"、记录本次修复），
// 不置空会污染嵌套计数 —— 写这条守卫时踩了两次（假失衡 + 抓不到注入的 bug）。
const lines = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).split(/\r?\n/)

/** 找到 AI 折叠区的 `<block>` 起止行号（1-based），用嵌套计数配对，而非硬编码行号 */
function legacyBlockRange() {
  const startIdx = lines.findIndex((l) => /\{\{!hasPolicy \|\| showLegacyBody\}\}/.test(l))
  expect(startIdx).toBeGreaterThan(-1)
  let depth = 0
  for (let i = startIdx; i < lines.length; i++) {
    depth += (lines[i].match(/<block\b/g) || []).length
    depth -= (lines[i].match(/<\/block>/g) || []).length
    if (depth === 0 && i >= startIdx) return { start: startIdx + 1, end: i + 1 }
  }
  throw new Error('折叠区 <block> 未闭合')
}

function lineOf(re) {
  const i = lines.findIndex((l) => re.test(l))
  expect(i).toBeGreaterThan(-1)
  return i + 1
}

describe('报告页布局：AI 折叠区不得吞掉正文与页尾', () => {
  const range = legacyBlockRange()

  test('折叠区起止行落在 AI 材料范围内（不是页尾）', () => {
    // 折叠区应止于事实观察（factsView）附近，不应延伸到 scroll-view 结尾
    expect(range.start).toBeGreaterThan(0)
    expect(range.end).toBeLessThan(lines.length - 4)
  })

  test.each([
    ['保单整理报告正文（章节目录 + 全 7 章）', /<report-markdown/],
    ['免责声明（合规项，必须常驻）', /class="report-disclaimer"/],
    ['页尾操作区（转发报告给客户 / 导出 PDF）', /class="report-footer/]
  ])('%s 不得落在折叠区内', (_name, re) => {
    const n = lineOf(re)
    // 折叠区内的元素，行号必然落在 [start, end]；这里断言"在区外"
    const inside = n >= range.start && n <= range.end
    expect({ line: n, range: `${range.start}-${range.end}`, inside }).toEqual({
      line: n,
      range: `${range.start}-${range.end}`,
      inside: false
    })
  })

  test('AI 材料（摘要卡 / 深度解读 / 事实观察）确实在折叠区内 —— 防止"修过度"把折叠区掏空', () => {
    for (const re of [/class="summary-card"/, /class="deep-sec-title"/]) {
      const n = lineOf(re)
      expect(n >= range.start && n <= range.end).toBe(true)
    }
  })

  test('保额口径：不给「报销额度 + 给付金额」的合计', () => {
    const wxml = src.replace(/<!--[\s\S]*?-->/g, '')
    // 整理汇总卡：两颗数字并列，合计不再出现
    expect(wxml).not.toContain('保障型保额合计')
    expect(wxml).toContain('checkup.summary.longTermSumAssuredText')
    expect(wxml).toContain('checkup.summary.shortTermSumAssuredText')
    expect(wxml).toContain('长期给付')
    // AI 摘要卡主数字同口径（两卡相邻，口径不一致会比单卡错更明显）
    expect(wxml).toContain('{{summaryCards.longTerm}}')
    expect(wxml).not.toContain('{{summaryCards.protection}}')
  })

  test('wxml 标签计数平衡（提前/延后闭合会立即失衡）', () => {
    // ⚠️ 必须先剥掉 HTML 注释：本文件的注释里出现了 `<block>` 字面文本（讲"用 <block> 拆开"），
    // 不剥注释会数出 14/13 的假失衡 —— 第一次写这条断言时就踩到了。
    const stripped = src.replace(/<!--[\s\S]*?-->/g, '')
    const cnt = (re) => (stripped.match(re) || []).length
    expect(cnt(/<block\b/g)).toBe(cnt(/<\/block>/g))
    // 自闭合 <view ... /> 不存在于本文件；若将来引入需同步调整此断言
    expect(cnt(/<view\b/g)).toBe(cnt(/<\/view>/g))
  })
})
