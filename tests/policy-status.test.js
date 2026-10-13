/**
 * policy-status 生命周期状态单元测试
 *
 * 覆盖：
 * - 手动终止状态不被系统自动覆盖
 * - 显式 active（写入判定/手动恢复）被尊重，读取层不重算
 * - calcStatus 按保障期限判定（录入落库时使用）
 * - 到期终止(expired)保持终态
 */

const {
  calcStatus,
  ensureStatus,
  ensureStatusBatch,
  STATUS_LABELS,
  MANUAL_STATUSES,
  AUTO_STATUSES,
  listExpiredButActive,
  isOneYearPolicy,
  isLifetimeTerm,
  isSinglePayTerm
} = require('../cloudfunctions/_shared/policy-status')

function makePolicy(overrides = {}) {
  return Object.assign({
    _id: 'p1',
    id: 'pol_1',
    family_id: 'fam1',
    product_name: '测试保单',
    insured_name: '张三',
    sum_assured: 100000,
    annual_premium: 5000,
    insurance_period: '终身',
    contract_effective_date: '2020-01-01',
    effective_date: '2020-01-01',
    insured_age: 30,
    status: 'active'
  }, overrides)
}

describe('policy-status 状态枚举', () => {
  test('状态文案包含新状态', () => {
    expect(STATUS_LABELS.lapsed).toBe('失效')
    expect(STATUS_LABELS.surrendered).toBe('退保')
    expect(STATUS_LABELS.claim_terminated).toBe('理赔终止')
    expect(STATUS_LABELS.expired).toBe('到期终止')
  })

  test('手动终止状态列表包含失效/退保/理赔终止', () => {
    expect(MANUAL_STATUSES).toEqual(expect.arrayContaining(['lapsed', 'surrendered', 'claim_terminated']))
  })

  test('系统自动状态为 expired', () => {
    expect(AUTO_STATUSES).toContain('expired')
  })
})

describe('ensureStatus 自动判断', () => {
  test('active 且未到期保持 active', () => {
    const p = makePolicy({ insurance_period: '终身' })
    const r = ensureStatus(p)
    expect(r.status).toBe('active')
  })

  test('一年期产品不因生效满一年自动过期（保证续保场景）', () => {
    const p = makePolicy({
      status: 'active',
      insurance_period: '1年',
      effective_date: '2010-01-01'
    })
    const r = ensureStatus(p)
    expect(r.status).toBe('active')
  })

  test('日期区间形态一年期（OCR：自2024年01月15日起至2025年01月14日止）不判到期终止', () => {
    const p = makePolicy({
      status: undefined,
      insurance_period: '自2024年01月15日零时起至2025年01月14日二十四时止',
      contract_effective_date: '2024-01-15',
      effective_date: '2024-01-15'
    })
    const r = calcStatus(p)
    expect(r.status).toBe('active')
  })

  test('日期区间形态一年期（2024-01-15至2025-01-14）不判到期终止', () => {
    const p = makePolicy({
      status: undefined,
      insurance_period: '至2025-01-14',
      contract_effective_date: '2024-01-15',
      effective_date: '2024-01-15'
    })
    const r = calcStatus(p)
    expect(r.status).toBe('active')
  })

  test('多年期（3年）到期日已过仍判 expired（不误伤非一年期）', () => {
    const p = makePolicy({
      status: undefined,
      insurance_period: '至2013-01-14',
      contract_effective_date: '2010-01-15',
      effective_date: '2010-01-15'
    })
    const r = calcStatus(p)
    expect(r.status).toBe('expired')
  })

  test('中文数字"一年"不判到期终止', () => {
    const p = makePolicy({
      status: undefined,
      insurance_period: '一年',
      effective_date: '2010-01-01'
    })
    const r = calcStatus(p)
    expect(r.status).toBe('active')
  })

  test('显式 active 被尊重，不因明确到期日自动转为 expired（手动恢复有效场景）', () => {
    const p = makePolicy({
      status: 'active',
      insurance_period: '至2020-12-31',
      effective_date: '2010-01-01'
    })
    const r = ensureStatus(p)
    expect(r.status).toBe('active')
  })

  test('calcStatus 对明确到期日（多年期）仍判 expired（写入层录入时据此落库）', () => {
    // contract_effective_date 优先于 effective_date：须同时覆盖，否则 eff=2020-01-01 + 至2020-12-31
    // 恰好构成 1 年间隔，会被一年期语义判定为 active（见"日期区间形态一年期"用例）
    const p = makePolicy({
      insurance_period: '至2013-12-31',
      contract_effective_date: '2010-01-01',
      effective_date: '2010-01-01'
    })
    const r = calcStatus(p)
    expect(r.status).toBe('expired')
  })

  test('手动失效状态不被自动覆盖', () => {
    const p = makePolicy({
      status: 'lapsed',
      insurance_period: '1年',
      effective_date: '2010-01-01'
    })
    const r = ensureStatus(p)
    expect(r.status).toBe('lapsed')
  })

  test('退保状态不被自动覆盖', () => {
    const p = makePolicy({ status: 'surrendered', insurance_period: '1年', effective_date: '2010-01-01' })
    const r = ensureStatus(p)
    expect(r.status).toBe('surrendered')
  })

  test('理赔终止状态不被自动覆盖', () => {
    const p = makePolicy({ status: 'claim_terminated', insurance_period: '1年', effective_date: '2010-01-01' })
    const r = ensureStatus(p)
    expect(r.status).toBe('claim_terminated')
  })

  test('expired 终态不被重算', () => {
    const p = makePolicy({ status: 'expired', insurance_period: '终身' })
    const r = ensureStatus(p)
    expect(r.status).toBe('expired')
  })
})

