/**
 * 保障期间甘特图（gantt-builder）单元测试
 *
 * 覆盖三类：
 *  ① 时间条几何（起止年 → 百分比位置/宽度，终身条画到右端、极短条有最小可见宽度）
 *  ② 标注语义（终身 / 一年期续保 / 缺字段的计数与提示 —— 红线 3「不确定就标出来」）
 *  ③ **不做无字段判定**的守卫：block 只暴露白名单字段，不得出现空白期/重叠/断档之类的结论字段
 *     （v2.0 评审必改②：缺 `reimbursement_type` 字段 → 重叠判定只能靠猜 → 误报）
 */
const { buildGantt } = require('../miniprogram/utils/report/gantt-builder')

const THIS_YEAR = new Date().getFullYear()

function pol(over) {
  return Object.assign({
    product_name: '测试重疾',
    insurance_category: '重疾险',
    insured_name: '张三',
    effective_date: '2020-01-01',
    insurance_period: '终身',
    sum_assured: 500000
  }, over || {})
}

describe('gantt-builder — 时间条几何', function () {
  test('定期险：按起止年算位置与宽度（20 年期，2020 起）', function () {
    const g = buildGantt([pol({ insurance_period: '20年', effective_date: '2020-01-01' })], [{ name: '张三' }])
    expect(g.rows).toHaveLength(1)
    const r = g.rows[0]
    expect(r.startY).toBe(2020)
    expect(r.endY).toBe(2040)
    expect(r.lifetime).toBe(false)
    // 轴范围从最早生效年开始；宽度比例 = 20 / span
    expect(r.startPct).toBe(0)
    expect(r.widthPct).toBeGreaterThan(0)
    expect(r.startPct + r.widthPct).toBeLessThanOrEqual(100)
  })

  test('终身险：endY 为 null、条画到右端、不把轴拉到 2130 年', function () {
    const g = buildGantt([pol({ coverage_term: 105, insurance_period: '' })], [{ name: '张三' }])
    const r = g.rows[0]
    expect(r.lifetime).toBe(true)
    expect(r.endY).toBeNull()
    expect(r.startPct + r.widthPct).toBeCloseTo(100, 5)
    // 关键：不给终身险编造"到期年"→ 轴右端不超过"当前年 + 1"以外的历史区间
    expect(g.endYear).toBeLessThanOrEqual(THIS_YEAR + 1)
    expect(g.notes.join('')).toContain('终身')
  })

  test('极短保障期仍有最小可视宽度（一年期不能被压成看不见的线）', function () {
    const g = buildGantt([
      pol({ insurance_period: '20年', effective_date: '2000-01-01' }),
      pol({ insurance_period: '1年', effective_date: '2026-01-01', coverage_term: 1, insurance_category: '医疗险' })
    ], [{ name: '张三' }])
    const short = g.rows.find(r => r.oneYear)
    expect(short).toBeTruthy()
    expect(short.widthPct).toBeGreaterThanOrEqual(3)
  })

  test('刻度：首尾必在轴上且 pct 递增（0 → 100）', function () {
    const g = buildGantt([pol({ insurance_period: '20年' })], [{ name: '张三' }])
    expect(g.ticks[0].y).toBe(g.startYear)
    expect(g.ticks[0].pct).toBe(0)
    expect(g.ticks[g.ticks.length - 1].pct).toBe(100)
    for (let i = 1; i < g.ticks.length; i++) expect(g.ticks[i].y).toBeGreaterThan(g.ticks[i - 1].y)
  })

  test('纵轴按成员档案顺序排序（同一个人的保单相邻）', function () {
    const g = buildGantt([
      pol({ insured_name: '李四', product_name: '李四的保单' }),
      pol({ insured_name: '张三', product_name: '张三的保单' })
    ], [{ name: '张三' }, { name: '李四' }])
    expect(g.rows.map(r => r.name)).toEqual(['张三', '李四'])
  })
})

