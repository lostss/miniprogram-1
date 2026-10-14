/**
 * 保费现金流趋势（premium-trend 跨树契约）单元测试
 *
 * 服务用户稿子两处：① 关键节点"下一期缴费（第 N 期）" ② 年度趋势"缴费期满后释放的现金流"。
 * 重点守住三类**首版真犯过 / 极易犯**的错：
 *   - 趸交保单被报成"下一期缴费"（趸交是一次性支出，之后没有"期"）
 *   - 已缴满的历史保单仍报未来缴费
 *   - 最后一张保单缴满的**次年**台阶被漏掉（"保费降到 0"这个最有价值的点）
 */
const { buildPremiumTrend } = require('../miniprogram/utils/premium-trend')

const NOW = new Date('2026-10-14T00:00:00')
const MEMBERS = [{ name: '张三', age: 46 }, { name: '李四', age: 44 }]

function pol(over) {
  return Object.assign({ status: 'active', insured_name: '张三', product_name: '测试保单', annual_premium: 10000 }, over || {})
}

describe('premium-trend — 下一期缴费', function () {
  test('缴费月 = 生效月，跨年后取下一期；含"第几期"', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '十年缴', effective_date: '2018-03-01', payment_period: '10年', annual_premium: 6000 })
    ], MEMBERS, { now: NOW })
    expect(r.upcoming).toHaveLength(1)
    expect(r.upcoming[0].y).toBe(2027)
    expect(r.upcoming[0].m).toBe(3)
    expect(r.upcoming[0].amountW).toBe(0.6)
    expect(r.upcoming[0].list[0].periodNo).toBe(10) // 2018 起第 10 期
  })

  test('趸交保单**不得**出现在下一期缴费里（首版真犯过这个错）', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '趸交年金', effective_date: '2022-01-10', premium_term: 1, annual_premium: 100000 })
    ], MEMBERS, { now: NOW })
    expect(r.upcoming).toEqual([])
    expect(r.notes.join('')).toContain('趸交')
  })

  test('一年期短险**必须**进下一期缴费（线上最常见形态；首版因"无缴费期"被整类漏掉）', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '百万医疗', insurance_category: '医疗险', insurance_period: '1年', coverage_term: 1, effective_date: '2026-01-10', annual_premium: 900 })
    ], MEMBERS, { now: NOW })
    expect(r.upcoming).toHaveLength(1)
    expect(r.upcoming[0].m).toBe(1) // 生效月 = 缴费月
    expect(r.notes.join('')).toContain('一年期')
  })

  test('一年期短险**不得**产生"缴费期满"台阶（它是每年续保，不是期满；首版渲染成假的到期台阶）', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '百万医疗', insurance_period: '1年', coverage_term: 1, effective_date: '2026-01-10', annual_premium: 900 }),
      pol({ product_name: '终身寿A', effective_date: '2015-06-01', payment_period: '20年', annual_premium: 8000 })
    ], MEMBERS, { now: NOW })
    // 台阶只反映长期险：2036 年终身寿A 缴满 → 归零；一年期的缺席不构成台阶
    expect(r.drops.map(d => d.y)).toEqual([2036])
    expect(r.drops[0].products.join('')).not.toContain('百万医疗')
    // 当年总保费仍含一年期（与同章"年总保费"对得上）
    expect(r.currentW).toBe(0.89)
    // 曲线本身是长期险口径：2026 年不含那一期医疗险
    expect(r.years[0].w).toBe(0.8)
  })

  test('一年期短险的曲线**只计当前年度**（不替客户假设"会一直续保"）', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '百万医疗', insurance_period: '1年', coverage_term: 1, effective_date: '2026-01-10', annual_premium: 900 })
    ], MEMBERS, { now: NOW })
    expect(r.currentW).toBe(0.09)
    // 次年及以后不再出现（续保是投保人每年的决定，不是合同承诺）
    expect(r.years.filter(x => x.y > 2026 && x.w > 0)).toEqual([])
  })

  test('已缴满的历史保单不报未来缴费', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '早已缴满', effective_date: '2005-05-01', payment_period: '10年', annual_premium: 5000 })
    ], MEMBERS, { now: NOW })
    expect(r.upcoming).toEqual([])
    expect(r.currentW).toBe(0)
  })

  test('下一期超出缴费期（今年最后一期）→ 不报', function () {
    // 2016-11 起 10 年缴 → 2025-11 已缴满（payEndY=2026）……取 2026-11 恰在期内仍应报
    const r = buildPremiumTrend([
      pol({ product_name: '刚好缴满', effective_date: '2016-11-01', payment_period: '10年', annual_premium: 5000 })
    ], MEMBERS, { now: NOW })
    expect(r.upcoming[0].y).toBe(2026)
    expect(r.upcoming[0].m).toBe(11)
  })
})