describe('ensureStatusBatch', () => {
  test('批量保持手动状态并自动判断 active', () => {
    const list = [
      makePolicy({ _id: 'p1', status: 'active', insurance_period: '终身' }),
      makePolicy({ _id: 'p2', status: 'lapsed', insurance_period: '1年', effective_date: '2010-01-01' }),
      makePolicy({ _id: 'p3', status: 'surrendered', insurance_period: '1年', effective_date: '2010-01-01' })
    ]
    const result = ensureStatusBatch(list)
    expect(result.map(p => p.status)).toEqual(['active', 'lapsed', 'surrendered'])
  })
})

describe('calcStatus 兼容性', () => {
  test('未知期限时返回 active 占位', () => {
    const r = calcStatus(makePolicy({ status: undefined, insurance_period: '' }))
    expect(r.status).toBe('active')
  })
})

// ===========================================================================
// 2026-09-20（复核批次 A）：到期日边界
// ===========================================================================
describe('calcStatus 到期日边界', () => {
  // 分界 = 到期日**次日** 00:00。依据条款原文「…至 YYYY年MM月DD日二十四时止」（parse-expiry 注释引），
  // 到期日当天仍在保障期内；原实现把 expiry.date（当天 00:00）与含时分秒的 now 直接比较，
  // 到期日 00:00:01 即判 expired，比条款口径早一天。既有用例的到期日都远在过去（2013/2020），
  // 所以这个边界一直没被覆盖 —— 本组用例相对"今天"动态构造。
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }
  function policyExpiringOn(dateStr) {
    // 生效日取 2010：与到期日相差十余年，确保不落进「一年期保证续保」分支
    return makePolicy({
      status: undefined,
      insurance_period: '至' + dateStr,
      contract_effective_date: '2010-01-01',
      effective_date: '2010-01-01'
    })
  }

  test('到期日当天 → active（"二十四时止"，非当天零点即失效）', () => {
    const r = calcStatus(policyExpiringOn(iso(new Date())))
    expect(r.status).toBe('active')
  })

  test('到期日次日 → expired（并非无限期有效）', () => {
    const r = calcStatus(policyExpiringOn(iso(new Date(Date.now() - 86400000))))
    expect(r.status).toBe('expired')
  })

  test('到期日未到 → active', () => {
    const r = calcStatus(policyExpiringOn(iso(new Date(Date.now() + 86400000))))
    expect(r.status).toBe('active')
  })
})

