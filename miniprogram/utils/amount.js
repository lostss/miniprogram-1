/**
 * amount.js — 金额单位契约（架构审计 #1 实施，前端镜像）
 * 与 cloudfunctions/_shared/amount.js 同接口。DB 金额存元，展示/表单换算统一走此文件。
 */
const WAN = 10000

/** 元 → 万（保留 2 位小数） */
function yuanToWan(v) {
  const n = Number(v)
  return Math.round(n / 100) / 100
}

/** 万 → 元（表单/对话输入万 → DB 元） */
function wanToYuan(v) {
  const n = Number(v)
  return Math.round(n * WAN)
}

/** 元 → 展示：≥1 万显示「x万」（2 位精度，与 yuanToWan 同构防 1/2 位漂移），否则原元 */
function fmtYuan(v) {
  const n = Number(v)
  if (isNaN(n)) return String(v)
  if (n >= WAN) {
    const x = Math.round(n / 100) / 100
    return `${Number.isInteger(x) ? x : x}万`
  }
  return `${n}元`
}

module.exports = { yuanToWan, wanToYuan, fmtYuan }
