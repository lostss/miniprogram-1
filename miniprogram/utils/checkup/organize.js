/**
 * checkup/organize.js — 「保单整理报告」视图组装（探索版 · MVP 内测，纯函数）
 *
 * 定位：把散落的保单整理成能逐条核对的清单（代理人与客户**同看**）。
 * 三条红线决定本模块只做三件事——**归集 / 汇总 / 标注**：
 *   ① 只出结果不出建议：不做缺口、不做优先级、不写评语
 *   ② 不加形容词：只写「有什么 + 值」
 *   ③ 不确定就标出来不猜：缺字段、低置信、被保人未匹配，一律进 pending，不推断归属
 *
 * 输入形状与 `getFamily`（owner 读路径）对齐：family 文档 + family.members + family.policies。
 * 输出是纯数据视图模型：**只含白名单字段**，不含 `_openid`、不含内部工作线索
 * （memo / deal_status / soft_profile 等一律不带出去），使客户版可复用同一份数据。
 *
 * 金额契约（`amount.js`）：DB 存「元」，展示 ≥1 万转「x.x 万」。
 */
const { fmtYuan } = require('../amount')
const { STATUS_LABELS, isOneYearPolicy } = require('../policy-status')
const { OCR_RELIABLE_THRESHOLD, CORE_FIELDS } = require('../ocr-confidence')

const DASH = '—'

// 展示顺序固定，避免同一份数据两次渲染顺序不同（同看时"刚才那张"要对得上）
const CATEGORY_ORDER = ['寿险', '重疾险', '医疗险', '意外险', '年金险']
const CATEGORY_OTHER = '其他'

// 整理报告需要的"关键字段"= OCR 核心字段 + 报告必需的期间/保费。
// 刻意**不复制** CORE_FIELDS 的内容，只在其上追加；`tests/checkup-organize.test.js`
// 断言本清单恒为 CORE_FIELDS 的超集 —— CORE_FIELDS 增项而此处漏跟会直接变红。
const EXTRA_REQUIRED_FIELDS = ['insurance_period', 'annual_premium']
const REPORT_REQUIRED_FIELDS = CORE_FIELDS.concat(EXTRA_REQUIRED_FIELDS)
const FIELD_ZH = {
  product_name: '产品名', insurance_category: '险种', insured_name: '被保人',
  sum_assured: '保额', effective_date: '生效日', insurance_period: '保障期间', annual_premium: '年缴保费'
}

const _num = (v) => Number(v) || 0
const _str = (v) => (v === null || v === undefined ? '' : String(v))

/** 保单级：有值但置信度低于可靠阈值的字段（字段未出现时本就不进 field_confidence，故无需区分） */
function lowConfidenceFields(policy) {
  const fc = (policy && policy.field_confidence) || {}
  return Object.keys(fc).filter((k) => _num(fc[k]) < OCR_RELIABLE_THRESHOLD)
}

/** 保单级：关键字段为空（保额按 0 视为空） */
function missingRequiredFields(policy) {
  const p = policy || {}
  return REPORT_REQUIRED_FIELDS.filter((k) => {
    if (k === 'sum_assured' || k === 'annual_premium') return _num(p[k]) <= 0
    return _str(p[k]) === ''
  })
}

/** 保单卡：只保留展示所需字段 */
function toPolicyCard(p) {
  const low = lowConfidenceFields(p)
  return {
    id: _str(p.id || p._id),
    productName: _str(p.product_name) || DASH,
    category: _str(p.insurance_category) || '未分类',
    type: _str(p.insurance_type),
    insuredName: _str(p.insured_name) || DASH,
    sumAssured: _num(p.sum_assured),
    sumAssuredText: fmtYuan(_num(p.sum_assured)),
    annualPremium: _num(p.annual_premium),
    annualPremiumText: fmtYuan(_num(p.annual_premium)),
    paymentMethod: _str(p.payment_method),
    period: _str(p.insurance_period) || DASH,
    effectiveDate: _str(p.contract_effective_date || p.effective_date) || DASH,
    status: _str(p.status),
    statusLabel: STATUS_LABELS[p.status] || _str(p.status) || DASH,
    shortTerm: !!isOneYearPolicy(p),
    lowConfidence: low.length > 0,
    lowConfidenceFields: low
  }
}

function _categoryList(policies) {
  const set = {}
  policies.forEach((p) => { set[_str(p.insurance_category) || CATEGORY_OTHER] = true })
  const known = CATEGORY_ORDER.filter((c) => set[c])
  const unknown = Object.keys(set).filter((c) => CATEGORY_ORDER.indexOf(c) === -1).sort()
  return known.concat(unknown)
}

function _pickFamilyName(family) {
  return _str(family.family_name || family.name) || DASH
}

