/**
 * 现价取行：前后端一致性（2026-09-27，dsh 审计 ①）
 *
 * 现象：同一张保单、同一时刻，**AI 上下文**（`report-coverage` 的「现价 / 已缴年 / 累计保费」列）
 * 与**客户手机**（报告页附录保单卡 `chapter-builder._currentCashValue`）给出不同的现金价值。
 *
 * 两处各自用年差近似"保单年度"，且相差 1：
 *   - 后端 `_paidYears`：`当前年 − 生效年`          （未满周年也算整年 → 偏小 1）
 *   - 前端 `_currentCashValue`：`当前年 − 生效年 + 1`（周年日未到也算整年 → 偏大 1）
 * 真实数据实测（`多倍保障青少年重大疾病保险(A1款)`，生效 2020-05-20，2026-09-27）：
 *   后端 y=6 → 现价 6240；报告页 y=7 → 现价 7960。
 *
 * 真实口径：现价表的 `y` 就是**保单年度**（`ocrService/prompts.js`："保单年度自 1 起连续递增"），
 * 而保单年度按**生效日周年**计算 → 两个年差公式都不看月日，**两边都不对**（前端只是恰好对了半年）。
 * 修复：契约 `cash-value-math.policyYearAt(eff, now)` 成为唯一口径，两处消费方都改走它。
 *
 * 本文件是**跨端护栏**：不逐个断言实现细节，而是断言"两边对同一输入必须给出同一个数"
 * —— 任何一侧再自行发明年差公式（少 / 多算 1 年）都会在此变红。
 */
const { _paidYears } = require('../cloudfunctions/reportAI/report-coverage')
const { _currentCashValue } = require('../miniprogram/utils/report/chapter-builder')
const { cashAtYear, coverScale, policyYearAt } = require('../cloudfunctions/_shared/cash-value-math')
const { yuanToWan } = require('../cloudfunctions/_shared/amount')

// 真实表值抽样（y=保单年度 → v=每万元保额现价）：y6=6240、y7=7960 取自线上现价表，
// 其余按真实表的单调递增形态补齐（本测试只需"不同年度取到不同行"这一性质）
const ROWS = [
  { y: 1, v: 0 }, { y: 2, v: 0 }, { y: 3, v: 1180 }, { y: 4, v: 3020 },
  { y: 5, v: 4620 }, { y: 6, v: 6240 }, { y: 7, v: 7960 }, { y: 8, v: 9780 }
]
const POL = { id: 'pol_1', effective_date: '2020-05-20', sum_assured: 200000, annual_premium: 3000 }
const CVS = [{ policy_id: 'pol_1', cash_values: ROWS }]

/** 后端侧：按 `_paidYears` 取行后算出的现价（万元）—— 与 report-coverage「现价」列同算法 */
function backendWan(p, now) {
  const years = _paidYears(p, now)
  if (years === null) return null
  const row = cashAtYear(ROWS, years)
  if (!row) return null
  return yuanToWan(row.v * coverScale(p.sum_assured))
}

describe('现价取行：前后端必须一致', () => {
  test('真实数据：生效 2020-05-20，2026-09-27 → 第 7 保单年度（y7 / 7960）', () => {
    const now = new Date(2026, 8, 27)
    expect(policyYearAt(POL.effective_date, now)).toBe(7)
    expect(_paidYears(POL, now)).toBe(7)
    expect(_currentCashValue(POL, CVS, now)).toBe(backendWan(POL, now))
    expect(_currentCashValue(POL, CVS, now)).toBe(yuanToWan(7960 * coverScale(POL.sum_assured)))
  })

  // 关键回归：周年日**未到**时 —— 旧的 `当前年−生效年+1` 会取 y7（多算 1 年），
  // 旧的后端会取 y5（少算 1 年），两个都错；现在两边都应落在 y6
  test('周年日前一天（2026-05-19）→ 两边都取 y6，谁都不许自行加/减 1 年', () => {
    const now = new Date(2026, 4, 19)
    expect(_paidYears(POL, now)).toBe(6)
    expect(_currentCashValue(POL, CVS, now)).toBe(yuanToWan(6240 * coverScale(POL.sum_assured)))
    expect(_currentCashValue(POL, CVS, now)).toBe(backendWan(POL, now))
  })

  test('周年日当天（2026-05-20）→ 进第 7 年度，两边同步', () => {
    const now = new Date(2026, 4, 20)
    expect(_paidYears(POL, now)).toBe(7)
    expect(_currentCashValue(POL, CVS, now)).toBe(backendWan(POL, now))
  })

  test('跨整年逐月扫：任意时刻两边都相等（防单点巧合）', () => {
    for (let m = 0; m < 12; m++) {
      const now = new Date(2026, m, 27)
      expect(_currentCashValue(POL, CVS, now)).toBe(backendWan(POL, now))
    }
    for (let m = 0; m < 12; m++) {
      const now = new Date(2027, m, 1)
      expect(_currentCashValue(POL, CVS, now)).toBe(backendWan(POL, now))
    }
  })

  test('未生效 / 日期判不出 → 两边都不猜（null）', () => {
    const future = { id: 'pol_2', effective_date: '2026-12-01', sum_assured: 200000 }
    expect(_paidYears(future, new Date(2026, 8, 27))).toBeNull()
    expect(_currentCashValue(future, [{ policy_id: 'pol_2', cash_values: ROWS }], new Date(2026, 8, 27))).toBeNull()

    // OCR 脏值（库里真实存在这类值，见 writePoliciesBatch 夹具）→ 不得产出 NaN
    const dirty = { id: 'pol_3', effective_date: '2020年5月', sum_assured: 200000 }
    expect(_paidYears(dirty, new Date(2026, 8, 27))).toBeNull()
    expect(_currentCashValue(dirty, [{ policy_id: 'pol_3', cash_values: ROWS }], new Date(2026, 8, 27))).toBeNull()
  })

  test('无现价表 / 保单未关联现价表 → 前端不显示（后端走 '-' 分支）', () => {
    expect(_currentCashValue(POL, [], new Date(2026, 8, 27))).toBeNull()
    expect(_currentCashValue(POL, [{ policy_id: 'other', cash_values: ROWS }], new Date(2026, 8, 27))).toBeNull()
  })
})
