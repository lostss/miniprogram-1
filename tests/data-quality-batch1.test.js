/**
 * 数据质量批次 1 护栏（2026-09-22，源自「数据集合 → 报告质量」盘点 + 真实报告分析）
 *
 * 四项修复的回归锁：
 *   ① 险种归一不变量：STANDARD_COVERAGE 的每一项必须 canonCat 稳定
 *      （曾因 '年金险' / '年金' 拼写不一致，让画像覆盖矩阵对年金恒判 missing，
 *        而缺口矩阵经归一后正常 → 同一份 AI 上下文自相矛盾）
 *   ② 收入事实的单位归一：'年收入300000元' 不得被当成 30 万×10000
 *   ③ recordField 金额必须是数字：传 '30万' 曾把家庭年收入静默写成 null
 *   ④ 报告 prompt 的分支条件：「个人收入未填」不得被当作「家庭年收入缺失」
 */
// ③ 需要 handler 级测试：mock wx-server-sdk（command 与 adapter 共用同一实现，见 crud-gaps）
jest.mock('wx-server-sdk', function() {
  const { memoryCommand } = require('./helpers/memory-db')
  return {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function() { return { command: memoryCommand, collection: jest.fn() } }),
    getWXContext: jest.fn(function() { return { OPENID: 'o1' } }),
    callFunction: jest.fn(function() { return Promise.resolve({ result: { code: 200 } }) })
  }
})

const handlers = require('../cloudfunctions/dataWrite/handlers')
const { makeMemoryDb } = require('./helpers/memory-db')
const { _incomeWan } = require('../cloudfunctions/dataWrite/fact-member-sync')
const { canonCat } = require('../cloudfunctions/_shared/thresholds')
const { STANDARD_COVERAGE } = require('../cloudfunctions/_shared/fact-vocab')
const { buildPortrait } = require('../cloudfunctions/_shared/familyPortrait')
const { REPORT_PROMPT } = require('../cloudfunctions/reportAI/prompts')

const FAM = 'fam1'
const OID = 'o1'
function makeDb(seed = {}) {
  const store = {}
  for (const k of Object.keys(seed)) {
    store[k] = seed[k].map((r, i) => Object.assign({ _openid: OID, _id: r._id || ('id_' + k + '_' + i) }, r))
  }
  return makeMemoryDb(store)
}

// ===========================================================================
// ① 险种归一不变量
// ===========================================================================
describe('险种归一：STANDARD_COVERAGE 必须 canonCat 稳定', () => {
  test('每一项 canonCat(x) === x（这一条能挡住"两张表拼写不一致"整类问题）', () => {
    const unstable = STANDARD_COVERAGE.filter(d => canonCat(d) !== d)
    expect(unstable).toEqual([])
  })

  test('裸词/异体拼写归一（OCR 存裸词，历史数据可能存 年金险）', () => {
    expect(canonCat('重疾')).toBe('重疾险')
    expect(canonCat('医疗')).toBe('医疗险')
    expect(canonCat('意外')).toBe('意外险')
    expect(canonCat('年金')).toBe('年金')
    expect(canonCat('年金险')).toBe('年金') // 2026-09-22 新增反向映射
  })

  test('空值/未知值安全（不误判成某个险种）', () => {
    expect(canonCat('')).toBe('其他')
    expect(canonCat(null)).toBe('其他')
    expect(canonCat('增额终身寿')).toBe('增额终身寿') // 未映射则原样返回
  })
})

