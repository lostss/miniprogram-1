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

  const expiry = parseExpiry(period, eff, age)

  // 判断是否过期
  if (expiry.year !== null) {
    // 有精确到期日则按日期比较（修复当年内已过期却误判 active）
    if (expiry.date && expiry.date < now) {
      return { status: 'expired', expiryInfo: _fmtDate(expiry.date), expiry_year: expiry.year }
    }
    // 仅有年份信息时降级为年份比较
    if (!expiry.date && expiry.year < thisYear) {
      return { status: 'expired', expiryInfo: expiry.year + '年到期', expiry_year: expiry.year }
    }
    // 一年期保单可能已跨年过期
    if (period === '1年' || /^1\s*年/.test(period)) {
      const effDate = new Date(eff)
      if (!isNaN(effDate.getTime())) {
        const oneYearLater = new Date(effDate)
        oneYearLater.setFullYear(oneYearLater.getFullYear() + 1)
        if (oneYearLater < now) {
          return { status: 'expired', expiryInfo: '1年期已过期', expiry_year: expiry.year }
        }
      }
    }
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
  // 已有终态 → 不动；unknown 需重算（数据补齐后可能从 unknown → active/expired）
  if (policy.status && policy.status !== 'unknown' && ['active', 'expired', 'suspicious', 'cancelled'].includes(policy.status)) {
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

module.exports = { parseExpiry, calcStatus, ensureStatus, ensureStatusBatch }
