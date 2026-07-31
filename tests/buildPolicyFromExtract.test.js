/**
 * buildPolicyFromExtract 单元测试 — OCR→policy 字段映射契约
 *
 * 被测对象：cloudfunctions/_shared/ocr-core.js · buildPolicyFromExtract
 * 设计契约：AI 提取结果 + 合同基本信息 + 置信度 → 保单记录数组
 *   - 字段映射权威源：OCR 侧 buildPolicyFromExtract 与 Write 侧 writePolicy 共享 22 字段
 *   - 险种归一化：canonCat('重疾')='重疾险' / '医疗'→'医疗险' / ''→'其他'
 *   - ID 生成：pol_<timestamp>_<random6>
 *   - birth_date 三字段透传（OCR→member-matcher 用，不入 policies 集合）
 *
 * 此测试是防止 ocrService/ocr-core 与 dataWrite/policy-write 字段映射漂移的护栏。
 */
const { buildPolicyFromExtract, _toNum } = require('../cloudfunctions/_shared/ocr-core')
const { assessPolicy, assessCoreCompleteness } = require('../cloudfunctions/_shared/ocr-confidence')

describe('assessCoreCompleteness — 核心字段值完整性（审计 #1）', () => {
  const contract = { insured_name: '张三', effective_date: '2026-01-01' }
  const product = { product_name: '康宁', insurance_category: '重疾', sum_assured: '500000' }
  test('5 字段齐全 → 完整', () => {
    expect(assessCoreCompleteness(contract, [product])).toBe(true)
  })
  test('缺 1 字段（4/5 ≥ 80%）→ 完整', () => {
    expect(assessCoreCompleteness({ ...contract, insured_name: '' }, [product])).toBe(true)
  })
  test('缺 2 字段（3/5 < 80%）→ 不完整', () => {
    expect(assessCoreCompleteness({ ...contract, insured_name: '' }, [{ ...product, sum_assured: '' }])).toBe(false)
  })
  test('products 为空 → 不完整', () => {
    expect(assessCoreCompleteness(contract, [])).toBe(false)
  })
  test('多产品任一不达标 → 不完整', () => {
    expect(assessCoreCompleteness(contract, [product, { ...product, product_name: '', insurance_category: '' }])).toBe(false)
  })
})

describe('assessPolicy — 复核判定（0.9 阈值单一真相源）', () => {
  test('auto_confirmed 布尔权威优先', () => {
    expect(assessPolicy({ auto_confirmed: true, confidence: 0.5 })).toBe(false)
    expect(assessPolicy({ auto_confirmed: false, confidence: 0.99 })).toBe(true)
  })
  test('无 auto_confirmed：逐字段任一 < 0.9 → needsReview', () => {
    expect(assessPolicy({ field_confidence: { product_name: 0.95, sum_assured: 0.85 } })).toBe(true)
    expect(assessPolicy({ field_confidence: { product_name: 0.95, sum_assured: 0.95 } })).toBe(false)
  })
  test('无逐字段：整体 confidence 边界 0.9', () => {
    expect(assessPolicy({ confidence: 0.89 })).toBe(true)
    expect(assessPolicy({ confidence: 0.9 })).toBe(false)
  })
  test('空对象视为待核对（无置信度）', () => {
    expect(assessPolicy({})).toBe(true)
  })
})