// ===========================================================================
// ①b 结果级：画像覆盖矩阵能否识别该类保单（走 authPolicies 路径，与线上一致）
//     v2-context 传的是 { policies: activePolicies }，故此处必须带 policies 才能覆盖到
// ===========================================================================
describe('画像覆盖矩阵：险种归一（结果级）', () => {
  function portraitWith(category) {
    const members = [{ member_id: 'm1', name: '李阳勇', role: '本人', birth_date: '1990-06-15', status: 'active' }]
    const policies = [{
      id: 'pol_1', _id: 'pol_1', product_name: '某长期储蓄保险',
      insurance_category: category, sum_assured: 200000, annual_premium: 10000,
      status: 'active', member_id: 'm1'
    }]
    return buildPortrait(members, [], { policies })
  }

  test('insurance_category="年金" → 年金维度不再恒为 missing（修复前该键根本不存在）', () => {
    const cov = portraitWith('年金').members[0].coverage
    expect(cov['年金']).toBeTruthy()
    expect(cov['年金'].status).not.toBe('missing')
  })

  test('异体拼写"年金险"也能命中（CANON_CAT 反向映射）', () => {
    const cov = portraitWith('年金险').members[0].coverage
    expect(cov['年金']).toBeTruthy()
    expect(cov['年金'].status).not.toBe('missing')
  })

  test('对照：一直是规范值的"重疾险"不受影响（修复未误伤）', () => {
    const cov = portraitWith('重疾险').members[0].coverage
    expect(cov['重疾险'].status).not.toBe('missing')
  })
})

// ===========================================================================
// ② 收入事实 → members.income（单位：万）
// ===========================================================================
describe('_incomeWan — fact 文本收入单位归一', () => {
  test('带「万」单位 → 原值', () => {
    expect(_incomeWan('年收入30万')).toBe(30)
    expect(_incomeWan('年薪 25 万元')).toBe(25)
  })

  test('带「元」单位 → ÷10000（原实现直接落 300000，差 10000 倍）', () => {
    expect(_incomeWan('年收入300000元')).toBe(30)
    expect(_incomeWan('年收入250000元')).toBe(25)
  })

  test('无单位：小数按万；数量级明显是元则按元', () => {
    expect(_incomeWan('30')).toBe(30)      // 30 万
    expect(_incomeWan('30.5')).toBe(30.5)
    expect(_incomeWan('300000')).toBe(30)  // 没人说"300000万"
  })

  test('解析不出 → null（调用方跳过同步，不猜）', () => {
    expect(_incomeWan('收入待补全')).toBeNull()
    expect(_incomeWan('')).toBeNull()
    expect(_incomeWan(null)).toBeNull()
  })
})

// ===========================================================================
// ③ recordField 金额数值校验
// ===========================================================================
describe('recordField — 金额字段必须是数字（单位：元）', () => {
  test('数值入参照常落库（元口径）', async () => {
    const db = makeDb({ families: [{ _id: FAM, family_name: '测试' }] })
    const r = await handlers.recordField(db, OID, { familyId: FAM, data: { dimension: '收入', value: 300000 } })
    expect(r.code).toBe(200)
    const fin = await db.collection('finances').where({ family_id: FAM }).get()
    expect(fin.data[0].annual_income).toBe(300000)
  })

  // 实测复现过的数据损坏：'30万' 被原样落成字符串 → 读取侧 _toWan 得 NaN → 年收入变 null
  test('文本金额（"30万"）→ 400，且不落库任何值', async () => {
    const db = makeDb({ families: [{ _id: FAM, family_name: '测试' }] })
    const r = await handlers.recordField(db, OID, { familyId: FAM, data: { dimension: '收入', value: '30万' } })
    expect(r.code).toBe(400)
    expect(r.msg).toContain('必须是数字')
    const fin = await db.collection('finances').where({ family_id: FAM }).get()
    expect(fin.data.length).toBe(0) // 一个字段都没写
  })
})

// ===========================================================================
// ④ 报告 prompt 的分支条件
// ===========================================================================
describe('REPORT_PROMPT — 补数据话术的分支条件', () => {
  test('明确「个人收入未填」≠「家庭年收入缺失」（真实报告曾因此自相矛盾）', () => {
    expect(REPORT_PROMPT).toContain('「个人收入未填」不等于「家庭年收入缺失」')
    expect(REPORT_PROMPT).toContain('禁止因为成员个人收入为空/0 而改用定性模式版本')
  })

  test('旧的过宽触发条件已移除', () => {
    expect(REPORT_PROMPT).not.toContain('当存在数据缺失且同时给出配置建议时')
  })

  test('两个分支的话术都还在（只改触发条件，不改措辞）', () => {
    expect(REPORT_PROMPT).toContain('以下建议基于当前家庭收入数据估算')
    expect(REPORT_PROMPT).toContain('以下建议为定性判断，家庭年收入补全后可解锁量化测算')
  })
})
