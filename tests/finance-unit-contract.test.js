/**
 * finances 写入的单位契约（2026-09-27）
 *
 * 起因：一条审计结论称「`memberRepo.FINANCE_FIELD_MAP` 仍接受 `income/debt` 等**万**语义别名
 * 写进**元**契约字段 → 少报 10000×」。逐条核实后**部分推翻**，本文件钉住核实结果：
 *
 *   ❌ 推翻的部分：映射表把 `income`/`debt` 当 `annual_income`/`total_debt` 的 1:1 别名，
 *      是**被测试钉住的既有契约**（`tests/walkthrough-e2e.test.js` L95-100：`income:30` →
 *      `annual_income:30`），即入参别名**与规范键同单位（元）**，不是万。且线上唯一的 `finances`
 *      文档存的是 `annual_income:300000` / `total_debt:150000`（元），**从无旧万键落库**；
 *      前端财务编辑走 edit-form → `financial_snapshot`(万) → `updateFamily` → family-write 已
 *      `wanToYuan`，不经此映射 → **无现存调用方、无线上数据触发"10000× 少报"**。
 *      误报根源：读侧 `_toWan(f.annual_income, f.income)` 兼容的是**存量文档里的旧字段**
 *      （历史表单路径把万写进过 `finances.income/debt`），与**入参键名**同名不同事
 *      —— 两个层次共用一个名字，故本文件同时钉住两者的**单位不同**，防止后人按其一改其二。
 *
 *   ✅ 成立的部分（本文件主要守护对象）：`recordField` 的**负债**支给自己开了例外 ——
 *      从自由文本抠第一个数字（`'房贷150万'` → 150）直接落库，写进**元**字段 = **少报 10000 倍**；
 *      且 `[一-龥]+` 连单位字一起抠成负债类型（`'房贷万'`）。而**收入**支早在 2026-09-22 就要求
 *      「金额必须是数字（单位：元）」并 400（见 `tests/data-quality-batch1.test.js` ③，
 *      同一测试文件的 describe 名就是「金额字段必须是数字（单位：元）」）→ 本次是**补全那条既有决策**，
 *      不是新口径。负债类型改由 `updateFinances` 传入（其白名单与 AI schema 均含 `debt_type`）。
 */
jest.mock('wx-server-sdk', function () {
  const { memoryCommand } = require('./helpers/memory-db')
  return {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'env-mock',
    database: jest.fn(function () { return { command: memoryCommand, collection: jest.fn() } }),
    getWXContext: jest.fn(function () { return { OPENID: 'o1' } }),
    callFunction: jest.fn(function () { return Promise.resolve({ result: { code: 200 } }) })
  }
})

const handlers = require('../cloudfunctions/dataWrite/handlers')
const { makeMemoryDb } = require('./helpers/memory-db')
const {
  upsertFinances, getFinance, FINANCE_FIELD_MAP
} = require('../cloudfunctions/dataWrite/_shared/memberRepo')

const FAM = 'fam1'
const OID = 'o1'
function makeDb(seed = {}) {
  const store = {}
  for (const k of Object.keys(seed)) {
    store[k] = seed[k].map((r, i) => Object.assign({ _openid: OID, _id: r._id || ('id_' + k + '_' + i) }, r))
  }
  return makeMemoryDb(store)
}
async function readFin(db) {
  const r = await db.collection('finances').where({ family_id: FAM }).get()
  return r.data
}

