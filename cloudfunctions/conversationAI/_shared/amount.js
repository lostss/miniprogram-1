/**
 * amount.js — 金额单位契约（架构审计 #1 实施）
 *
 * 权威口径：DB 金额字段统一存**元**（finances.annual_income/total_debt/fixed_annual_expense、
 * policies.sum_assured/annual_premium）；展示/对话/AI 上下文统一转**万**。
 * 所有 元↔万 换算必须经本文件，禁止散落 `/10000`、`*10000`、`/100/100`（防口径漂移）。
 * 换算结果与历史实现逐位一致：元→万保留 2 位小数（Math.round(n/100)/100）。
 */

/** 元 → 万（number 输入，NaN 返回 NaN，保留 2 位小数防浮点噪音） */
function yuanToWan(v) {
  const n = Number(v)
  return Math.round(n / 100) / 100
}

/** 万 → 元（number 输入，NaN 返回 NaN；表单/对话输入万 → DB 存元） */
function wanToYuan(v) {
  const n = Number(v)
  return Math.round(n * 10000)
}

/** 元 → 万展示格式化：≥1 万显示「x万」（2 位精度，与 yuanToWan 同构，防与前端 fmtYuan 1/2 位漂移），否则原元 */
function fmtYuan(v) {
  const n = Number(v)
  if (isNaN(n)) return String(v)
  if (n >= 10000) {
    const x = Math.round(n / 100) / 100
    return `${Number.isInteger(x) ? x : x}万`
  }
  return `${n}元`
}

module.exports = { yuanToWan, wanToYuan, fmtYuan }
