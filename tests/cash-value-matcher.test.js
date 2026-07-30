/**
 * cash-value-matcher 单元测试 — 现价表与保单双向懒匹配
 *
 * 被测对象：cloudfunctions/dataWrite/cash-value-matcher.js
 * 设计契约：
 *   - matchCashToPolicies: 现价表入库后查保单（精确→模糊→未匹配候选）
 *   - matchOrphanCashValues: 保单入库后反向匹配孤儿现价表（writeSeam 接缝）
 *
 * writeSeam 被 jest.mock 替换为空 stub，仅校验调用次数/参数。
 */
jest.mock('../cloudfunctions/dataWrite/_shared/writeSeam', () => {
  const wsInstance = {
    silentUpdateDoc: jest.fn(() => Promise.resolve()),
    silentUpdateWhere: jest.fn(() => Promise.resolve()),
    triggerHooks: jest.fn(() => Promise.resolve())
  }
  return {
    writeSeam: jest.fn(() => wsInstance),
    advanceStage: jest.fn(),
    __wsInstance: wsInstance
  }
})

const { matchCashToPolicies, matchOrphanCashValues } = require('../cloudfunctions/dataWrite/cash-value-matcher')
const writeSeamMod = require('../cloudfunctions/dataWrite/_shared/writeSeam')
const writeSeamMock = writeSeamMod.writeSeam

function makeWhereChain(data) {
  // 链式 where().get()
  const chain = {
    get: () => Promise.resolve({ data })
  }
  return {
    collection: () => ({
      where: () => chain,
      add: () => Promise.resolve({ _id: 'new' })
    })
  }
}

