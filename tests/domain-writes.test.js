// domain-writes 领域写薄层单测（候选 5）
// 验证三种写入范式参数形状经薄层收口、字符串 action 不再散落调用方
jest.mock('../miniprogram/utils/apiClient')
const api = require('../miniprogram/utils/apiClient')
const { saveMemberField, savePolicyData, saveFamilyPatch, writePoliciesBatch } = require('../miniprogram/utils/domain-writes')

api.mockResolvedValue({ ok: true, code: 200, data: null })

beforeEach(() => api.mockClear())

describe('saveMemberField — 逐字段 field/value 范式', () => {
  test('转发 dataWrite.updateMember 且形状不变', async () => {
    const params = { familyId: 'f1', memberId: 'm1', field: 'role', value: '子女' }
    await saveMemberField(params)
    expect(api).toHaveBeenCalledWith('updateMember', params)
  })
})

describe('savePolicyData — 嵌套 data 范式', () => {
  test('转发 dataWrite.updatePolicy 带 policyId+data', async () => {
    const params = { familyId: 'f1', policyId: 'p1', data: { sum_assured: 100 } }
    await savePolicyData(params)
    expect(api).toHaveBeenCalledWith('updatePolicy', params)
  })
})

describe('saveFamilyPatch — 整家 updateData 覆盖范式', () => {
  test('转发 dataWrite.updateFamily 带 updateData', async () => {
    const params = { familyId: 'f1', updateData: { members: [{ name: 'A' }] } }
    await saveFamilyPatch(params)
    expect(api).toHaveBeenCalledWith('updateFamily', params)
  })
})

describe('writePoliciesBatch — 批量保单 + 现价表', () => {
  test('cashValues 映射为后端 cash_values，opts 透传（长超时/关重试/reqId）', async () => {
    const policies = [{ product_name: 'x' }]
    const cashValues = [{ year: 1 }]
    const opts = { timeout: 60000, retries: 0, requestId: 'ocr_1' }
    await writePoliciesBatch({ familyId: 'f1', policies, cashValues }, opts)
    expect(api).toHaveBeenCalledWith('writePoliciesBatch', { familyId: 'f1', policies, cash_values: cashValues }, opts)
  })
})
