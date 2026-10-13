/**
 * 骨架成员契约（跨树）— 2026-10-13
 *
 * 事故形态（本轮实测）：建档按"人数"造的占位成员被写成**空名**，而 OCR 写保单时的
 * "认领骨架成员"机制判定的是 `^成员\d+$`（`member-matcher.js`）→ 占位认不出来 →
 * 真人名走"新建成员"分支 → 家里出现「3 个空名 + 2 个真人」= 5 条成员（成员主数据污染）。
 *
 * 本套件钉三件事：① 命名与判定规则 ② 前后端同源（前端不得自写第二份正则）
 * ③ 建档占位必须用 `skeletonName(i)` 命名（源码接线）
 */
const fs = require('fs')
const path = require('path')
const { SKELETON_RE, isSkeletonName, skeletonName } = require('../cloudfunctions/_shared/member-skeleton')
const { SKELETON_RE: BACKEND_RE } = require('../cloudfunctions/_shared/member-matcher')
const FRONTEND = require('../miniprogram/utils/member-skeleton')

describe('skeletonName / isSkeletonName', () => {
  test('命名：i 从 0 起 → 成员1、成员2', () => {
    expect(skeletonName(0)).toBe('成员1')
    expect(skeletonName(1)).toBe('成员2')
    expect(skeletonName(9)).toBe('成员10')
  })

  test('判定：仅「成员+数字」为骨架', () => {
    expect(isSkeletonName('成员1')).toBe(true)
    expect(isSkeletonName('成员99')).toBe(true)
    expect(isSkeletonName('成员')).toBe(false)
    expect(isSkeletonName('成员A')).toBe(false)
    expect(isSkeletonName('张三')).toBe(false)
    expect(isSkeletonName('')).toBe(false)
    expect(isSkeletonName(undefined)).toBe(false)
    expect(isSkeletonName(null)).toBe(false)
  })
})

describe('跨树同源（防第二份正则）', () => {
  test('契约副本与主源同一规则（前端 miniprogram/utils/member-skeleton.js）', () => {
    expect(FRONTEND.SKELETON_RE.source).toBe(SKELETON_RE.source)
    expect(FRONTEND.skeletonName(2)).toBe('成员3')
  })

  test('member-matcher 从契约取用、不再自定义骨架正则', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', '_shared', 'member-matcher.js'), 'utf8')
    expect(src).toContain("require('./member-skeleton')")
    expect(src).not.toMatch(/const\s+SKELETON_RE\s*=\s*\/\^成员/)
    // 导出保持兼容（既有测试与调用方直接取 SKELETON_RE）
    expect(BACKEND_RE).toBe(SKELETON_RE)
  })

  test('建档按人数造占位时使用 skeletonName（否则后端认领失效）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'clients', 'index.js'), 'utf8')
    expect(src).toContain('skeletonName(i)')
    expect(src).not.toMatch(/members\.push\(\{\}\)/) // 空名占位：认领机制认不出
  })

  test('整理报告用契约判定占位（不自写 name === \'\'）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'checkup', 'organize.js'), 'utf8')
    expect(src).toContain('isSkeletonName(m.name)')
  })
})
