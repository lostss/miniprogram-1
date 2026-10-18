/**
 * 目录激活态（2026-10-18）
 *
 * 目标：报告页顶部吸顶章节标签高亮"当前正在读哪一章"。
 *
 * 为什么单独抽一个纯函数：判定依赖"哪些章节落在可视带里"，而"可视带"由组件用
 * IntersectionObserver 观察（滚动容器在页面、章节节点在组件内，组件拿不到 scrollTop）。
 * 观察是平台能力、测不了；**归约规则**能测，所以把它拿出来钉住。
 */
const { pickActiveKey } = require('../miniprogram/utils/toc-active')

describe('pickActiveKey — 目录激活态归约', () => {
  const keys = ['overview', 'family_structure', 'coverage_summary', 'gap_analysis']

  test('多个章节同时可见 → 取目录顺序里的第一个（视线在上方那章）', () => {
    expect(pickActiveKey(keys, { coverage_summary: true, gap_analysis: true }, '')).toBe('coverage_summary')
  })

  test('只有一章可见 → 就是它', () => {
    expect(pickActiveKey(keys, { gap_analysis: true }, '')).toBe('gap_analysis')
  })

  test('一个都不可见 → 保留上一次（清空会让标签在滚动中闪一下）', () => {
    expect(pickActiveKey(keys, {}, 'coverage_summary')).toBe('coverage_summary')
  })

  test('首次进入且什么都不可见 → 空串（不高亮，避免默认亮一个错误项）', () => {
    expect(pickActiveKey(keys, {}, '')).toBe('')
  })

  test('可见集合里有目录之外的 key（章节被删/顺序变化）→ 忽略，不返回野值', () => {
    expect(pickActiveKey(keys, { removed_chapter: true }, 'overview')).toBe('overview')
  })

  test('入参缺失不崩（章节还没渲染时的回调）', () => {
    expect(pickActiveKey(null, null, '')).toBe('')
    expect(pickActiveKey(keys, null, 'overview')).toBe('overview')
  })
})

describe('接线守卫：组件确实用了它，且标签有激活样式', () => {
  const fs = require('fs')
  const path = require('path')
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'components', 'report-markdown', p), 'utf8')

  test('组件用 IntersectionObserver 观察章节，并用 pickActiveKey 归约', () => {
    const js = read('index.js')
    expect(js).toContain('pickActiveKey')
    expect(js).toContain('createIntersectionObserver')
    expect(js).toContain('relativeToViewport')
    // 组件销毁时必须断开，否则页面来回进出会累积观察器
    expect(js).toMatch(/detached\(\)[\s\S]{0,200}disconnect/)
  })

  test('标签绑定 is-active，并且容器支持把高亮标签滚进可视区', () => {
    const wxml = read('index.wxml')
    expect(wxml).toContain("activeKey === item.key ? 'is-active' : ''")
    expect(wxml).toContain('scroll-into-view="{{tocInto}}"')
    expect(wxml).toContain('id="toc-{{item.key}}"')
  })

  test('激活态样式有实底高亮（浅色描边在横向滚动条里看不出来）', () => {
    const wxss = read('index.wxss')
    expect(wxss).toMatch(/\.toc-item\.is-active\s*\{[^}]*background:var\(--accent-deep\)/)
  })
})
