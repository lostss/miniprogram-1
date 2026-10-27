/**
 * PDF 与页面"同源"守卫（2026-10-22）
 *
 * 背景：本项目踩过最贵的坑之一就是"同一份报告两处实现" —— PDF 曾把 coverage_term=105
 * 当成 ~2130 年保障期满，而页面没有这个节点（同一份报告两个说法）。
 *
 * 用户方案第六部分要求「PDF 是移动版的展开版：不生成新结论，只做格式转换」。
 * 这条断言就是它的机械版本：**PDF 不得自己算口径**，必须复用跨树契约。
 *
 * 注意：这里只守卫"数据来源与命名",不守卫版面（行转列的版式重排尚未做，
 * 需要真机导出验证，单独立项）。
 */
const fs = require('fs')
const path = require('path')

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
const PDF = read('cloudfunctions/reportPdf/index.js')

describe('PDF 与页面同源', () => {
  test('金额/覆盖口径复用 coverage-summary，不在 PDF 里自行 reduce', () => {
    expect(PDF).toMatch(/coverage-summary|summarizeCoverage/)
    // 直接对 policies 做 reduce 求和 = 第四份实现（页面/汇总卡/AI 已有三份契约消费方）
    expect(PDF).not.toMatch(/policies\.reduce\(/)
  })

  test('保费趋势/台阶复用 premium-trend（与页面年度柱同一份数据）', () => {
    expect(PDF).toContain('buildPremiumTrend')
  })

  test('节名与页面章节对齐（缴费与现金流）', () => {
    expect(PDF).toContain('缴费与现金流')
    expect(PDF).not.toContain('缴费月历（每年固定缴费月）')
  })

  test('PDF 与页面同步：成员卡片 / 保费分布 7a · 7b 都在，AI 节已移除', () => {
    expect(PDF).toContain("_sec('成员卡片')")
    expect(PDF).toContain("_sec('保费分布')")
    expect(PDF).toContain("'7a 按成员与险种'")
    expect(PDF).toContain("'7b 按公司'")
    // 纸面只列事实：AI 小节不得回归（注释里可以提"已删除"，所以断言 `_sec(...)` 调用形态）
    expect(PDF).not.toContain("_sec('深度分析（AI 解读）')")
    expect(PDF).not.toContain("'配置建议'")
  })

  test('成员卡片按 canonCat 归行（与页面同一份险种归一，防"增额寿在纸上算成另一种险"）', () => {
    expect(PDF).toContain("require('./_shared/thresholds')")
    expect(PDF).toContain('_memberCardData(members, act, policies)')
  })

  test('A1–A6 进 PDF：与页面同一份契约（_shared/anomaly-list），且空则整段不出现', () => {
    expect(PDF).toContain("require('./_shared/anomaly-list')")
    expect(PDF).toContain('buildAnomalies({ policies')
    // 段名进目录（否则页内小节与目录对不上）
    expect(PDF).toContain('异常与待核验')
    // 空数组不印空标题：必须包在 if (anomalies.length) 里
    expect(PDF).toMatch(/if \(anomalies\.length\) \{[\s\S]{0,200}_sec\('异常与待核验'\)/)
  })

  test('成员卡片两列并排（2026-10-27 起「家庭成员」节已删，避免同一批人两份清单）', () => {
    // 成员卡片用 twoColumnRows 排两列；列宽走 layout 计算，不写魔法数
    expect(PDF).toContain('twoColumnRows(cards)')
    expect(PDF).toContain('columnWidth(W, 2')
    // 旧「家庭成员」节不得回归（姓名/年龄已在成员卡片标题；职业/健康不属于保单事实）
    expect(PDF).not.toContain("_sec('家庭成员')")
    expect(PDF).not.toContain('const memberLine =')
  })

  test('PDF 不产出新的诊断/建议文案（方案：只做格式转换）', () => {
    // 规则层的建议已删除；PDF 侧同样不得出现"建议补充/建议优先"这类句子
    expect(PDF).not.toMatch(/建议(优先)?为|建议补充/)
  })
})
