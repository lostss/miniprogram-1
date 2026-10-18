/**
 * 目录激活态（2026-10-18，第二版）
 *
 * 第一版用 IntersectionObserver 判断"哪些章节落在可视带里"，真机暴露两个问题：
 *   ① 回到顶部不回弹（可视带里暂时没有章节时按"保留上一次"处理 → 标签停在中途）
 *   ② 对应不准确（章节标题被吸顶目录挡住时该章已不在带内 → 高亮跳过一章）
 *
 * 第二版：按滚动位置取"最后一个越过目录下沿的章节"。几何规则纯函数化，便于钉住。
 */
const { pickActiveByOffset } = require('../miniprogram/utils/toc-active')

// 测量时刻各章标题的屏幕坐标（第一章在目录下方 200px 处，章间距 400px）
const OFFSETS = [
  { key: 'overview', top0: 200 },
  { key: 'family_structure', top0: 600 },
  { key: 'family_finance', top0: 1000 },
  { key: 'coverage_summary', top0: 1400 }
]
const LINE = 80 // 目录下沿屏幕坐标

describe('pickActiveByOffset — 以"越过目录下沿"为准', () => {
  test('未滚动 → 没有章节越过线，回弹到第一章（修"回到顶部不回弹"）', () => {
    expect(pickActiveByOffset(OFFSETS, 0, LINE)).toBe('overview')
  })

  test('第二章标题刚越过线 → 第二章（即使第一章还占着大半屏）', () => {
    // dy = 600 - 80 = 520 时，第二章正好压线
    expect(pickActiveByOffset(OFFSETS, 520, LINE)).toBe('family_structure')
    expect(pickActiveByOffset(OFFSETS, 519, LINE)).toBe('overview')
  })

  test('滚动超过最后一章 → 停在最后一章（不会越界成空）', () => {
    expect(pickActiveByOffset(OFFSETS, 99999, LINE)).toBe('coverage_summary')
  })

  test('滚动回顶部（dy 归零）→ 一定回到第一章（修 ① 的直接判据）', () => {
    const deep = pickActiveByOffset(OFFSETS, 1600, LINE)
    expect(deep).toBe('coverage_summary')
    expect(pickActiveByOffset(OFFSETS, 0, LINE)).toBe('overview')
  })

  test('章节标题被目录挡住 ≠ 下一章（修 ②：按"越过线"而不是"是否可见"）', () => {
    // 第 2 章标题已滚到屏幕外（dy=700 → top=-100），但第 3 章还没到线（1000-700=300 > 80）
    expect(pickActiveByOffset(OFFSETS, 700, LINE)).toBe('family_structure')
  })

  test('入参异常不崩：空数组 / 缺 top0', () => {
    expect(pickActiveByOffset([], 0, LINE)).toBe('')
    expect(pickActiveByOffset([{ key: 'a' }], 0, LINE)).toBe('a')
  })
})

describe('接线守卫：滚动位置由页面送入组件（组件拿不到 scrollTop）', () => {
  const fs = require('fs')
  const path = require('path')
  const readMin = (p) => fs.readFileSync(path.join(__dirname, '..', 'miniprogram', p), 'utf8')

  test('页面 bindscroll 已接到 onReportScroll，并调用组件方法（不 setData）', () => {
    const wxml = readMin('pages/report/index.wxml')
    expect(wxml).toContain('bindscroll="onReportScroll"')
    expect(wxml).toContain('id="reportMarkdown"')
    const js = readMin('pages/report/index.js')
    const i = js.indexOf('onReportScroll(e)')
    const body = js.slice(i, i + 500)
    expect(body).toContain("selectComponent('#reportMarkdown')")
    expect(body).toContain('syncPageScroll')
    expect(body).not.toContain('setData') // 滚动高频，setData 会掉帧
  })

  test('组件用纯函数归约 + 折叠/章节变化后作废测量', () => {
    const js = readMin('components/report-markdown/index.js')
    expect(js).toContain('pickActiveByOffset')
    // 方法名不能以 on 开头（否则被 wxml-binding-integrity 当作未绑定的事件处理器）
    expect(js).toContain('syncPageScroll(scrollTop)')
    expect(js).not.toContain('onPageScroll')
    // 折叠会改变其后所有章节的位置
    expect(js).toMatch(/toggleChapter[\s\S]{0,300}_tocOffsets = null/)
    // 章节整体替换同样作废
    expect(js).toMatch(/toc: arr\.map[\s\S]{0,200}_tocOffsets = null/)
    // 第一版的观察器必须彻底移除（两套判定会互相打脸）
    expect(js).not.toContain('createIntersectionObserver')
  })

  test('wxml 绑定 is-active 且容器支持把高亮标签滚进可视区', () => {
    const wxml = readMin('components/report-markdown/index.wxml')
    expect(wxml).toContain("activeKey === item.key ? 'is-active' : ''")
    expect(wxml).toContain('scroll-into-view="{{tocInto}}"')
  })
})
