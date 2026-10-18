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

// 2026-10-18 真机事故回归：改成第二版后，真机仍报 `pickActiveKey is not defined`
// 并表现为"回顶不回弹"。根因是**字符串断言看不见运行期符号错误** —— 我加了
// `toContain('pickActiveByOffset')` 却没断言"不再调用已删除的旧函数"。
// 这里直接实例化组件、驱动 syncPageScroll，让这类错误在 jest 里就炸。
describe('运行期：真实驱动组件（能抓到 ReferenceError / 高亮不动）', () => {
  function loadComponent() {
    let cfg = null
    global.Component = (c) => { cfg = c }
    // jest 有自己的模块注册表，删 require.cache 不会重新执行模块 → 必须 resetModules
    jest.resetModules()
    require('../miniprogram/components/report-markdown/index.js')
    return cfg
  }

  function makeInstance(cfg, tocKeys, cardTops, tocBottom) {
    const inst = Object.assign({}, cfg.methods)
    inst.data = { toc: tocKeys.map((k) => ({ key: k, num: '', title: k })), cards: [{ key: tocKeys[0] }], activeKey: '', tocInto: '' }
    inst.setData = (patch) => { Object.assign(inst.data, patch) }
    const cards = tocKeys.map((k, i) => ({ id: 'ch-' + k, top: cardTops[i] }))
    const q = {
      select: () => q,
      selectAll: () => q,
      boundingClientRect: () => q,
      fields: () => q,
      exec: (cb) => cb([{ bottom: tocBottom }, cards])
    }
    inst.createSelectorQuery = () => q
    return inst
  }

  const keys = ['overview', 'family_structure', 'family_finance']

  test('滚到顶部（scrollTop=0）→ 高亮第一章，无需测量', () => {
    const inst = makeInstance(loadComponent(), keys, [200, 600, 1000], 76)
    inst.syncPageScroll(0)
    expect(inst.data.activeKey).toBe('overview')
  })

  test('从顶部继续下滚 → 测量后按"越过目录下沿"切换', () => {
    const inst = makeInstance(loadComponent(), keys, [200, 600, 1000], 76)
    inst.syncPageScroll(0)            // 回顶：直接第一章
    inst.syncPageScroll(540)          // 首次非顶部 → 触发测量（top0 以此刻为基准）
    // 测量点 540：第二章标题在 600 → 需要再滚 520 才压线（600 − 520 = 80 = 目录下沿）
    inst.syncPageScroll(1050)         // dy=510 → 仍未压线
    expect(inst.data.activeKey).toBe('overview')
    inst.syncPageScroll(1080)         // dy=540 → 第二章标题越过目录下沿
    expect(inst.data.activeKey).toBe('family_structure')
  })

  test('滚回顶部一定回弹第一章（真机 bug 的直接判据）', () => {
    const inst = makeInstance(loadComponent(), keys, [200, 600, 1000], 76)
    inst.syncPageScroll(540)
    inst.syncPageScroll(1200)         // 已切到后面的章节
    expect(inst.data.activeKey).not.toBe('overview')
    inst.syncPageScroll(0)
    expect(inst.data.activeKey).toBe('overview')
  })

  test('tocInto 跟随高亮，标签自动滚进可视区', () => {
    const inst = makeInstance(loadComponent(), keys, [200, 600, 1000], 76)
    inst.syncPageScroll(540)
    inst.syncPageScroll(1200)
    expect(inst.data.tocInto).toBe('toc-' + inst.data.activeKey)
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

  test('组件只能引用已导入的符号（真机曾报 pickActiveKey is not defined）', () => {
    const js = readMin('components/report-markdown/index.js')
    // 第一版函数已删除：任何残留调用都是运行期 ReferenceError，而字符串断言看不出来
    expect(js).not.toContain('pickActiveKey')
    // 用到就必须导入（这里只覆盖 toc-active 的导出名）
    const used = /pickActiveByOffset\s*\(/.test(js)
    if (used) expect(js).toContain("require('../../utils/toc-active')")
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
