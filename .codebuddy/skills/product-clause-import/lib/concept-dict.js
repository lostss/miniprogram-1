/**
 * concept-dict.js — 条款概念字典 v1（产品条款导入 skill）
 *
 * AI 按此概念清单从任意格式条款中定位填充；未找到输出 null 不编造。
 * 新险种/新概念：unrecognized 上报 → 人工补录 → schema_version 递增（旧档按版本读取、缺失回 null）。
 */
const CONCEPT_DICT = {
  schema_version: 1,
  categories: {
    critical_illness: {
      label: '重大疾病保险',
      concepts: {
        disease_count: '重疾种类数（种）',
        minor_illness: '轻症责任（有/无）',
        medium_illness: '中症责任（有/无）',
        special_disease_extra: '特定疾病额外赔付（比例）',
        cancer_extra: '恶性肿瘤-重度额外赔付（比例）',
        premium_waiver: '保费豁免（投保人/被保人）',
        waiting_period: '等待期（天）',
        cash_value: '现金价值（有/无）',
        death_benefit: '身故责任（有/无）'
      }
    },
    medical: {
      label: '医疗保险',
      concepts: {
        deductible: '免赔额（元）',
        reimbursement_ratio: '报销比例',
        annual_limit: '年度限额（元）',
        cancer_drug: '特药/院外购药责任（有/无）',
        hospital_scope: '医院范围',
        outpatient: '门诊责任（有/无）',
        waiting_period: '等待期（天）',
        renewal: '续保条款（保证续保年限/不保证）',
        special_services: '增值服务（绿通/垫付/二次诊疗等）'
      }
    },
    life: {
      label: '人寿保险',
      concepts: {
        term: '保险期间',
        waiting_period: '等待期（天）',
        death_benefit: '身故责任',
        total_disability: '全残责任（有/无）',
        cash_value: '现金价值（有/无）',
        dividend: '分红/万能账户（有/无）',
        special_services: '增值服务'
      }
    },
    accident: {
      label: '意外伤害保险',
      concepts: {
        accident_death: '意外身故保额（元）',
        accident_disability: '意外伤残保额/给付比例',
        accident_medical: '意外医疗（额度/免赔）',
        daily_allowance: '住院津贴（元/天）',
        aviation_extra: '航空意外额外赔付',
        public_transport: '公共交通意外额外赔付'
      }
    }
  }
}

module.exports = { CONCEPT_DICT }
