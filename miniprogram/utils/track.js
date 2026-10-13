/**
 * track.js — 产品埋点（2026-09-12，MVP 验证最小集）
 *
 * 为什么自建而不是 wx.reportEvent / wx.reportAnalytics：
 *   那两个需要在微信后台逐个配置事件与看板，且数据只能在小程序后台看；
 *   项目已有成熟通道（api('writeOpLog') → operation_logs，app.js 的前端错误上报已在用），
 *   直接入库即可用现有查询读取，零后台配置成本。
 *
 * 事件（logAction = 'product_' + name）：
 *   report_open     { view:'owner'|'shared', familyId }   客户打开 = 真实触达；7 日回访由同 view 多次 open 推算
 *   report_share    { view:'owner', familyId }            转发率分子
 *   report_export   { view:'owner', familyId }            PDF 导出
 *   report_feedback { view, familyId, useful:boolean }    唯一的主观信号
 *   deal_marked     { familyId, status }                  成交/未成交（唯一能算出 ROI 的真值）
 *
 * 设计约束：
 *   - fire-and-forget + 静默失败：埋点绝不能影响主流程（与 app.js 错误上报同策略）
 *   - 不落 PII：只带 familyId 与枚举/布尔，不带姓名、金额、文本
 *   - view 维度是关键：owner 打开与客户打开混在一起，"打开率/回访率"会被代理人自己污染
 */
const api = require('./apiClient')

const PREFIX = 'product_'

/** @param {string} name 事件名（不带前缀） @param {object} meta 仅枚举/ID 类字段 */
function track(name, meta) {
  try {
    api('writeOpLog', {
      logAction: PREFIX + name,
      result: { status: 'ok' },
      meta: meta || {}
    }, { retries: 0 }).catch(function () { /* 静默：埋点失败不影响业务 */ })
  } catch (e) { /* 同上 */ }
}

module.exports = { track }
