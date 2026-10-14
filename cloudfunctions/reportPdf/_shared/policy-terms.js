/**
 * policy-terms.js — 保障期 / 缴费期的**双字段口径**（跨树契约）
 *
 * 为什么需要这个文件：`insurance_period`（OCR 文本）与 `coverage_term`（对话录入数字，105=终身）
 * 是同一事实的两种表示，`payment_period` / `premium_term` 同理。这条规则此前**散落三处**：
 *   - `miniprogram/utils/report/timeline-builder.js`（`_coverTermYear/_payTermYear`，保障节点章）
 *   - `cloudfunctions/reportPdf/index.js`（`_termYear`，纸面节点节；另有 `opts.singleYearEnd` 变体）
 *   - 本契约（2026-10-14 新增，服务保费现金流趋势）
 * 本文件把**前端的实现**收敛到一处（timeline-builder 与 gantt-builder 都改为引用它），
 * 口径依赖两个既有契约：`./policy-status`（终身/趸交哨兵）与 `./parse-expiry`（"至N岁"等文本解析）。
 *
 * ⚠️ 遗留：`reportPdf._termYear` 仍是**第二份实现**（已部署、被 71 条测试覆盖，本轮不动）。
 * 收敛它属于独立重构；在那之前，两边若改动必须同步 —— 2026-09-20 的 PDF 事故（漏判 coverage_term=105
 * → 纸上印出 ~2130 年"保障期满"，页面无此节点）正是口径分裂的代价。
 */
const { parseExpiry } = require('./parse-expiry')
const { isLifetimeTerm, isSinglePayTerm } = require('./policy-status')

/**
 * 文本期间 → 到期年（null = 终身/无明确到期年）
 * @param {string} period 如 '20年' / '至70岁' / '终身' / '至2060年12月31日'
 * @param {number} startY 保单生效年
 * @param {number} [age=0] 被保人年龄（"至N岁"格式需要）
 */
function parseTermYear(period, startY, age) {
  if (!period) return null
  if (/终身|长期/.test(String(period))) return null
  const eff = startY ? new Date(String(startY) + '-01-01') : null
  const r = parseExpiry(period, eff, age || 0)
  return r.year
}

/**
 * 保障到期年：OCR 文本 `insurance_period` 优先，兜底对话数字 `coverage_term`（105=终身，兼容旧 0→null）
 */
function coverTermYear(p, startY, age) {
  if (p && p.insurance_period) return parseTermYear(p.insurance_period, startY, age)
  const ct = p && p.coverage_term
  if (isLifetimeTerm(ct)) return null // 终身，无到期节点
  if (ct) {
    const n = parseInt(ct, 10)
    if (!isNaN(n) && n > 0) return startY + n
  }
  return null
}

/**
 * 缴费期满年：OCR 文本 `payment_period` 优先，兜底对话数字 `premium_term`（1=趸交，兼容旧 0→null）
 */
function payTermYear(p, startY, age) {
  if (p && p.payment_period) return parseTermYear(p.payment_period, startY, age)
  const pt = p && p.premium_term
  if (isSinglePayTerm(pt)) return null // 趸交/终身缴费，无"缴完"节点
  if (pt) {
    const n = parseInt(pt, 10)
    if (!isNaN(n) && n > 0) return startY + n
  }
  return null
}

module.exports = { parseTermYear, coverTermYear, payTermYear }