// ===========================================================================
// ① 入参别名（元，1:1）—— 既有契约，不得按"万键"改写
// ===========================================================================
describe('upsertFinances — 入参别名与规范键同单位（元）', () => {
  test('规范元键照常落库（元口径）', async () => {
    const db = makeDb({})
    const r = await upsertFinances(db, FAM, OID, { annual_income: 300000, total_debt: 1500000 })
    expect(r.code).toBe(200)
    const fin = await readFin(db)
    expect(fin[0].annual_income).toBe(300000)
    expect(fin[0].total_debt).toBe(1500000)
  })

  // 钉住既有契约（tests/walkthrough-e2e L95-100）：入参 income/debt 不是万键，与规范键同单位
  test('别名 income/debt/liability → 1:1 写入元字段（不加换算、不拒绝）', async () => {
    const cases = [
      [{ income: 300000 }, 'annual_income', 300000],
      [{ debt: 150000 }, 'total_debt', 150000],
      [{ liability: 150000 }, 'total_debt', 150000]
    ]
    for (const [patch, field, val] of cases) {
      const db = makeDb({})
      const r = await upsertFinances(db, FAM, OID, patch)
      expect(r.code).toBe(200)
      const fin = await readFin(db)
      expect(fin[0][field]).toBe(val)
    }
  })

  test('映射表：别名一律映到规范元键（防被当成需要 ×10000 的万键）', () => {
    expect(FINANCE_FIELD_MAP.income).toBe('annual_income')
    expect(FINANCE_FIELD_MAP.debt).toBe('total_debt')
    expect(FINANCE_FIELD_MAP.liability).toBe('total_debt')
    expect(Object.keys(FINANCE_FIELD_MAP)).toEqual(
      expect.arrayContaining(['annual_income', 'total_debt', 'debt_type', 'annual_premium_budget'])
    )
  })

  test('非白名单字段仍被丢弃（原契约）', async () => {
    const db = makeDb({})
    const r = await upsertFinances(db, FAM, OID, { fixed_annual_expense: 50000 })
    expect(r.code).toBe(400)
    expect((await readFin(db)).length).toBe(0)
  })
})

// ===========================================================================
// ② 读侧：存量**文档**旧键（万）的 fallback 必须保留 —— 与①同名不同事
//    这是误报的根源：入参 `income` 是元，文档里躺着的 `income` 是万
// ===========================================================================
describe('getFinance — 存量文档旧键（万）仍可读', () => {
  test('历史文档只存 income:30 / debt:150（万）→ 读回 30 / 150', async () => {
    const db = makeDb({ finances: [{ family_id: FAM, income: 30, debt: 150, debt_type: '房贷' }] })
    const f = await getFinance(db, FAM, OID)
    expect(f.income).toBe(30)
    expect(f.debt.amount).toBe(150)
    expect(f.debt.type).toBe('房贷')
  })

  test('规范元键（线上实际形态）→ ÷10000 转万', async () => {
    const db = makeDb({ finances: [{ family_id: FAM, annual_income: 300000, total_debt: 150000 }] })
    const f = await getFinance(db, FAM, OID)
    expect(f.income).toBe(30)
    expect(f.debt.amount).toBe(15)
  })
})

// ===========================================================================
// ③ 生产侧：recordField 负债支补齐「金额必须是数字（单位：元）」（与收入支同契约）
// ===========================================================================
describe('recordField 负债 — 金额必须是数字（单位：元）', () => {
  test('数值入参照常落库（元口径，规范键）', async () => {
    const db = makeDb({ families: [{ _id: FAM, family_name: '测试' }] })
    const r = await handlers.recordField(db, OID, { familyId: FAM, data: { dimension: '负债', value: 1500000 } })
    expect(r.code).toBe(200)
    const fin = await readFin(db)
    expect(fin[0].total_debt).toBe(1500000)
  })

  // 复现：'房贷150万' 曾抠出 150 落成 total_debt=150（元）= 少报 10000×，且 debt_type 被抠成 '房贷万'
  test('文本金额（"房贷150万"）→ 400，且不落库任何值', async () => {
    const db = makeDb({ families: [{ _id: FAM, family_name: '测试' }] })
    const r = await handlers.recordField(db, OID, { familyId: FAM, data: { dimension: '负债', value: '房贷150万' } })
    expect(r.code).toBe(400)
    expect(r.msg).toContain('必须是数字')
    expect((await readFin(db)).length).toBe(0)
  })

  test('总负债同契约', async () => {
    const db = makeDb({ families: [{ _id: FAM, family_name: '测试' }] })
    const r = await handlers.recordField(db, OID, { familyId: FAM, data: { dimension: '总负债', value: '150万' } })
    expect(r.code).toBe(400)
    expect((await readFin(db)).length).toBe(0)
  })

  test('收入支行为不变（回归锁，与 data-quality-batch1 ③ 同）', async () => {
    const db = makeDb({ families: [{ _id: FAM, family_name: '测试' }] })
    const r = await handlers.recordField(db, OID, { familyId: FAM, data: { dimension: '收入', value: 300000 } })
    expect(r.code).toBe(200)
    expect((await readFin(db))[0].annual_income).toBe(300000)
  })
})