describe('gantt-builder — 今天竖线 / 缴费期 / 到期年龄（2026-10-14 稿子）', function () {
  test('nowPct 落在轴上：当前年位置（终身险不把轴拉长，所以 today 总在区间内）', function () {
    const g = buildGantt([pol({ insurance_period: '20年', effective_date: '2000-01-01' })], [{ name: '张三' }])
    expect(g.nowYear).toBe(new Date().getFullYear())
    expect(g.nowPct).toBeGreaterThan(0)
    expect(g.nowPct).toBeLessThanOrEqual(100)
  })

  test('保单尚未生效（未来生效日）→ nowPct 为 null，不画"今天"线（画在 0% 会被读成已生效）', function () {
    const future = (new Date().getFullYear() + 2) + '-01-01'
    const g = buildGantt([pol({ insurance_period: '20年', effective_date: future })], [{ name: '张三' }])
    expect(g.nowPct).toBeNull()
  })

  test('缴费期：payRatio 是**占本条宽度**的百分比（10 年缴 / 20 年保障 ≈ 50%）', function () {
    const g = buildGantt([pol({ insurance_period: '20年', effective_date: '2020-01-01', payment_period: '10年' })], [{ name: '张三' }])
    const r = g.rows[0]
    expect(r.payEndY).toBe(2030)
    expect(r.payRatio).toBeCloseTo(50, 0)
  })

  test('无缴费期信息 → payRatio 为 null（不猜"缴到多久"，红线 3）', function () {
    const g = buildGantt([pol({ insurance_period: '20年', effective_date: '2020-01-01', payment_period: '', premium_term: null })], [{ name: '张三' }])
    expect(g.rows[0].payRatio).toBeNull()
    expect(g.rows[0].payEndY).toBeNull()
  })

  test('趸交 → singlePay=true 且不画缴费段（premium_term=1）', function () {
    const g = buildGantt([pol({ insurance_period: '终身', coverage_term: 105, premium_term: 1 })], [{ name: '张三' }])
    const r = g.rows[0]
    expect(r.singlePay).toBe(true)
    expect(r.payRatio).toBeNull()
  })

  test('脏数据防御：缴费期长于保障期时 payRatio 夹在 100 内（不画出条外）', function () {
    const g = buildGantt([pol({ insurance_period: '5年', effective_date: '2020-01-01', payment_period: '20年' })], [{ name: '张三' }])
    expect(g.rows[0].payRatio).toBeLessThanOrEqual(100)
  })

  test('到期年龄：当前年龄 + 距到期年数（回答"60 岁时还剩什么"）', function () {
    const thisYear = new Date().getFullYear()
    const g = buildGantt(
      [pol({ insurance_period: '20年', effective_date: thisYear + '-01-01' })],
      [{ name: '张三', age: 46 }]
    )
    expect(g.rows[0].endAge).toBe(66)
  })

  test('年龄未知（未匹配到成员）→ endAge 为 null，不编年龄', function () {
    const g = buildGantt([pol({ insurance_period: '20年' })], [{ name: '别的名字', age: 30 }])
    expect(g.rows[0].endAge).toBeNull()
  })

  test('终身险无到期年 → endAge 也为 null（"终身"不换算成某个岁数）', function () {
    const g = buildGantt([pol({ insurance_period: '终身' })], [{ name: '张三', age: 46 }])
    expect(g.rows[0].endAge).toBeNull()
    expect(g.rows[0].lifetime).toBe(true)
  })
})

describe('gantt-builder — 标注语义（红线 3：不确定就标出来）', function () {
  test('缺生效日期 → 不入图，计入 notes', function () {
    const g = buildGantt([pol({ effective_date: '', contract_effective_date: '' })], [{ name: '张三' }])
    expect(g.rows).toHaveLength(0)
    expect(g.notes.join('')).toContain('缺少生效日期')
  })

  test('有生效日期但无保障期间 → 不入图，计入 notes（不猜"终身"也不猜某年）', function () {
    const g = buildGantt([pol({ insurance_period: '', coverage_term: null })], [{ name: '张三' }])
    expect(g.rows).toHaveLength(0)
    expect(g.notes.join('')).toContain('未填写保障期间')
  })

  test('一年期短险被标注为"每年续保"（不做到期倒计时 —— 续保≠到期，倒计时是伪警报）', function () {
    const g = buildGantt([pol({ insurance_period: '1年', coverage_term: 1 })], [{ name: '张三' }])
    expect(g.rows[0].oneYear).toBe(true)
    expect(g.notes.join('')).toContain('一年期')
    // 不得出现"断档/到期倒计时"这类无字段依据的结论
    expect(JSON.stringify(g)).not.toMatch(/断档|倒计时/)
  })

  test('空输入 → 结构完整不抛错', function () {
    const g = buildGantt([], [])
    expect(g.rows).toEqual([])
    expect(g.ticks).toEqual([])
    expect(g.notes).toEqual([])
  })
})

