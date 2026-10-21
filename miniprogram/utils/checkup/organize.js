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
// 保额按保障类型拆分（2026-10-14）：跨树契约，与 AI 摘要卡 / PDF 保障摘要同源
const { summarizeCoverage } = require('../coverage-summary')
// 险种规范词（跨树契约）：'医疗'→'医疗险'、'年金险'→'年金' 等归一一处（勿在本文件另立映射）
const { canonCat } = require('../thresholds')
const { OCR_RELIABLE_THRESHOLD, CORE_FIELDS } = require('../ocr-confidence')
// 跨树契约：骨架成员判定（建档按人数造的「成员N」占位）——与后端认领判定同源，勿自写第二份正则
const { isSkeletonName } = require('../member-skeleton')
// 附加险归属（2026-10-21）：项目按产品入库 → 主险/附加险是两条文档，报告侧需要关系
const { linkRiders } = require('../rider-link')

const DASH = '—'

// 展示顺序固定，避免同一份数据两次渲染顺序不同（同看时"刚才那张"要对得上）
// 规范词（与 thresholds.CANON_CAT 同口径）——原末位写作 '年金险' 非规范词，
// 而契约把 '年金险' 映射为 '年金'（见 cloudfunctions/_shared/thresholds.js 注释"规范词定为 '年金'"）
const CATEGORY_ORDER = ['寿险', '重疾险', '医疗险', '意外险', '年金']
const CATEGORY_OTHER = '其他'

// 整理报告需要的"关键字段"= OCR 核心字段 + 报告必需的期间/保费。
// 刻意**不复制** CORE_FIELDS 的内容，只在其上追加；`tests/checkup-organize.test.js`
// 断言本清单恒为 CORE_FIELDS 的超集 —— CORE_FIELDS 增项而此处漏跟会直接变红。
// 2026-10-18：补 payment_period（缴费期间）。它虽只用于展示，却是**甘特图缴费期斜纹段**与
// 时间线「交费期满」节点的输入 —— 缺了不会报错，只会静默画少一段，用户分不清是"没读到"还是"本来就趸交"。
const EXTRA_REQUIRED_FIELDS = ['insurance_period', 'payment_period', 'annual_premium']
const REPORT_REQUIRED_FIELDS = CORE_FIELDS.concat(EXTRA_REQUIRED_FIELDS)
const FIELD_ZH = {
  product_name: '产品名', insurance_category: '险种', insured_name: '被保人',
  sum_assured: '保额', effective_date: '生效日', insurance_period: '保障期间',
  payment_period: '缴费期间', annual_premium: '年缴保费'
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
    // 2026-10-18：一年期产品的缴费期间天然是「一次性」（见 chapter-builder._payTermText），
    // 没填 payment_period 不是缺失 → 否则每张百万医疗都会被标"缺缴费期间"，待完善直接变噪音。
    if (k === 'payment_period' && _isOneYearPolicy(p)) return false
    return _str(p[k]) === ''
  })
}

// 一年期判定（与 chapter-builder._isOneYear / policy-terms 同口径）：
// insurance_period 以「1年/一年」开头，或 coverage_term === 1
function _isOneYearPolicy(p) {
  if (/^(1|一)年/.test(String((p && p.insurance_period) || '').trim())) return true
  const ct = p && p.coverage_term
  return ct === 1 || ct === '1'
}

// 年缴口径白名单：只有这些缴费方式下，`annual_premium` 才能当"年缴金额"读。
// 月交/季交/半年交的该字段是否已年化**未经验证**（OCR 提示词只要求"数字+单位元"，无 ×12 规则），
// 故一律不换算、不改写，只把缴费方式摆在旁边并在 pending 里标出（红线 3：不确定就标出来不猜）。
const ANNUAL_METHODS = ['', '年交', '趸交']