// ===========================================================================
// 2026-09-22 产品决策：一年期产品默认是续保的，但要在文中给出提醒
//   → 状态**不改**（这就是为什么不是"改成 expired"），只把"载明期限已过"的保单列出来给报告用。
//   背景：writePolicy 入库一律 status='active'（不判定）+ ensureStatus 把显式 status 当手动设定
//   永不重算 → 真实家庭 14 份保单全部 active，其中 6 份载明期限已过（最早 2020-09-27）。
// ===========================================================================
describe('listExpiredButActive', () => {
  const NOW = new Date(2026, 8, 22) // 2026-09-22
  function pol(over) { return Object.assign({ status: 'active' }, over) }

  test('文本「1年」：用 生效日+1年 推算到期日，命中且 isOneYear=true', () => {
    const r = listExpiredButActive([pol({ insurance_period: '1年', effective_date: '2024-05-01', product_name: '百万医疗' })], NOW)
    expect(r.length).toBe(1)
    expect(r[0].isOneYear).toBe(true)
    expect(r[0].expiryText).toBe('2025-05-01')
  })

  test('日期区间一年期（跨度 ~365 天）：命中且 isOneYear=true（保证续保）', () => {
    const r = listExpiredButActive([pol({ insurance_period: '2025年03月20日零时起至2026年03月19日二十四时止', effective_date: '2025-03-20' })], NOW)
    expect(r.length).toBe(1)
    expect(r[0].isOneYear).toBe(true)
    expect(r[0].expiryText).toBe('2026-03-19')
  })

  test('非一年期已过期 → 命中且 isOneYear=false（无"默认续保"可依据）', () => {
    const r = listExpiredButActive([pol({ insurance_period: '至2021年05月19日', effective_date: '2009-05-20' })], NOW)
    expect(r.length).toBe(1)
    expect(r[0].isOneYear).toBe(false)
  })

  test('到期日当天 → 不算已过（与 calcStatus 同口径「二十四时止」）', () => {
    expect(listExpiredButActive([pol({ insurance_period: '至2026年09月22日', effective_date: '2009-09-23' })], NOW).length).toBe(0)
  })

  test('未到期 / 非 active / 无期限 → 均不命中（不制造噪声）', () => {
    expect(listExpiredButActive([pol({ insurance_period: '至2030年01月01日', effective_date: '2020-01-01' })], NOW).length).toBe(0)
    expect(listExpiredButActive([pol({ status: 'surrendered', insurance_period: '至2021年05月19日' })], NOW).length).toBe(0)
    expect(listExpiredButActive([pol({ insurance_period: '' })], NOW).length).toBe(0)
    expect(listExpiredButActive([pol({ insurance_period: '终身' })], NOW).length).toBe(0)
  })

  test('排序：非一年期（更需人工核实）排在一年期之前', () => {
    const r = listExpiredButActive([
      pol({ product_name: 'A一年期', insurance_period: '至2025年05月19日', effective_date: '2024-05-20' }),
      pol({ product_name: 'B非一年期', insurance_period: '至2021年05月19日', effective_date: '2011-05-20' })
    ], NOW)
    expect(r.length).toBe(2)
    expect(r[0].product_name).toBe('B非一年期')
  })
})

// ===========================================================================
// 2026-09-22：一年期判定的单一实现（原先 data-normalizer 与 chapter-builder 各写一份，
//   都只认文本形态 `^(1|一)年` 与 coverage_term=1 → 日期区间形态全部漏判）。
//   实测线上 13 份保单里 6 份一年期（含 400 万医疗险 ×4、800 万意外险 ×1）**一份都没被识别出**。
// ===========================================================================
describe('isOneYearPolicy', () => {
  test('文本形态：1年 / 一年 / 壹年 / 1年期（^ 锚定，不误匹配 21年）', () => {
    expect(isOneYearPolicy({ insurance_period: '1年' })).toBe(true)
    expect(isOneYearPolicy({ insurance_period: '一年期' })).toBe(true)
    expect(isOneYearPolicy({ insurance_period: '壹年' })).toBe(true)
    expect(isOneYearPolicy({ insurance_period: '21年' })).toBe(false)
  })

  test('数字编码：coverage_term=1（数字与字符串）', () => {
    expect(isOneYearPolicy({ coverage_term: 1 })).toBe(true)
    expect(isOneYearPolicy({ coverage_term: '1' })).toBe(true)
    expect(isOneYearPolicy({ coverage_term: 30 })).toBe(false)
  })

  test('日期区间形态：起止相差约一年（原先两处消费方都漏了这一支）', () => {
    expect(isOneYearPolicy({ insurance_period: '2025年03月20日零时起至2026年03月19日二十四时止', effective_date: '2025-03-20' })).toBe(true)
    expect(isOneYearPolicy({ insurance_period: '至2021年05月19日', effective_date: '2020-05-20' })).toBe(true)
  })

  test('非一年期：终身 / 长期 / 30年 / 十余年跨度', () => {
    expect(isOneYearPolicy({ insurance_period: '终身' })).toBe(false)
    expect(isOneYearPolicy({ insurance_period: '长期' })).toBe(false)
    expect(isOneYearPolicy({ insurance_period: '30年', effective_date: '2020-01-01' })).toBe(false)
    expect(isOneYearPolicy({ insurance_period: '至2044年04月22日', effective_date: '2015-04-23' })).toBe(false)
  })

  test('空输入不抛错', () => {
    expect(isOneYearPolicy(null)).toBe(false)
    expect(isOneYearPolicy({})).toBe(false)
    expect(isOneYearPolicy({ insurance_period: '至2021年05月19日' })).toBe(false) // 无生效日 → 判断不出 → false
  })
})