describe('gantt-builder — 守卫：不做无字段支撑的判定（v2.0 评审必改②）', function () {
  // 2026-10-14 扩字段（今天竖线 / 缴费期 / 到期年龄）：白名单**显式**列入，新增字段必须先想清楚再改这里
  const ALLOWED_BLOCK_KEYS = ['rows', 'ticks', 'startYear', 'endYear', 'nowPct', 'nowYear', 'notes']
  const ALLOWED_ROW_KEYS = ['rowKey', 'name', 'product', 'cat', 'sumAssured', 'startY', 'endY', 'startPct', 'widthPct', 'payEndY', 'payRatio', 'endAge', 'lifetime', 'oneYear', 'singlePay']

  test('block 与 row 只暴露白名单字段（将来误加"空白期/重叠"字段会在此处红）', function () {
    const g = buildGantt([pol({}), pol({ insurance_period: '1年', coverage_term: 1, insured_name: '李四' })], [{ name: '张三' }, { name: '李四' }])
    expect(Object.keys(g).sort()).toEqual(ALLOWED_BLOCK_KEYS.slice().sort())
    g.rows.forEach(r => {
      expect(Object.keys(r).sort()).toEqual(ALLOWED_ROW_KEYS.slice().sort())
    })
  })

  test('跨端同源：同一张保单在页面（gantt-builder）与 PDF（buildCoverageRows）判断一致', function () {
    // 历史教训：PDF 曾漏判 coverage_term=105 → 纸上印出 ~2130 年"保障期满"，页面无此节点（口径分裂）。
    // 甘特图新增后这条更关键：两端都从"保障期间"推导时间，一端错就是同一份报告两个说法。
    const { buildCoverageRows } = require('../cloudfunctions/reportPdf/index')
    const cases = [
      { t: '终身（文本）', p: { insurance_period: '终身' }, lifetime: true, endY: null },
      { t: '终身（105 哨兵）', p: { insurance_period: '', coverage_term: 105 }, lifetime: true, endY: null },
      { t: '20 年期（文本）', p: { insurance_period: '20年' }, lifetime: false, endY: 2040 },
      { t: '20 年期（数字兜底）', p: { insurance_period: '', coverage_term: 20 }, lifetime: false, endY: 2040 }
    ]
    cases.forEach(function (c) {
      const p = Object.assign({ product_name: 'X', insured_name: '张三', effective_date: '2020-01-01', sum_assured: 100000 }, c.p)
      const fe = buildGantt([p], [{ name: '张三' }]).rows[0]
      const pdf = buildCoverageRows([p], [{ name: '张三' }]).rows[0]
      expect([c.t, fe.lifetime, fe.endY]).toEqual([c.t, c.lifetime, c.endY])
      expect([c.t, pdf.lifetime, pdf.endY]).toEqual([c.t, c.lifetime, c.endY])
      expect([c.t, pdf.startY]).toEqual([c.t, fe.startY])
    })
  })

  test('源码不引入重叠/空白期判定（缺 reimbursement_type 字段，做了就是猜）', function () {
    const fs = require('fs')
    const path = require('path')
    const src = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'report', 'gantt-builder.js'), 'utf8')
    // 允许在"明确不做"的注释里提到这些词，但不允许出现在可执行代码里（去掉注释后再查）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/重叠|空白期|断档|reimbursement/)
  })
})
