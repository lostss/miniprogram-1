/**
 * 自然月键（月度配额判据）的单一事实源 — 2026-09-26 复审（dsh 会话）纠偏
 *
 * 背景：dsh 本轮引入「月度配额按自然月重置」（这是真 P1 修复：原实现全仓无重置路径，
 * trial 用户用满额度后**永久锁死**，只能人工改库）。但它在 guard.js 与 ai-accounting.js
 * **各定义了一份** `_monthKey`，两处注释都只写「改一处必须同改」✗ ——
 * 这是典型的"手工同步的重复"，失效方式**静默**：
 *   一处改了 → 月键与 quota_period 不再同口径 → 配额要么永久锁死、要么永久放行。
 * 现收敛到**写入方** `ai-accounting`（它同时写 `quota_period`），guard 从这里取用。
 *
 * 本文件同时钉住：① 月键行为（格式与跨月边界）② guard 不得再自定义一份（源码扫描）
 */
const { _monthKey } = require('../cloudfunctions/_shared/ai-accounting')

describe('月键（quota_period 判据）', () => {
  // 2026-09-28 复审（dsh 审计项③）：月键改按**北京时间（UTC+8）**，不再随运行时本地时区
  // （云函数运行时为 UTC → 原实现让北京时间每月 1 日 00:00–08:00 仍判上月、配额不重置）。
  // 故以下用例一律用**显式 UTC 时刻**构造，机器时区无关。
  test('格式 YYYY-MM，个位月补零', () => {
    expect(_monthKey(new Date(Date.UTC(2026, 0, 15)))).toBe('2026-01')
    expect(_monthKey(new Date(Date.UTC(2026, 8, 26)))).toBe('2026-09')
    expect(_monthKey(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12')
  })

  test('跨月边界按北京时间：UTC 15:59:59 仍是当月，16:00:00 进入次月', () => {
    // 2026-09-30 23:59:59（北京） = 2026-09-30T15:59:59Z
    expect(_monthKey(new Date(Date.UTC(2026, 8, 30, 15, 59, 59)))).toBe('2026-09')
    // 2026-10-01 00:00:00（北京） = 2026-09-30T16:00:00Z —— 这 8 小时窗口正是本次修复的目标
    expect(_monthKey(new Date(Date.UTC(2026, 8, 30, 16, 0, 0)))).toBe('2026-10')
    expect(_monthKey(new Date(Date.UTC(2026, 8, 30, 16, 0, 1)))).toBe('2026-10')
    // 2025-12-31 23:59（北京）
    expect(_monthKey(new Date(Date.UTC(2025, 11, 31, 15, 59)))).toBe('2025-12')
  })

  test('不传参时取当前月（北京时间）', () => {
    const expectKey = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7)
    expect(_monthKey()).toBe(expectKey)
  })

  test('guard 从 ai-accounting 取用、不再自定义月键（改回即红）', () => {
    const fs2 = require('fs')
    const path2 = require('path')
    const src = fs2.readFileSync(path2.join(__dirname, '../cloudfunctions/_shared/guard.js'), 'utf8')
    expect(src).toContain("require('./ai-accounting')")
    expect(src).not.toMatch(/function\s+_monthKey\s*\(/)
  })
})