describe('buildPolicyFromExtract', () => {
  const baseConf = { overallConf: 0.95, fieldConf: { product_name: 0.97 }, ocrReliable: true, autoConfirmed: false }

  const baseContract = {
    policy_number: 'P2026001',
    insurance_company: '中国人寿',
    contract_effective_date: '2026-01-01',
    policyholder_name: '张父',
    insured_name: '张三',
    beneficiary_name: '张母',
    special_agreement: '特别约定内容',
    insured_birth_date: '1990-05-05',
    policyholder_birth_date: '1965-03-03',
    beneficiary_birth_date: '1968-07-07'
  }

  const baseProduct = {
    product_name: '国寿福',
    insurance_category: '重疾',
    insurance_type: '终身',
    insurance_period: '终身',
    sum_assured: '500000',
    payment_method: '年缴',
    payment_period: '20年',
    annual_premium: '12000'
  }

  describe('字段映射', () => {
    test('完整字段映射：22 个核心字段 + 3 个 birth_date', () => {
      const policies = buildPolicyFromExtract([baseProduct], baseContract, baseConf)
      expect(policies).toHaveLength(1)
      const p = policies[0]
      // contract_basic 映射
      expect(p.policy_number).toBe('P2026001')
      expect(p.insurer).toBe('中国人寿')
      expect(p.effective_date).toBe('2026-01-01')
      expect(p.policyholder_name).toBe('张父')
      expect(p.insured_name).toBe('张三')
      expect(p.beneficiary_name).toBe('张母')
      expect(p.special_agreement).toBe('特别约定内容')
      // product 映射
      expect(p.product_name).toBe('国寿福')
      expect(p.insurance_type).toBe('终身')
      expect(p.insurance_period).toBe('终身')
      expect(p.payment_method).toBe('年缴')
      expect(p.payment_period).toBe('20年')
      // 数字清洗
      expect(p.sum_assured).toBe(500000)
      expect(p.annual_premium).toBe(12000)
      // 默认值
      expect(p.member_id).toBe('')
      // 置信度
      expect(p.confidence).toBe(0.95)
      expect(p.field_confidence).toEqual({ product_name: 0.97 })
      expect(p.confidence_source).toBe('ocr')
      expect(p.auto_confirmed).toBe(false)
      // birth_date 透传
      expect(p.insured_birth_date).toBe('1990-05-05')
      expect(p.policyholder_birth_date).toBe('1965-03-03')
      expect(p.beneficiary_birth_date).toBe('1968-07-07')
    })

    test('ID 格式：pol_<timestamp>_<random6>', () => {
      const policies = buildPolicyFromExtract([baseProduct], baseContract, baseConf)
      expect(policies[0].id).toMatch(/^pol_\d+_[a-z0-9]{6}$/)
    })

    test('autoConfirmed=true 但核心字段缺失 2 项 → auto_confirmed=false（审计 #1）', () => {
      const rich = { ...baseConf, autoConfirmed: true }
      // 缺 2 项（3/5 < 80%）→ 不自动确认
      const sparse = buildPolicyFromExtract([{ ...baseProduct, sum_assured: '', product_name: '' }], baseContract, rich)[0]
      expect(sparse.auto_confirmed).toBe(false)
      // 缺 1 项（4/5 ≥ 80%）→ 容错，仍自动确认
      const near = buildPolicyFromExtract([{ ...baseProduct, sum_assured: '' }], baseContract, rich)[0]
      expect(near.auto_confirmed).toBe(true)
      // 完整 → 自动确认
      const full = buildPolicyFromExtract([baseProduct], baseContract, rich)[0]
      expect(full.auto_confirmed).toBe(true)
    })

    test('每个 product 生成独立 ID', () => {
      const policies = buildPolicyFromExtract([baseProduct, { ...baseProduct, product_name: 'B' }], baseContract, baseConf)
      expect(policies).toHaveLength(2)
      expect(policies[0].id).not.toBe(policies[1].id)
    })
  })

  describe('canonCat 险种归一化', () => {
    test('重疾 → 重疾险', () => {
      const p = buildPolicyFromExtract([{ ...baseProduct, insurance_category: '重疾' }], baseContract, baseConf)[0]
      expect(p.insurance_category).toBe('重疾险')
    })
    test('医疗 → 医疗险', () => {
      const p = buildPolicyFromExtract([{ ...baseProduct, insurance_category: '医疗' }], baseContract, baseConf)[0]
      expect(p.insurance_category).toBe('医疗险')
    })
    test('意外 → 意外险', () => {
      const p = buildPolicyFromExtract([{ ...baseProduct, insurance_category: '意外' }], baseContract, baseConf)[0]
      expect(p.insurance_category).toBe('意外险')
    })
    test('空字符串 → 其他', () => {
      const p = buildPolicyFromExtract([{ ...baseProduct, insurance_category: '' }], baseContract, baseConf)[0]
      expect(p.insurance_category).toBe('其他')
    })
    test('null/undefined → 其他', () => {
      const p1 = buildPolicyFromExtract([{ ...baseProduct, insurance_category: null }], baseContract, baseConf)[0]
      const p2 = buildPolicyFromExtract([{ ...baseProduct, insurance_category: undefined }], baseContract, baseConf)[0]
      expect(p1.insurance_category).toBe('其他')
      expect(p2.insurance_category).toBe('其他')
    })
    test('未知类目原样返回', () => {
      const p = buildPolicyFromExtract([{ ...baseProduct, insurance_category: '万能险' }], baseContract, baseConf)[0]
      expect(p.insurance_category).toBe('万能险')
    })
  })

  describe('_toNum 数字清洗', () => {
    test('纯数字字符串 → number', () => {
      expect(_toNum('12345')).toBe(12345)
    })
    test('含非数字字符过滤', () => {
      expect(_toNum('500,000元')).toBe(500000)
      expect(_toNum('12,345.67')).toBeCloseTo(12345.67, 2)
    })
    test('null/undefined → 0', () => {
      expect(_toNum(null)).toBe(0)
      expect(_toNum(undefined)).toBe(0)
    })
    test('纯非数字 → 0', () => {
      expect(_toNum('abc')).toBe(0)
    })
    test('number 透传', () => {
      expect(_toNum(42)).toBe(42)
    })
  })

  describe('置信度来源', () => {
    test('ocrReliable=true → confidence_source="ocr"', () => {
      const p = buildPolicyFromExtract([baseProduct], baseContract, { ...baseConf, ocrReliable: true })[0]
      expect(p.confidence_source).toBe('ocr')
    })
    test('ocrReliable=false → confidence_source="ai"', () => {
      const p = buildPolicyFromExtract([baseProduct], baseContract, { ...baseConf, ocrReliable: false })[0]
      expect(p.confidence_source).toBe('ai')
    })
    test('autoConfirmed 透传', () => {
      const p1 = buildPolicyFromExtract([baseProduct], baseContract, { ...baseConf, autoConfirmed: true })[0]
      const p2 = buildPolicyFromExtract([baseProduct], baseContract, { ...baseConf, autoConfirmed: false })[0]
      expect(p1.auto_confirmed).toBe(true)
      expect(p2.auto_confirmed).toBe(false)
    })
  })

  describe('空输入与缺失字段', () => {
    test('products 为空数组 → 返回空数组', () => {
      expect(buildPolicyFromExtract([], baseContract, baseConf)).toEqual([])
    })
    test('products 为 null/undefined → 返回空数组', () => {
      expect(buildPolicyFromExtract(null, baseContract, baseConf)).toEqual([])
      expect(buildPolicyFromExtract(undefined, baseContract, baseConf)).toEqual([])
    })
    test('contractBasic 缺失字段使用空串兜底', () => {
      const p = buildPolicyFromExtract([baseProduct], {}, baseConf)[0]
      expect(p.policy_number).toBe('')
      expect(p.insurer).toBe('')
      expect(p.effective_date).toBe('')
      expect(p.insured_birth_date).toBe('')
    })
    test('birth_date 格式校验：非 YYYY-MM-DD 清空（防身份证号误存为生日）', () => {
      const bad = { ...baseContract, insured_birth_date: '110101199001011234', policyholder_birth_date: '1990年1月', beneficiary_birth_date: '1990-05-05' }
      const p = buildPolicyFromExtract([baseProduct], bad, baseConf)[0]
      expect(p.insured_birth_date).toBe('') // 身份证号 → 清空
      expect(p.policyholder_birth_date).toBe('') // 非规范日期 → 清空
      expect(p.beneficiary_birth_date).toBe('1990-05-05') // 合法日期透传
    })
    test('birth_date 空白/undefined 兜底空串', () => {
      const p = buildPolicyFromExtract([baseProduct], { ...baseContract, insured_birth_date: '  ' }, baseConf)[0]
      expect(p.insured_birth_date).toBe('')
    })
    test('product 缺失字段：sum_assured/annual_premium 兜底 0', () => {
      const p = buildPolicyFromExtract([{}], baseContract, baseConf)[0]
      expect(p.sum_assured).toBe(0)
      expect(p.annual_premium).toBe(0)
      expect(p.product_name).toBe('')
    })
  })
})