/** 保单卡：只保留展示所需字段 */
function toPolicyCard(p) {
  const low = lowConfidenceFields(p)
  const method = _str(p.payment_method)
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
    paymentMethod: method,
    // 非年交保单不许把该字段写成"年缴保费"
    premiumLabel: ANNUAL_METHODS.indexOf(method) !== -1 ? '年缴保费' : '每期保费（' + method + '）',
    premiumIsAnnual: ANNUAL_METHODS.indexOf(method) !== -1,
    period: _str(p.insurance_period) || DASH,
    effectiveDate: _str(p.contract_effective_date || p.effective_date) || DASH,
    status: _str(p.status),
    statusLabel: STATUS_LABELS[p.status] || _str(p.status) || DASH,
    shortTerm: !!isOneYearPolicy(p),
    lowConfidence: low.length > 0,
    lowConfidenceFields: low,
    // 2026-10-21：附加险归属（由 linkRiders 注入）—— 明细据此缩进，份数据此不重复计
    isRider: !!p.isRider,
    parentKey: _str(p.parentKey),
    riderCount: _num(p.riderCount),
    riderUnlinked: !!p.riderUnlinked
    }
}

function _categoryList(policies) {
  const set = {}
  // 2026-10-14：改走契约 canonCat（原实现按原始串精确匹配）——
  // 保单里可能存裸词（'医疗'）或反向拼写（'年金险'，契约规范词是 '年金'），
  // 精确匹配会让它们掉进 unknown 分支：虽仍展示，但排在末尾、且与矩阵列名不一致
  //（真机截图里「已覆盖险种」写"年金"、矩阵列头也是"年金"，两处本应同词）。
  policies.forEach((p) => { set[canonCat(_str(p.insurance_category)) || CATEGORY_OTHER] = true })
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
  // 2026-10-18（审计 P0-2 修复）：**整理报告的每个数字都只算有效保单**。
  // 原实现只排除 deleted → 「张数 / 年缴保费 / 已覆盖险种 / 成员保额」把失效、退保、理赔终止
  // 的保单也算进去，而同一张卡的「保额构成」走 coverage-summary（只算 active）→ 同卡四个数字口径不一。
  // 实测：1 张有效重疾 30 万 + 1 张退保寿险 100 万 → 卡上写「2 张 / 6 万 / 已覆盖寿险+重疾」，
  // 而保额只有 30 万、成员行却写 130 万。
  // 失效/退保单不丢：`inactiveCount` 在卡上单列一行，明细仍在文末附录（附录本就显示全部并带状态标签）。
  const allPolicies = (src.policies || family.policies || []).filter((p) => p && p.status !== 'deleted')
  // 2026-10-21：附加险归属。项目按产品入库（同保单号的主险/附加险是两条文档），
  // 报告侧需要"份数按主险计 + 明细缩进挂主险"，关系在这里推断一次（见 utils/rider-link.js），
  // 不落库、不改数据模型。失效保单也参与关联（同一张保单的主险失效时附加险通常一起失效）。
  const linkedAll = linkRiders(allPolicies)
  const policies = linkedAll.items.filter((p) => p.status === 'active')
  const inactiveCount = linkedAll.items.length - policies.length
  const mainCount = policies.filter((p) => !p.isRider).length
  const riderCount = policies.filter((p) => p.isRider && p.parentKey).length
  const unlinkedRiderCount = policies.filter((p) => p.isRider && !p.parentKey).length

  // 归属：member_id 优先；无 member_id 才按被保人姓名精确匹配（与保单入库口径一致）
  const byId = {}
  const byName = {}
  members.forEach((m) => {
    if (m.member_id) byId[m.member_id] = m
    if (m.name) byName[_str(m.name)] = m
  })
  // 失效/退保按成员计数（成员卡片要写"另有失效 N 份"，但统计本身只算 active）
  const inactiveByMember = {}
  ;(linkedAll.items || []).forEach((p) => {
    if (!p || p.status === 'active') return
    const hit = (p.member_id && byId[p.member_id]) || byName[_str(p.insured_name)]
    if (!hit) return
    const k = _str(hit.member_id || hit._id || hit.name)
    inactiveByMember[k] = (inactiveByMember[k] || 0) + 1
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
    // 建档时按"人数"造的骨架占位（名字形如「成员1」）——必须可辨识，否则会污染"无保单成员"这个信任点。
    // 判定走跨树契约（与后端认领同一规则），不自己写正则。
    const placeholder = isSkeletonName(m.name)
    return {
      memberId: _str(m.member_id || m._id),
      // 展示名：骨架占位与"历史空名成员"都显示为待补，避免出现空白行（空名已不再产生，仅作兜底）
      name: placeholder || !_str(m.name) ? '待补姓名' : _str(m.name),
      skeletonName: _str(m.name),
      placeholder,
      role: _str(m.role),
      age: _str(m.age),
      birthDate: _str(m.birth_date),
      source: placeholder ? '待补信息' : (bucket.policies.length > 0 ? '来自保单' : '代理人补充'),
      // 2026-10-21：份数按**主险**计（附加险不增份数），另给附加险数；
      // 保额仍含附加险（那是真实保障，且按自身险种归列）。
      policyCount: bucket.policies.filter((c) => !c.isRider).length,
      riderCount: bucket.policies.filter((c) => c.isRider).length,
      // 2026-10-21：该成员名下失效/退保的保单数（方案「成员卡片」要求注明"失效 N 份，见 A1"）
      inactiveCount: (inactiveByMember[_str(m.member_id || m._id || m.name)] || 0),
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
  // 2026-10-14 用户决策：**不再展示单一"保额合计"**，按保障类型拆分。
  // 这里（整理报告正文的汇总卡）是最容易被忽略的一处复现点 —— 线上实测的"保额合计 2310万"
  // 里 2010万 是一年期短期报销限额，客户会当成"能拿到手的钱"。
  // 聚合走跨树契约 coverage-summary.js（与 AI 摘要卡 / PDF 保障摘要同源），不再自行 reduce。
  const cov = summarizeCoverage(policies)
  const totalSumAssured = cov.totalW * 10000 // 仅供内部核对；**不再对外展示**
  // 合计里混入了非年交保单 → 金额口径不齐，必须提示（不静默相加）
  const nonAnnualCount = policies.filter((p) => ANNUAL_METHODS.indexOf(_str(p.payment_method)) === -1).length
  const summary = {
    // 只统计 active（见上方 allPolicies / policies 的说明）；
    // 2026-10-21：份数按**主险**计 —— 同一张保单的附加险不额外算一份（它们本来就是同一份合同）。
    policyCount: mainCount,
    // 已归入主险的附加险项数（"含 N 项附加险"），以及没能关联的附加险（进待完善）
    riderCount,
    unlinkedRiderCount,
    memberCount: members.length,
    // 失效 / 退保 / 理赔终止：不计入任何统计，但必须让用户知道它们存在
    inactiveCount,
    inactiveNote: inactiveCount > 0
      ? '另有 ' + inactiveCount + ' 张失效 / 退保保单，未计入上述统计（明细见文末附录）'
      : '',
    nonAnnualCount,
    premiumNote: nonAnnualCount > 0
      ? '其中 ' + nonAnnualCount + ' 张非年交保单的保费未年化，仅按期缴金额列出'
      : '',
    totalSumAssured,
    totalSumAssuredText: fmtYuan(totalSumAssured),
    // 按保障类型拆分（展示用）：保障型为主数字，储蓄型/未标注分列，分险种明细给 tag
    protectionSumAssured: cov.protectionW * 10000,
    protectionSumAssuredText: fmtYuan(cov.protectionW * 10000),
    // 2026-10-17：按**险种**分两组（不再给"合计"——报销上限与给付金额相加无意义）
    //   给付型 = 寿险 + 重疾；报销/意外额度 = 医疗 + 意外。两者相加 === protectionW。
    payoutSumAssured: cov.payoutW * 10000,
    payoutSumAssuredText: fmtYuan(cov.payoutW * 10000),
    quotaSumAssured: cov.quotaW * 10000,
    quotaSumAssuredText: fmtYuan(cov.quotaW * 10000),
    savingsSumAssuredText: cov.savingsW > 0 ? fmtYuan(cov.savingsW * 10000) : '',
    unknownSumAssuredText: cov.unknownW > 0 ? fmtYuan(cov.unknownW * 10000) : '',
    coverageByCat: cov.byCat.map(function (x) {
      return { cat: x.cat, text: fmtYuan(x.w * 10000), kind: x.kind }
    }),
    shortTermCount: shortTerm.length,
    shortTermSumAssured: shortTerm.reduce((s, p) => s + _num(p.sum_assured), 0),
    shortTermSumAssuredText: fmtYuan(shortTerm.reduce((s, p) => s + _num(p.sum_assured), 0)),
    annualPremium: policies.reduce((s, p) => s + _num(p.annual_premium), 0),
    annualPremiumText: fmtYuan(policies.reduce((s, p) => s + _num(p.annual_premium), 0)),
    // 只列**已覆盖**险种（不写"缺什么"——那需要一个"应有清单"，属建议）
    categories: _categoryList(policies),
    // 只统计**已知姓名**且无保单的成员：占位成员（建档时按人数造的）不算"没保障的人"，
    // 否则"配偶完全没保障"这个信任点会被一排"待补姓名"稀释掉
    membersWithoutPolicy: groups.filter((g) => g.policyCount === 0 && !g.placeholder).map((g) => g.name),
    placeholderCount: groups.filter((g) => g.placeholder).length,
    memberNote: (function () {
      const n = groups.filter((g) => g.placeholder).length
      return n > 0 ? '另有 ' + n + ' 位成员待补姓名与角色' : ''
    })()
  }

  // 待完善：缺字段 / 低置信 / 未匹配（逐条可定位到具体保单）
  // 2026-10-17：改为**按保单聚合**。原实现按"问题"平铺 —— 同一张保单缺字段 + 缴费未年化
  // 会占两行（真机截图里"附加住院补贴A款""卓越优选"各出现两次，用户读成重复条目，
  // 且第 6 条文案被挤断）。现在一张保单一行，下面挂它自己的全部问题点。
  const pendingMap = {}
  const pushPending = (policyId, productName, kind, detail) => {
    const key = policyId || productName
    if (!pendingMap[key]) pendingMap[key] = { policyId: policyId || '', productName: productName || '', kinds: [], details: [] }
    pendingMap[key].kinds.push(kind)
    pendingMap[key].details.push(detail)
  }
  policies.forEach((p) => {
    const card = toPolicyCard(p)
    const missing = missingRequiredFields(p)
    if (missing.length) {
      pushPending(card.id, card.productName, 'missing_field', '缺：' + missing.map((k) => FIELD_ZH[k] || k).join('、'))
    }
    if (card.lowConfidenceFields.length) {
      pushPending(card.id, card.productName, 'low_confidence', '待核对：' + card.lowConfidenceFields.map((k) => FIELD_ZH[k] || k).join('、'))
    }
    if (!card.premiumIsAnnual) {
      pushPending(card.id, card.productName, 'premium_basis', '缴费方式为「' + card.paymentMethod + '」，该金额是每期保费、未年化，需核对')
    }
  })
  unassigned.forEach((c) => {
    pushPending(c.id, c.productName, 'unassigned', '被保人「' + c.insuredName + '」不在成员名单，未归入任何成员')
  })
  // 2026-10-21：附加险未能关联主险 —— 大多数是缺保单号。
  // 不静默（明细里它会显示成独立一条，用户会问"为什么份数和明细对不上"）。
  policies.filter((c) => c.isRider && !c.parentKey).forEach((c) => {
    pushPending(c.id, c.productName, 'rider_unlinked', '疑似主险的附加险，但缺保单号无法关联（份数已按独立一 份计）')
  })
  const pending = Object.keys(pendingMap).map((k) => pendingMap[k])

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
