/**
 * 异常与待核验 A1–A6（2026-10-21）
 *
 * 定位：化验单只列"有字段支撑的事实与提示"，不下诊断。编号固定，供导读与面谈引用。
 * 关键约束（都比"能列出来"更重要）：
 *   - 没有字段就不出现（A4 除外承保当前无字段 → 恒空，不猜）
 *   - 本次为空的事项不出现（不制造空标题），但编号不重排
 *   - 附加险不单独占一行（同一份合同的两个状态分列会让份数对不上）
 */
// 2026-10-22：升为跨树契约后从 _shared 同步到 miniprogram/utils/anomaly-list.js
// （源文件在 cloudfunctions/_shared/anomaly-list.js，页面与 PDF 共用）
const { buildAnomalies, parseEndDate } = require('../miniprogram/utils/anomaly-list')

const NOW = new Date('2026-10-21T00:00:00')
const P = (o) => Object.assign({
  id: 'p1', product_name: 'XX终身重疾', insurance_category: '重疾险', coverage_term: 105,
  sum_assured: 500000, annual_premium: 6000, effective_date: '2017-06-01',
  // 2026-10-27：默认带上合法比例（100%），否则每张夹具保单都会因"比例未采集"进 A3，
  // 与用例想验证的 A1/A2/A5/A6 混在一起。需要验证 A3 的用例会显式覆盖该字段。
  insurance_period: '终身', status: 'active', beneficiary_name: '张三', beneficiary_ratio: 100, policy_number: 'P1'
}, o)

const codes = (groups) => groups.map((g) => g.code)

describe('buildAnomalies — A1–A6', () => {
  test('A1 非正常状态保单：列状态标签，且不再计入"有效"', () => {
    const g = buildAnomalies({ policies: [P({ id: 'a', status: 'surrendered' }), P({ id: 'b' })], now: NOW })
    expect(codes(g)).toEqual(['A1'])
    expect(g[0].items[0].detail).toContain('退保')
  })

  test('A1 附加险随主险表述（含附加 N 项），不单独占一行', () => {
    const g = buildAnomalies({
      policies: [
        P({ id: 'main', status: 'lapsed' }),
        P({ id: 'r', product_name: '附加住院补贴', isRider: true, parentKey: 'main', status: 'lapsed' })
      ], now: NOW
    })
    expect(g[0].count).toBe(1)
    expect(g[0].items.length).toBe(1)
    expect(g[0].items[0].detail).toContain('含附加 1 项')
  })

  test('A2 受益人为法定 / A3 受益人为空 —— 两者互斥，不能都算', () => {
    const g = buildAnomalies({
      policies: [P({ id: 'a', beneficiary_name: '法定' }), P({ id: 'b', beneficiary_name: '' })], now: NOW
    })
    expect(codes(g)).toEqual(['A2', 'A3'])
    expect(g[0].items.length).toBe(1)
    expect(g[1].items.length).toBe(1)
  })

  test('A3 判据升级：有受益人但比例填错 → 进 A3；比例"未采集"不进（属待完善）', () => {
    const bad = buildAnomalies({ policies: [P({ beneficiary_name: '张三', beneficiary_ratio: 120 })], now: NOW })
    const a3 = bad.find((x) => x.code === 'A3')
    expect(a3).toBeTruthy()
    expect(a3.items[0].detail).toContain('120%')

    // 比例 60% 是**合法**值（多受益人情形），不进 A3；只有非法值（≤0 / >100）才进\n    const okRatio = buildAnomalies({ policies: [P({ beneficiary_name: '张三', beneficiary_ratio: 60 })], now: NOW })\n    expect(okRatio.find((x) => x.code === 'A3')).toBeUndefined()\n    // 比例未采集 → 进 A3，但**聚合成一条**（不逐条铺开，否则 A1/A2 会被淹）
    const un = buildAnomalies({ policies: [P({ beneficiary_name: '张三', beneficiary_ratio: undefined })], now: NOW })
    const a3u = un.find((x) => x.code === 'A3')
    expect(a3u).toBeTruthy()
    expect(a3u.count).toBe(1)
    expect(a3u.items.length).toBe(1)
    expect(a3u.items[0].detail).toContain('未采集受益比例')
  })

  test('A4 除外承保：数据模型没有字段 → 不出现（不猜）', () => {
    const g = buildAnomalies({ policies: [P({})], now: NOW })
    expect(codes(g)).not.toContain('A4')
  })

  test('A5 两年内到期的长期险：命中 / 一年期与终身都不算', () => {
    const g = buildAnomalies({
      policies: [
        P({ id: 'soon', coverage_term: 30, insurance_period: '至2027-06-30' }),
        P({ id: 'far', coverage_term: 60, insurance_period: '至2054-01-01' }),
        P({ id: 'life', coverage_term: 105, insurance_period: '终身' }),
        P({ id: 'short', coverage_term: 1, insurance_period: '1年' })
      ], now: NOW
    })
    const a5 = g.find((x) => x.code === 'A5')
    expect(a5).toBeTruthy()
    expect(a5.count).toBe(1)
    expect(a5.items[0].policyId).toBe('soon')
  })

  test('A6 短期险续保提示：60 天内列、超过不列、无日期不猜', () => {
    const g = buildAnomalies({
      policies: [
        P({ id: 'in60', coverage_term: 1, insurance_period: '1年，至2026-11-30' }),
        P({ id: 'out60', coverage_term: 1, insurance_period: '1年，至2027-06-30' }),
        P({ id: 'nodate', coverage_term: 1, insurance_period: '1年' })
      ], now: NOW
    })
    const a6 = g.find((x) => x.code === 'A6')
    expect(a6.count).toBe(1)
    expect(a6.items[0].policyId).toBe('in60')
    expect(a6.items[0].detail).toContain('续保状态需向保司核对')
  })

  test('编号顺序固定（A1→A6），空的事项不出现', () => {
    const g = buildAnomalies({
      policies: [P({ id: 'a', beneficiary_name: '法定' }), P({ id: 'b', status: 'expired' })], now: NOW
    })
    expect(codes(g)).toEqual(['A1', 'A2'])
  })

  test('软删保单不进清单', () => {
    const g = buildAnomalies({ policies: [P({ status: 'deleted' })], now: NOW })
    expect(g).toEqual([])
  })
})

describe('parseEndDate', () => {
  test('支持 ISO / 中文「至YYYY年MM月DD日」/ 不可解析返回 null', () => {
    expect(parseEndDate({ contract_end_date: '2030-01-02' }).getFullYear()).toBe(2030)
    expect(parseEndDate({ insurance_period: '保至2031年3月5日' }).getMonth()).toBe(2)
    expect(parseEndDate({ insurance_period: '终身' })).toBeNull()
  })
})
