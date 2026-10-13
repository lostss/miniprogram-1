/**
 * report-share.js — 报告分享域纯逻辑（从 pages/report/index.js 剥离）
 *
 * 拆分动机（架构审计 2026-08）：report 页 588 行承载 9 个关注点，分享相关纯逻辑
 * 无 Page 实例依赖，抽离后可独立单测。Page 仅保留事件转发与状态持有。
 *
 * 导出：
 *   buildShareTitle(name, dateTime)  — 分享标题（三行：报告名/保障一览/日期）
 *   buildSharePath(token, familyId)  — 分享路径（token 优先；无 token 时仍带 share=1 走"链接已失效"提示）
 *   buildReportMeta(family)          — 报告封面元数据（日期基于报告更新时间）
 *   ensureShareToken(api, cid)       — token 懒生成（返回 { token, expiresAt }；失败静默返回 null）
 *   shareExpireHint(expiresAt)       — 剩余有效期文案（owner 端可见，2026-09-19 UX4）
 */
function buildShareTitle(name, dateTime) {
  const familyName = String(name || '家庭').replace(/家庭$/, '') + '家庭'
  const dt = String(dateTime || '')
  return (familyName + '保障检视报告\n保障一览\n' + dt).slice(0, 60)
}

function buildSharePath(token, familyId) {
  if (token) return '/pages/report/index?token=' + token + '&share=1'
  // 2026-09-20 修（流程审计 P2-6，采纳"回退路径也带 share=1"方案）：
  // 无 token 时**不得**回退成 owner 形态的 `?familyId=` 链接。客户以自己的 openid 打开后，
  // 页面按 owner 分支调 getFamily → 404「客户不存在」/401「登录异常」，
  // 用户无从判断是链接坏了还是自己没权限，代理人也永远不知道客户看到了什么。
  // 带 share=1 则进入共享分支，页面本就对「share=1 但 token 为空」有明确处置：
  // showModal「链接已失效，缺少分享凭证，请联系代理人重新分享」并回首页。
  //
  // 何时会走到这里（两个都真实）：① 进页面后立刻点转发、token 请求还没回来（时序，受基础库
  // 对 onShareAppMessage 异步返回的支持情况影响）② shareFamily 请求失败（弱网/后端异常）
  // ——② 与基础库无关，只要发生必然产出坏链接，故此处兜底是必需的。
  // familyId 参数保留仅为调用方签名兼容，已不进 URL（原值也没有任何消费方：共享分支不读它）。
  // 未做的加强项（需真机确认，见流程审计 P2-6 备选 B）：token 就绪前 disabled 分享按钮——
  // `open-type="share"` 的 disabled 能否拦住原生转发面板，CLI 无法验证。
  return '/pages/report/index?share=1'
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

// 分享 token 懒生成（owner 端）：进入报告页即生成，onShareAppMessage 复用；失败静默
// （此时 buildSharePath 会退化出一条"链接已失效"的分享路径，见该函数注释）
async function ensureShareToken(api, cid) {
  if (!cid) return null
  try {
    const q = await api('shareFamily', { familyId: cid })
    // 2026-09-19 修（流程审计 UX4）：后端 shareFamily 一直返回 expiresAt（token TTL 7 天），
    // 这里只取 token 就把它丢了 → owner 端完全看不到链接到期时间，客户过期后只看到"链接已失效"，
    // 代理人无法提前重发。改为整包返回，由页面转成可见文案。
    if (q && q.ok && q.data && q.data.token) return { token: q.data.token, expiresAt: q.data.expiresAt || 0 }
  } catch (e) { /* 静默：分享 token 非关键路径 */ }
  return null
}

// 分享链接剩余有效期文案（owner 端展示；无有效时间戳 → 空串，不渲染）
function shareExpireHint(expiresAt) {
  const t = Number(expiresAt) || 0
  if (t <= 0) return ''
  const days = Math.ceil((t - Date.now()) / 86400000)
  if (days <= 0) return '分享链接已过期，转发时将自动重新生成'
  return '分享链接有效期剩余 ' + days + ' 天'
}

module.exports = { buildShareTitle, buildSharePath, buildReportMeta, ensureShareToken, shareExpireHint }