// ===========================================================================
// 2026-09-22 口径自查：把"两份手工清单 + 一句同构注释"收敛为契约派生。
//   背景：policy-status.js 顶部声明"与 dataWrite/policy-write.js 的变更白名单保持同构"，
//   但实际是两份手写清单（本文件 MANUAL_STATUSES 4 个态 / policy-write 5 个态）——
//   只靠注释维持一致，一方新增必然漂移（本仓库已在 write-tools.js 为此栽过一次：
//   前端手写镜像漏了 deletePolicy/deleteMember/deleteFact 三个写工具）。
//   现 policy-write 从契约派生，以下断言把它钉死。
// ===========================================================================
describe('保单状态清单的契约不变量', () => {
  const { POLICY_STATUS_CHANGEABLE } = require('../cloudfunctions/dataWrite/policy-write')

  test('可变更白名单 = [active, ...MANUAL_STATUSES]（真派生，非注释同构）', () => {
    expect(POLICY_STATUS_CHANGEABLE).toEqual(['active', ...MANUAL_STATUSES])
  })

  test('手动状态与自动判定状态不相交（expired 不可手动设）', () => {
    AUTO_STATUSES.forEach(s => {
      expect(MANUAL_STATUSES).not.toContain(s)
      expect(POLICY_STATUS_CHANGEABLE).not.toContain(s)
    })
  })

  test('每个可变更状态都有展示文案（STATUS_LABELS 覆盖）', () => {
    POLICY_STATUS_CHANGEABLE.forEach(s => expect(STATUS_LABELS[s]).toBeTruthy())
  })
})

// ===========================================================================
// 2026-09-22 口径自查：终身/趸交哨兵收敛为契约函数
//   背景：coverage_term=105（终身）与 premium_term=1（趸交）这两套"哨兵值"原先在 4 处消费方
//   各写一份内联比较，且**已经漏过一次** —— 2026-09-20 PDF 审计 P1：reportPdf._termYear 只排除
//   0/'0'、漏了 105 → coverage_term=105 的保单在 PDF「保障节点」出现 startY+105 ≈ 2130 年
//   "保障期满"，而前端 timeline-builder 同时返回 null → 同一份数据口径分裂。
//   当时的修法是给 PDF 就地补一个本地常量 ✗ —— 只是把"下一个消费方还会漏"往后推了一次。
// ===========================================================================
describe('终身/趸交哨兵的单一事实源', () => {
  test('isLifetimeTerm：105 与更早的未填哨兵（数字 0 / 字符串 0）两代写法都认，其它不认', () => {
    ;[105, '105', 0, '0'].forEach(v => expect(isLifetimeTerm(v)).toBe(true))
    ;[30, '30', 20, null, undefined, ''].forEach(v => expect(isLifetimeTerm(v)).toBe(false))
  })

  test('isSinglePayTerm：1 与更早的未填哨兵（数字 0 / 字符串 0）都认，其它不认', () => {
    ;[1, '1', 0, '0'].forEach(v => expect(isSinglePayTerm(v)).toBe(true))
    ;[20, '20', 105, null, undefined, ''].forEach(v => expect(isSinglePayTerm(v)).toBe(false))
  })

  // 源码扫描：新增消费方若又写成内联比较，这里就红（这是本次收敛的**主要收益**）
  test('4 处消费方都不再内联比较哨兵（改走契约）', () => {
    const fs2 = require('fs')
    const path2 = require('path')
    const SITES = [
      'cloudfunctions/reportAI/report-coverage.js',
      'cloudfunctions/reportPdf/index.js',
      'miniprogram/utils/report/chapter-builder.js',
      'miniprogram/utils/report/timeline-builder.js'
    ]
    SITES.forEach(rel => {
      const src = fs2.readFileSync(path2.join(__dirname, '..', rel), 'utf8')
      src.split('\n').forEach((line, i) => {
        const t = line.trim()
        if (!t || t.indexOf('//') === 0 || t.indexOf('*') === 0) return // 跳过整行注释（CRLF 下不能只靠正则剔注释）
        expect({ file: rel, line: i + 1, text: t }).not.toMatchObject({ text: expect.stringMatching(/===?\s*(105|['"]105['"]|1|['"]1['"])\s*[,)]/) })
      })
    })
  })
})
