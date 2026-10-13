/**
 * 报告免责声明守卫（2026-10-13）
 *
 * 动因：合规声明是红线，但它在 UI 上"少一行没人发现"，且极易在重构里被降级成
 * "跟着 AI 输出走"——那样 AI 未生成/生成失败时报告就**没有任何声明**。
 * 本守卫钉住三条不变式：
 *   ① 页尾声明的唯一来源是**静态常量**，不取 AI 输出的字段；
 *   ② 页头轻提示（合规前置）与页尾完整声明**同时存在**；
 *   ③ 页头轻提示**不挂 wx:if** —— 合规声明不分 owner/客户版，必须常驻。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram', 'pages', 'report')
const js = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
const wxml = fs.readFileSync(path.join(ROOT, 'index.wxml'), 'utf8')

describe('报告免责声明契约', () => {
  test('页尾声明来自静态兜底常量（不依赖 AI 输出，AI 失败时依然成立）', () => {
    expect(js).toMatch(/const\s+DISCLAIMER_FALLBACK\s*=/)
    expect(js).toMatch(/disclaimer:\s*DISCLAIMER_FALLBACK/)
    // AI 生成的 last_disclaimer 已弃用：不得作为展示来源回归
    expect(js).not.toMatch(/disclaimer:\s*(rep|report|r)\??\.?last_disclaimer/)
  })

  test('页头轻提示与页尾完整声明同时存在（前置 + 完整）', () => {
    expect(wxml).toContain('title-ai-note')
    expect(wxml).toContain('report-disclaimer')
  })

  test('页头轻提示不挂 wx:if（合规声明不分 owner/客户版，必须常驻）', () => {
    const line = wxml.split(/\r?\n/).find(l => l.includes('title-ai-note'))
    expect(line).toBeTruthy()
    expect(line).not.toContain('wx:if')
  })
})
