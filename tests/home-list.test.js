/**
 * 首页（客户列表）2026-10-17 改造守卫
 *
 * 用户决策四条：
 *   ① 移除客户卡上的资料完整度圆环（completeness_score）
 *   ② 日期改为"多久前更新"（原实现 ≥1 天就退化成 M/D，丢掉"这个客户多久没动过"）
 *   ③ 列表只按家庭名称显示（不加成员数/经济支柱行）
 *   ④ 新建客户改底部吸底 button（替代右下角 FAB）
 * 另两条按评审意见：搜索框 ≥8 位客户才出现；列表尾部补"长按删除"口径提示。
 *
 * 为什么值得守：这些都是**纯视觉/文案**改动，改错了不会有任何报错 ——
 * 圆环加回来、吸底条写进 .page（被 transform 破坏 fixed 定位）、日期退回 M/D，全都静默。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// 断言"某类名/字段已不存在"必须先剥注释：本项目习惯在注释里记录"X 已移除（原 Y）"，
// 直接扫原文会被注释命中 —— 第一次写这条测试时就踩到（.ring / .sk-ring / completeness 三处）。
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, '')
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
const readWxml = (p) => stripHtml(read(p))
const readWxss = (p) => stripCss(read(p))

// ---------- 组件加载 harness（与 ocr-flow-click-matrix.test.js 同款）----------
function loadClientCard() {
  let captured = null
  global.Component = function (cfg) { captured = cfg }
  global.wx = { vibrateShort: jest.fn() }
  jest.resetModules()
  require('../miniprogram/components/client-card/index.js')
  return captured
}

const DAY = 864e5
const ago = (ms) => new Date(Date.now() - ms)

describe('客户卡：只留家庭名 + 多久没更新', () => {
  const cfg = loadClientCard()

  test('不再计算/渲染资料完整度圆环', () => {
    expect(cfg.data._completeness).toBeUndefined()
    const wxml = readWxml('components/client-card/index.wxml')
    expect(wxml).not.toMatch(/ring-wrap|conic-gradient/)
    expect(wxml).not.toMatch(/completeness/)
    const wxss = readWxss('components/client-card/index.wxss')
    expect(wxss).not.toMatch(/\.ring-(wrap|hole|text)/)
  })

  test('列表只按家庭名称显示（不渲染成员数 / 经济支柱）', () => {
    const wxml = readWxml('components/client-card/index.wxml')
    expect(wxml).toContain('{{client.name || client.family_name}}')
    expect(wxml).not.toMatch(/member_count|pillar_name/)
  })

  test.each([
    ['刚刚', 10 * 1000, '刚刚更新', false],
    ['分钟', 25 * 6e4, '25 分钟前更新', false],
    ['小时', 5 * 36e5, '5 小时前更新', false],
    ['天（关键回归：旧实现这里返回 M/D）', 3 * DAY, '3 天前更新', false],
    ['29 天仍是"天"', 29 * DAY, '29 天前更新', false],
    ['30 天转月且标记 stale', 40 * DAY, '1 个月前更新', true],
    ['超一年', 400 * DAY, '1 年前更新', true]
  ])('相对时间：%s', (_n, ms, text, stale) => {
    expect(cfg.methods._fmt(ago(ms))).toEqual({ text, stale })
  })

  test('无时间 / 非法时间 → 空串（不渲染"NaN"）', () => {
    for (const bad of [null, undefined, '', 'not-a-date']) {
      expect(cfg.methods._fmt(bad)).toEqual({ text: '', stale: false })
    }
  })

  test('observer 只写时间与名称，不再写完整度', () => {
    const setData = jest.fn()
    cfg.observers.client.call({ setData, _fmt: cfg.methods._fmt }, {
      _id: 'f1', name: '李阳勇', updated_at: ago(3 * DAY), completeness_score: 70
    })
    const patch = setData.mock.calls[0][0]
    expect(patch).toEqual({ _fmtTime: '3 天前更新', _staleTime: false, _name: '李阳勇', _id: 'f1' })
    expect(patch._completeness).toBeUndefined()
  })
})

describe('首页布局与入口', () => {
  const wxml = read('pages/index/index.wxml')

  /** .page 根节点的闭合位置（注释先置空、保留换行；本文件注释含标签字面文本） */
  function pageCloseIndex(src) {
    const clean = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    const start = clean.indexOf('<view class="page page-view')
    expect(start).toBeGreaterThan(-1)
    let depth = 0
    const re = /<view\b|<\/view>/g
    re.lastIndex = start
    let m
    while ((m = re.exec(clean))) {
      depth += m[0] === '<view' ? 1 : -1
      if (depth === 0) return m.index
    }
    throw new Error('.page 未闭合')
  }

  test('吸底「新建客户」按钮在 .page 之外（写进 .page 会被 transform 破坏 fixed 定位）', () => {
    const clean = wxml.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    const bar = clean.indexOf('class="create-bar')
    expect(bar).toBeGreaterThan(-1)
    expect(bar).toBeGreaterThan(pageCloseIndex(wxml))
  })

  test('新建客户入口带文字（消除「＋」的新建/上传歧义），且旧 FAB 已清除', () => {
    expect(wxml).toContain('＋ 新建客户')
    expect(wxml).not.toMatch(/class="fab|fab--show|fab-plus/)
    const wxss = read('pages/index/index.wxss')
    expect(wxss).not.toMatch(/^\.fab\b|^\.fab-/m)
  })

  test('吸底按钮清掉原生 button 的 1px 边框（否则与圆角错位）', () => {
    const wxss = readWxss('pages/index/index.wxss')
    expect(wxss).toContain('.create-bar-btn::after')
    expect(wxss).toMatch(/\.create-bar-btn::after\s*\{\s*border\s*:\s*none/)
  })

  test('搜索栏 ≥8 位客户才出现（1 个客户时搜索是噪音）', () => {
    expect(wxml).toContain('{{families.length >= 8 || keyword}}')
  })

  test('列表尾部有长按删除口径提示（隐式手势此前零说明）', () => {
    expect(wxml).toContain('长按卡片可删除')
    expect(wxml).toContain('共 {{families.length}} 位客户')
  })

  test('骨架屏与真实卡片同构（圆环移除后不得残留占位）', () => {
    expect(wxml).not.toContain('sk-ring')
    expect(readWxss('pages/index/index.wxss')).not.toMatch(/\.sk-ring/)
  })
})