/**
 * 组装整理报告视图模型。
 *
 * @param {object} input
 *   - family   getFamily 返回的 family 文档（可含 members / policies）
 *   - members  显式覆盖（缺省取 family.members）
 *   - policies 显式覆盖（缺省取 family.policies）
 *   - now      保留字段（本轮不做时间维计算，留作后续到期标注）
 * @returns {{header, summary, groups, unassigned, pending}}
 */
function buildCheckupReport(input) {
  const src = input || {}
  const family = src.family || {}
  const members = (src.members || family.members || []).filter((m) => m && m.status !== 'deleted')
  const policies = (src.policies || family.policies || []).filter((p) => p && p.status !== 'deleted')

  // 归属：member_id 优先；无 member_id 才按被保人姓名精确匹配（与保单入库口径一致）
  const byId = {}
  const byName = {}
  members.forEach((m) => {
    if (m.member_id) byId[m.member_id] = m
    if (m.name) byName[_str(m.name)] = m
  })
  const buckets = {}
  const unassigned = []
  policies.forEach((p) => {
    const hit = (p.member_id && byId[p.member_id]) || byName[_str(p.insured_name)]
    if (!hit) { unassigned.push(toPolicyCard(p)); return }
    const key = _str(hit.member_id || hit._id || hit.name)
    if (!buckets[key]) buckets[key] = { member: hit, policies: [] }
    buckets[key].policies.push(toPolicyCard(p))
  })

  // 成员表：含**无保单成员**（"一张保单都没有的人"在纯 OCR 数据里根本不存在，而它恰是最该被看见的事实）
  const groups = members.map((m) => {
    const key = _str(m.member_id || m._id || m.name)
    const bucket = buckets[key] || { policies: [] }
    return {
      memberId: _str(m.member_id || m._id),
      name: _str(m.name) || DASH,
      role: _str(m.role),
      age: _str(m.age),
      birthDate: _str(m.birth_date),
      source: bucket.policies.length > 0 ? '来自保单' : '代理人补充',
      policyCount: bucket.policies.length,
      sumAssured: bucket.policies.reduce((s, c) => s + c.sumAssured, 0),
      sumAssuredText: fmtYuan(bucket.policies.reduce((s, c) => s + c.sumAssured, 0)),
      policies: bucket.policies
    }
  })
  // 成员名单外的桶（保单挂了 member_id 但成员已被软删等极端情形）→ 不静默丢弃
  Object.keys(buckets).forEach((k) => {
    if (!groups.some((g) => _str(g.memberId) === k || _str(g.name) === k)) {
      buckets[k].policies.forEach((c) => unassigned.push(c))
    }
  })

  const shortTerm = policies.filter(isOneYearPolicy)
  const totalSumAssured = policies.reduce((s, p) => s + _num(p.sum_assured), 0)
  const summary = {
    policyCount: policies.length,
    memberCount: members.length,
    totalSumAssured,
    totalSumAssuredText: fmtYuan(totalSumAssured),
    shortTermCount: shortTerm.length,
    shortTermSumAssured: shortTerm.reduce((s, p) => s + _num(p.sum_assured), 0),
    shortTermSumAssuredText: fmtYuan(shortTerm.reduce((s, p) => s + _num(p.sum_assured), 0)),
    annualPremium: policies.reduce((s, p) => s + _num(p.annual_premium), 0),
    annualPremiumText: fmtYuan(policies.reduce((s, p) => s + _num(p.annual_premium), 0)),
    // 只列**已覆盖**险种（不写"缺什么"——那需要一个"应有清单"，属建议）
    categories: _categoryList(policies),
    membersWithoutPolicy: groups.filter((g) => g.policyCount === 0).map((g) => g.name)
  }

  // 待完善：缺字段 / 低置信 / 未匹配（逐条可定位到具体保单）
  const pending = []
  policies.forEach((p) => {
    const card = toPolicyCard(p)
    const missing = missingRequiredFields(p)
    if (missing.length) {
      pending.push({ kind: 'missing_field', policyId: card.id, productName: card.productName, detail: '缺：' + missing.map((k) => FIELD_ZH[k] || k).join('、') })
    }
    if (card.lowConfidenceFields.length) {
      pending.push({ kind: 'low_confidence', policyId: card.id, productName: card.productName, detail: '待核对：' + card.lowConfidenceFields.map((k) => FIELD_ZH[k] || k).join('、') })
    }
  })
  unassigned.forEach((c) => {
    pending.push({ kind: 'unassigned', policyId: c.id, productName: c.productName, detail: '被保人「' + c.insuredName + '」不在成员名单，未归入任何成员' })
  })

  return {
    header: {
      familyName: _pickFamilyName(family),
      memberCount: members.length,
      policyCount: policies.length,
      dataAt: _str(src.dataAt || family.updated_at || family.last_analysis_at || '')
    },
    summary,
    groups,
    unassigned,
    pending
  }
}

module.exports = {
  buildCheckupReport,
  toPolicyCard,
  lowConfidenceFields,
  missingRequiredFields,
  REPORT_REQUIRED_FIELDS,
  CATEGORY_ORDER
}
