/**
 * cash-value-math 契约测试（2026-09-15 架构审查候选 2）
 *
 * 唯一事实源：原三处逐字同构的实现（report-coverage 现价/回本列、reportPdf 保障节点、
 * 前端 timeline-builder）收敛到本模块。契约一旦破坏，三端同时错。
 */
const { coverScale, cashAtYear, breakEvenYear, policyYearAt } = require('../cloudfunctions/_shared/cash-value-math')

describe('cash-value-math', () => {
  test('coverScale：保额元 → 万，不足 1 万按 1 计', () => {
    expect(coverScale(500000)).toBe(50)
    expect(coverScale(1000000)).toBe(100)
    expect(coverScale(8000)).toBe(1)
    expect(coverScale(0)).toBe(1)
    expect(coverScale()).toBe(1)
  })

  test('cashAtYear：取 <= paidYears 的最近一行；无合格行 → null（不再回落首行）', () => {
    const rows = [{ y: 1, v: 100 }, { y: 2, v: 300 }, { y: 3, v: 800 }]
    expect(cashAtYear(rows, 2).y).toBe(2)
    expect(cashAtYear(rows, 5).y).toBe(3)
    expect(cashAtYear(rows, 1).y).toBe(1)
    expect(cashAtYear([], 1)).toBeNull()
    expect(cashAtYear(null, 1)).toBeNull()
    // 2026-09-27：原断言 paidYears=0 → 首行（y1）。该回落是为兜住旧后端"年差=0"而存在，
    // 现已由 policyYearAt（恒 >= 1）消除；保留回落会把**未来年度**的值当当前现价：
    // 前端 tests/report-builder.test.js「表超出当前年度 → 现金价值不展示」钉住这一点。
    expect(cashAtYear(rows, 0)).toBeNull()
    expect(cashAtYear([{ y: 5, v: 900 }], 3)).toBeNull() // 表起始年度晚于当前年度（数据异常）→ 无现价
  })

  test('breakEvenYear：按保额比例换算表值，且比的是累计已缴保费', () => {
    // 保额 50 万 → scale=50；年缴 8000 → 累计保费 = 8000×y
    // y1: 100×50=5000  < 8000
    // y2: 300×50=15000 < 16000
    // y3: 600×50=30000 >= 24000 → 第 3 年
    const rows = [{ y: 1, v: 100 }, { y: 2, v: 300 }, { y: 3, v: 600 }]
    expect(breakEvenYear(rows, 8000, 500000)).toBe(3)
  })

  test('breakEvenYear：永不回本 / 缺参数返回 null', () => {
    expect(breakEvenYear([{ y: 1, v: 1 }], 12000, 500000)).toBeNull()
    expect(breakEvenYear([], 12000, 500000)).toBeNull()
    expect(breakEvenYear([{ y: 1, v: 999 }], 0, 500000)).toBeNull()
    expect(breakEvenYear(null, 12000, 500000)).toBeNull()
    expect(breakEvenYear([{ y: 1, v: 999 }], undefined, 500000)).toBeNull()
  })

  // =========================================================================
  // 2026-09-27 新增：保单年度（dsh 审计 ①「现价取行前后端相差 1 年」的根因）
  //   现价表 y = 保单年度；年度按**生效日周年**判定 —— 原先前后端各写一份年差近似、相差 1。
  // =========================================================================
  describe('policyYearAt — 保单年度（周年制）', () => {
    const EFF = '2020-05-20'

    test('周年日已过 → 满年数+1（真实数据：2020-05-20 生效，2026-09-27 为第 7 个保单年度）', () => {
      expect(policyYearAt(EFF, new Date(2026, 8, 27))).toBe(7)
    })

    test('周年日未到 → 不进下一年度（旧的「当前年−生效年+1」在此会多算 1 年）', () => {
      expect(policyYearAt(EFF, new Date(2026, 4, 19))).toBe(6) // 2026-05-19：第 6 年度内
      expect(policyYearAt(EFF, new Date(2026, 4, 20))).toBe(7) // 2026-05-20：满 6 周年，进第 7 年度
    })

    test('同年生效（未满 1 周年）→ 1', () => {
      expect(policyYearAt('2026-03-01', new Date(2026, 8, 27))).toBe(1)
    })

    test('真实数据对照：2024-04-23 生效 → 2026-09-27 为第 3 个保单年度', () => {
      expect(policyYearAt('2024-04-23', new Date(2026, 8, 27))).toBe(3)
    })

    test('闰日生效：周年日钳到当月最后一天（与 parse-expiry 对应日规则一致）', () => {
      expect(policyYearAt('2024-02-29', new Date(2025, 1, 27))).toBe(1)
      expect(policyYearAt('2024-02-29', new Date(2025, 1, 28))).toBe(2)
    })

    test('未生效 / 日期判不出 → null（不猜；OCR 脏值「2020年5月」也在此列）', () => {
      expect(policyYearAt('2026-12-01', new Date(2026, 8, 27))).toBeNull()
      expect(policyYearAt('2020年5月')).toBeNull()
      expect(policyYearAt('')).toBeNull()
      expect(policyYearAt(null)).toBeNull()
      expect(policyYearAt(undefined)).toBeNull()
    })
  })
})
