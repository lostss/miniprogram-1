/**
 * report-share.js — 报告分享域纯逻辑（从 pages/report/index.js 剥离）
 *
 * 拆分动机（架构审计 2026-08）：report 页 588 行承载 9 个关注点，分享相关纯逻辑
 * 无 Page 实例依赖，抽离后可独立单测。Page 仅保留事件转发与状态持有。
 *
 * 导出：
 *   buildShareTitle(name, dateTime)  — 分享标题（三行：报告名/保障一览/日期）
 *   buildSharePath(token, familyId)  — 分享路径（token 优先，兜底 familyId 旧路径）
 *   buildReportMeta(family)          — 报告封面元数据（日期基于报告更新时间）
 *   ensureShareToken(api, cid)       — token 懒生成（失败静默返回 null）
 */
function buildShareTitle(name, dateTime) {
  const familyName = String(name || '家庭').replace(/家庭$/, '') + '家庭'
  const dt = String(dateTime || '')
  return (familyName + '保障检视报告\n保障一览\n' + dt).slice(0, 60)
}

function buildSharePath(token, familyId) {
  return token
    ? '/pages/report/index?token=' + token + '&share=1'
    : '/pages/report/index?familyId=' + (familyId || '')
}

// 报告封面元数据：日期基于"报告更新日期"（updated_at 优先，last_analysis_at 兜底）
// 原用 new Date()（当前时间）导致每次刷新日期都变化，与报告内容更新时间不符
// 活报告模型（2026-09）：dateTime 保持纯日期（兼容分享标题）；dataAt/analysisAt 为页头时效标识
function _fmt(d) {
  const pad = function(n) { return String(n).padStart(2, '0') }
  return d.getFullYear() + '年' + pad(d.getMonth() + 1) + '月' + pad(d.getDate()) + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}
function buildReportMeta(family) {
  const f = family || {}
  const ts = f.updated_at || f.last_analysis_at
  let d = ts ? new Date(ts) : new Date()
  if (isNaN(d.getTime())) d = new Date()
  const dateTime = _fmt(d)
  let dataAt = '数据更新于 ' + dateTime
  let analysisAt = ''
  const analysisTs = f.last_analysis_at || f.analysisAt // analysisAt 为客户版 share 透传标量
  if (analysisTs) {
    const da = new Date(analysisTs)
    if (!isNaN(da.getTime())) analysisAt = '保障分析生成于 ' + _fmt(da)
  }
  return { dateTime: dateTime, dataAt: dataAt, analysisAt: analysisAt }
}

// 分享 token 懒生成（owner 端）：进入报告页即生成，onShareAppMessage 复用；失败静默（分享时兜底 familyId 旧路径）
async function ensureShareToken(api, cid) {
  if (!cid) return null
  try {
    const q = await api('shareFamily', { familyId: cid })
    if (q && q.ok && q.data) return q.data.token
  } catch (e) { /* 静默：分享 token 非关键路径 */ }
  return null
}

module.exports = { buildShareTitle, buildSharePath, buildReportMeta, ensureShareToken }
