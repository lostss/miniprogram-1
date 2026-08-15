/**
 * policy-status.js — 保单状态自动计算
 *
 * 设计原则：
 * - 纯函数，无副作用，可单元测试
 * - 入库/聚合/报告均可复用
 * - 存量保单无 status 字段时降级推断（不写回 DB）
 *
 * parseExpiry 由 parse-expiry.js 提供（前后端共用权威源），此处 re-export 保持向后兼容。
 */
const { parseExpiry } = require('./parse-expiry')

// 保单生命周期状态（与 dataWrite/policy-write.js 的变更白名单保持同构）
const STATUS_LABELS = {
  active: '有效',
  lapsed: '失效',
  surrendered: '退保',
  claim_terminated: '理赔终止',
  expired: '到期终止',
  cancelled: '退保',
  suspicious: '数据异常',
  deleted: '已删除',
  unknown: '未知'
}

// 手动终止状态：用户/业务员显式设置，系统自动判断不得覆盖
const MANUAL_STATUSES = ['lapsed', 'surrendered', 'claim_terminated', 'cancelled']

// 系统自动判断的终止状态
const AUTO_STATUSES = ['expired']

// 所有已知状态（含 active/expired/手动态）。ensureStatus 尊重全部显式状态，不做重算
const KNOWN_STATUSES = ['active', 'expired', 'suspicious', 'deleted', ...MANUAL_STATUSES]


function _fmtDate(d) {
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + '到期'
}

/**
 * 计算保单状态
 * @param {object} policy - 保单对象 { effective_date, insurance_period, payment_period, insured_age }
 * @returns {{ status: string, expiry_date: string|null }}
 */
function calcStatus(policy) {
  const now = new Date()
  const thisYear = now.getFullYear()
  const eff = policy.contract_effective_date || policy.effective_date || ''
  const age = policy.insured_age || 0
  const period = policy.insurance_period || ''

  // 先检查异常数据
  if ((!policy.sum_assured || policy.sum_assured === 0) && policy.annual_premium > 0) {
    return { status: 'suspicious', expiryInfo: '保额=0但保费>0', expiry_year: null }
  }

  // 用户决策：自动到期判断只对一年期以上产品生效，排除一年期产品
  //（一年期通常为灵活续保/保证续保，不因生效满一年自动判 expired；有明确到期日时由 OCR/表单 coverage_term 承载）
  if (period === '1年' || /^1\s*年/.test(period)) {
    return { status: 'active', expiryInfo: '一年期', expiry_year: null }
  }

  const expiry = parseExpiry(period, eff, age)

  // 判断是否过期
  if (expiry.year !== null) {
    // 有精确到期日则按日期比较
    if (expiry.date && expiry.date < now) {
      return { status: 'expired', expiryInfo: _fmtDate(expiry.date), expiry_year: expiry.year }
    }
    // 仅有年份信息时降级为年份比较
    if (!expiry.date && expiry.year < thisYear) {
      return { status: 'expired', expiryInfo: expiry.year + '年到期', expiry_year: expiry.year }
    }
    // 一年期产品通常为保证续保，不因生效满一年自动判定到期；
    // 若 OCR/表单有明确到期日，会走上面的精确日期判断。
    return { status: 'active', expiryInfo: expiry.label, expiry_year: expiry.year }
  }

  // 无法判断的标记为 unknown
  if (period && expiry.year === null) {
    return { status: 'unknown', expiryInfo: period, expiry_year: null }
  }

  return { status: 'active', expiryInfo: '--', expiry_year: null }
}


/**
 * 确保保单有 status 字段（存量兼容）
 * 已有 status → 不动；无 status → 推断但不写回 DB
 * @param {object} policy
 * @returns {object} 带 status 的保单
 */
function ensureStatus(policy) {
  // 已有显式状态（含 active/手动态/expired）→ 尊重，不重算。
  // 与写入层设计一致：writePolicy 录入即判定状态、updatePolicy 手动变更是用户明确意图，
  // 读取层不覆盖（否则"手动恢复有效"会被立即重算为 expired——读取层自动纠正与写入层显式落库矛盾）。
  // 仅无 status 或 unknown（存量兼容）时按期限推断。
  if (policy.status && policy.status !== 'unknown' && KNOWN_STATUSES.includes(policy.status)) {
    return policy
  }
  const { status, expiryInfo } = calcStatus(policy)
  policy.status = status
  policy._expiryInfo = expiryInfo
  return policy
}

/**
 * 批量确保状态（轻量，不写 DB）
 * @param {array} policies
 * @returns {array}
 */
function ensureStatusBatch(policies) {
  return (policies || []).map(p => ensureStatus(p))
}

// 架构审计第 16 轮候选 #1：filterActive / getExpired 删除（grep 全代码库 0 调用方，伪共享残留）
// 如需"仅取 active"语义，调用方应在自身业务逻辑中过滤，或未来在 policy-read.js 加 onlyActive 选项

module.exports = {
  parseExpiry,
  calcStatus,
  ensureStatus,
  ensureStatusBatch,
  STATUS_LABELS,
  MANUAL_STATUSES,
  AUTO_STATUSES,
  KNOWN_STATUSES
}