describe('premium-trend — 年度曲线与下降台阶', function () {
  test('曲线到"全部缴满的次年"为止，且末年为 0（释放全部现金流）', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '十年缴', effective_date: '2018-03-01', payment_period: '10年', annual_premium: 6000 }),
      pol({ product_name: '二十年缴', effective_date: '2015-06-01', payment_period: '20年', annual_premium: 8000 })
    ], MEMBERS, { now: NOW })
    expect(r.currentW).toBe(1.4)
    expect(r.years[r.years.length - 1].y).toBe(2036) // 二十年缴 2035 缴满 → 次年归零
    expect(r.years[r.years.length - 1].w).toBe(0)
  })

  test('两级台阶都出现：中间一次下降 + 最终归零', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '十年缴', effective_date: '2018-03-01', payment_period: '10年', annual_premium: 6000 }),
      pol({ product_name: '二十年缴', effective_date: '2015-06-01', payment_period: '20年', annual_premium: 8000 })
    ], MEMBERS, { now: NOW })
    expect(r.drops.map(d => d.y)).toEqual([2029, 2036])
    expect(r.drops[0].reducedW).toBe(0.6)
    expect(r.drops[1].toW).toBe(0)
    expect(r.drops[1].reducedW).toBe(0.8)
    expect(r.drops[1].products.join('')).toContain('二十年缴')
  })

  test('推演年数有上限（不因超长缴费期把 payload 撑爆）', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '超长缴', effective_date: '2020-01-01', payment_period: '60年', annual_premium: 1000 })
    ], MEMBERS, { now: NOW })
    expect(r.years.length).toBeLessThanOrEqual(31) // MAX_YEARS 30 + 末端
  })
})

describe('premium-trend — 缺失即标注（红线 3，不猜）', function () {
  test('缺生效日期 / 缺缴费期 → 不入曲线，只在 notes 说明', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '无生效日', effective_date: '', payment_period: '' }),
      pol({ product_name: '无缴费期', effective_date: '2020-01-01', payment_period: '', premium_term: null })
    ], MEMBERS, { now: NOW })
    expect(r.years).toEqual([])
    expect(r.currentW).toBe(0)
    expect(r.notes.join('')).toContain('缺少生效日期')
    expect(r.notes.join('')).toContain('未填写缴费期')
  })

  test('非 active 保单不参与', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '已失效', status: 'expired', effective_date: '2020-01-01', payment_period: '20年' })
    ], MEMBERS, { now: NOW })
    expect(r.years).toEqual([])
  })

  test('未填年缴保费的保单不入曲线并计入 notes', function () {
    const r = buildPremiumTrend([
      pol({ product_name: '无保费', effective_date: '2020-01-01', payment_period: '20年', annual_premium: 0 })
    ], MEMBERS, { now: NOW })
    expect(r.notes.join('')).toContain('未填写年缴保费')
  })

  test('空输入 → 结构完整不抛错', function () {
    const r = buildPremiumTrend([], [], { now: NOW })
    expect(r.upcoming).toEqual([])
    expect(r.drops).toEqual([])
    expect(r.years).toEqual([])
  })
})

describe('保费现金流接线（防"契约建好但没接"）', function () {
  const fs = require('fs')
  const path = require('path')
  const SRC_CH = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'report', 'chapter-builder.js'), 'utf8')
  const SRC_PDF = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'reportPdf', 'index.js'), 'utf8')
  const SYNC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sync-shared.js'), 'utf8')

  test('页面缴费月历章确实渲染了下一期缴费与台阶', function () {
    expect(SRC_CH).toContain('buildPremiumTrend')
    expect(SRC_CH).toContain('下一期缴费：')
    expect(SRC_CH).toMatch(/trendLines/)
  })

  test('PDF 缴费月历节走同一契约（不另写算法）', function () {
    expect(SRC_PDF).toContain("require('./_shared/premium-trend')")
    expect(SRC_PDF).toMatch(/buildPremiumTrend\(/)
  })

  // ⚠️ 这条是本文件里最该存在的一条：**作用域**问题文本断言抓不到。
  // 首版把 PDF 里的调用写成 `buildPremiumTrend(activePolicies, …)` —— 而 `activePolicies` 是
  // **另一个函数**（调用层）里的变量，buildPdf 作用域内只有 `act` → 运行必 ReferenceError。
  // 当时的断言 `toContain('buildPremiumTrend(activePolicies')` 反而把 bug 锁住了
  // （与 09-28 记入质量错误库的反模式同型）。现在改为：取出实参标识符，
  // 断言它在 **buildPdf 函数体内、调用点之前** 已被声明 —— 这样 undefined 标识符会红。
  test('PDF 传入的实参必须是 buildPdf 作用域内已声明的变量（防 ReferenceError）', function () {
    const callMatch = SRC_PDF.match(/buildPremiumTrend\((\w+)/)
    expect(callMatch).toBeTruthy()
    const arg = callMatch[1]
    const fnStart = SRC_PDF.indexOf('function buildPdf(ctx)')
    const callIdx = SRC_PDF.indexOf('buildPremiumTrend(')
    expect(fnStart).toBeGreaterThan(-1)
    expect(callIdx).toBeGreaterThan(fnStart)
    const inScopeBeforeCall = SRC_PDF.slice(fnStart, callIdx)
    expect(new RegExp('(const|let|var)\\s+' + arg + '\\s*=').test(inScopeBeforeCall)).toBe(true)
  })

  test('两个契约文件都已登记进 CONTRACT_FILES（否则前端副本会静默漂移）', function () {
    expect(SYNC).toContain("'policy-terms.js'")
    expect(SYNC).toContain("'premium-trend.js'")
  })

  test('前端副本与 _shared 权威源逐字一致（sync 未跑时的兜底断言）', function () {
    const src = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', '_shared', 'premium-trend.js'), 'utf8')
    const copy = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'premium-trend.js'), 'utf8')
    expect(copy).toBe(src)
  })
})