describe('cash-value-matcher', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('matchCashToPolicies', () => {
    test('保单号精确匹配命中', async () => {
      const policies = [{ id: 'p1', policy_number: 'P001', product_name: 'X', insured_name: '张三' }]
      const db = makeWhereChain(policies)
      const res = await matchCashToPolicies(db, 'f1', 'oid', {
        product_name: 'X', policy_number: 'P001', insured_name: '张三'
      })
      expect(res.matched).toBe(true)
      expect(res.policyId).toBe('p1')
      expect(res.candidates).toEqual([])
    })

    test('保单号匹配但返回多条 → 不精确命中，回退模糊匹配', async () => {
      // where(policy_number) 返回 2 条（异常数据），第一步 length !== 1 不命中
      const policies = [
        { id: 'p1', policy_number: 'P001', product_name: 'X', insured_name: '张三' },
        { id: 'p2', policy_number: 'P001', product_name: 'X', insured_name: '张三' }
      ]
      const db = makeWhereChain(policies)
      const res = await matchCashToPolicies(db, 'f1', 'oid', {
        product_name: 'X', policy_number: 'P001', insured_name: '张三'
      })
      // 模糊匹配也会查到 2 条，进入 candidates 分支
      expect(res.matched).toBe(false)
      expect(res.candidates.length).toBe(2)
    })

    test('产品名+被保人模糊匹配单条命中', async () => {
      const policies = [
        { id: 'p1', product_name: '平安福（终身版）', insured_name: '李四', insurance_category: '寿险' }
      ]
      const db = makeWhereChain(policies)
      const res = await matchCashToPolicies(db, 'f1', 'oid', {
        product_name: '平安福', insured_name: '李四'
      })
      expect(res.matched).toBe(true)
      expect(res.policyId).toBe('p1')
    })

    test('模糊匹配多条 → 返回 candidates 列表', async () => {
      const policies = [
        { id: 'p1', product_name: '平安福', insured_name: '李四', insurance_category: '寿险' },
        { id: 'p2', product_name: '平安福', insured_name: '李四', insurance_category: '重疾险' }
      ]
      const db = makeWhereChain(policies)
      const res = await matchCashToPolicies(db, 'f1', 'oid', {
        product_name: '平安福', insured_name: '李四'
      })
      expect(res.matched).toBe(false)
      expect(res.candidates.length).toBe(2)
      expect(res.candidates[0]).toHaveProperty('policy_id')
      expect(res.candidates[0]).toHaveProperty('product_name')
    })

    test('未匹配 → 返回长期险候选列表（寿险/重疾/年金）', async () => {
      const policies = [
        { id: 'p1', product_name: 'A', insured_name: '甲', insurance_category: '寿险' },
        { id: 'p2', product_name: 'B', insured_name: '乙', insurance_category: '医疗险' },
        { id: 'p3', product_name: 'C', insured_name: '丙', insurance_category: '年金' }
      ]
      const db = makeWhereChain(policies)
      const res = await matchCashToPolicies(db, 'f1', 'oid', {
        product_name: '未知产品', insured_name: '不存在'
      })
      expect(res.matched).toBe(false)
      // 应该返回寿险+年金（不含医疗险）
      const cats = res.candidates.map(c => c.category)
      expect(cats).toContain('寿险')
      expect(cats).toContain('年金')
      expect(cats).not.toContain('医疗险')
    })

    test('cashDoc 无 product_name/policy_number → 直接走长期险候选', async () => {
      const policies = [
        { id: 'p1', product_name: 'A', insured_name: '甲', insurance_category: '寿险' }
      ]
      const db = makeWhereChain(policies)
      const res = await matchCashToPolicies(db, 'f1', 'oid', {})
      expect(res.matched).toBe(false)
      expect(res.candidates.length).toBe(1)
    })
  })

  describe('matchOrphanCashValues', () => {
    test('无孤儿现价表 → 直接返回，不触发 writeSeam', async () => {
      const db = makeWhereChain([])
      await matchOrphanCashValues(db, 'f1', 'oid', [])
      expect(writeSeamMock).not.toHaveBeenCalled()
    })

    test('保单号精确匹配孤儿现价表 → 更新两边', async () => {
      const orphans = [
        { _id: 'cv1', policy_number: 'P001', product_name: 'X', insured_name: '张三', cash_values: [{ v: 100 }, { v: 200 }] }
      ]
      const db = makeWhereChain(orphans)
      const newPolicies = [{ id: 'p1', policy_number: 'P001', product_name: 'X', insured_name: '张三' }]

      await matchOrphanCashValues(db, 'f1', 'oid', newPolicies)

      expect(writeSeamMock).toHaveBeenCalledTimes(1)
      const ws = writeSeamMock.mock.results[0].value
      // silentUpdateDoc 更新现价表
      expect(ws.silentUpdateDoc).toHaveBeenCalledWith(
        'policy_cash_values', 'cv1',
        expect.objectContaining({ policy_id: 'p1', matched: true, matched_by: 'auto' })
      )
      // silentUpdateWhere 更新保单
      expect(ws.silentUpdateWhere).toHaveBeenCalledWith(
        'policies', { id: 'p1' },
        expect.objectContaining({ cash_value_available: true, latest_cash_value: 200 })
      )
      // 匹配成功 → triggerHooks
      expect(ws.triggerHooks).toHaveBeenCalled()
    })

    test('产品名+被保人模糊匹配孤儿现价表', async () => {
      const orphans = [
        { _id: 'cv1', product_name: '平安福（终身版）', insured_name: '李四', cash_values: [{ v: 500 }] }
      ]
      const db = makeWhereChain(orphans)
      const newPolicies = [{ id: 'p1', product_name: '平安福', insured_name: '李四', policy_number: 'X' }]

      await matchOrphanCashValues(db, 'f1', 'oid', newPolicies)

      const ws = writeSeamMock.mock.results[0].value
      expect(ws.silentUpdateDoc).toHaveBeenCalledWith(
        'policy_cash_values', 'cv1',
        expect.objectContaining({ policy_id: 'p1' })
      )
      expect(ws.silentUpdateWhere).toHaveBeenCalledWith(
        'policies', { id: 'p1' },
        expect.objectContaining({ latest_cash_value: 500 })
      )
    })

    test('孤儿现价表无匹配 → 不更新，不触发 triggerHooks', async () => {
      const orphans = [
        { _id: 'cv1', policy_number: 'P999', product_name: '未知', insured_name: '甲', cash_values: [] }
      ]
      const db = makeWhereChain(orphans)
      const newPolicies = [{ id: 'p1', policy_number: 'P001', product_name: 'X', insured_name: '乙' }]

      await matchOrphanCashValues(db, 'f1', 'oid', newPolicies)

      const ws = writeSeamMock.mock.results[0].value
      expect(ws.silentUpdateDoc).not.toHaveBeenCalled()
      expect(ws.silentUpdateWhere).not.toHaveBeenCalled()
      expect(ws.triggerHooks).not.toHaveBeenCalled()
    })

    test('latest_cash_value 取 cash_values 数组最后一项的 v', async () => {
      const orphans = [
        { _id: 'cv1', policy_number: 'P001', product_name: 'X', insured_name: '张三',
          cash_values: [{ v: 10 }, { v: 20 }, { v: 30 }] }
      ]
      const db = makeWhereChain(orphans)
      const newPolicies = [{ id: 'p1', policy_number: 'P001', product_name: 'X', insured_name: '张三' }]

      await matchOrphanCashValues(db, 'f1', 'oid', newPolicies)

      const ws = writeSeamMock.mock.results[0].value
      expect(ws.silentUpdateWhere).toHaveBeenCalledWith(
        'policies', { id: 'p1' },
        expect.objectContaining({ latest_cash_value: 30 })
      )
    })

    test('cash_values 为空数组 → latest_cash_value 兜底 0', async () => {
      const orphans = [
        { _id: 'cv1', policy_number: 'P001', product_name: 'X', insured_name: '张三', cash_values: [] }
      ]
      const db = makeWhereChain(orphans)
      const newPolicies = [{ id: 'p1', policy_number: 'P001', product_name: 'X', insured_name: '张三' }]

      await matchOrphanCashValues(db, 'f1', 'oid', newPolicies)

      const ws = writeSeamMock.mock.results[0].value
      expect(ws.silentUpdateWhere).toHaveBeenCalledWith(
        'policies', { id: 'p1' },
        expect.objectContaining({ latest_cash_value: 0 })
      )
    })
  })
})
