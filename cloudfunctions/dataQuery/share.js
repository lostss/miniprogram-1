/**
 * share.js — 报告分享域（token 生成 + 客户只读脱敏读取）
 *
 * 背景：getFamily 强绑 owner _openid，客户（非 owner）无法直接读报告。
 * 机制：owner 生成高熵 token 存 families.share，客户凭 token 读取；
 *      云函数用 token 反查 owner openid 取数，脱敏后返回规则版报告（不含 AI 深度分析文本）。
 */
const crypto = require('crypto')
const { loadFamilyView } = require('./_shared/familyView')
const { safeQueryAll } = require('./_shared/db-helpers')
const { desensitize } = require('./_shared/pii-rules')
const { loadActivePolicies } = require('./_shared/policy-read')
const { loadCashValues } = require('./_shared/cash-value-read')
const { wrapError } = require('./_shared/errorHandler')
// 客户版叙事：last_* → report 契约（与 getFamilyDetail 同源，改字段只动 report-fields.js）
const { toReadReport } = require('./_shared/report-fields')
const { applyFamilyCompat } = require('./_shared/family-compat')

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000 // 分享 token 有效期 7 天

// ---------- 脱敏（统一"首字+**"，成员/保单姓名同规则，保证前端 gap 按 name 匹配仍一致） ----------
function _maskName(name) {
  if (!name) return ''
  return String(name).slice(0, 1) + '**'
}
function _maskFamilyName(name) {
  if (!name) return ''
  return String(name).slice(0, 1) + '家庭'
}
function _maskMembers(members) {
  return (members || []).map(function (m) {
    const q = Object.assign({}, m, { name: _maskName(m.name) })
    // P2-D2 修复（2026-09-05）：浅拷贝保留 _openid → owner 身份泄露给分享查看者（safeAdd 落库注入）
    delete q._openid
    return q
  })
}
/**
 * 事实脱敏（客户版专用，2026-09-20 流程审计 P2-3）。
 * 口径与成员/保单一致：姓名走同一 _maskName；自由文本值走 pii-rules.desensitize
 * （身份证/手机号/银行卡）。注意：值里的姓名不做二次掩码（2026-10-27：AI 叙事已不再随分享下发，见下方 report 字段清理）
 * （用户决策 2026-08-31「叙事给客户看」），此处只需不低于同一披露标准。
 * 保单节点属性（subject_type='policy'）照样带上：buildFactsView 会自行过滤，
 * 保持与 owner 版投影一致，避免"两个入口字段集不同"的新漂移。
 */
function _maskFacts(facts) {
  return (facts || []).map(function (f) {
    return {
      _id: f._id,
      subject_id: f.subject_id || '',
      subject_type: f.subject_type || '',
      subject_name: f.subject_name ? _maskName(f.subject_name) : '',
      predicate: f.predicate || '',
      axis: f.axis || '',
      kind: f.kind || 'fact',
      object_value: desensitize(String(f.object_value || '')),
      confidence: f.confidence,
      created_at: f.created_at
    }
  })
}

function _maskPolicies(policies) {
  return (policies || []).map(function (p) {
    const q = Object.assign({}, p)
    q.insured_name = _maskName(p.insured_name)
    q.policyholder_name = _maskName(p.policyholder_name)
    q.beneficiary_name = _maskName(p.beneficiary_name)
    if (q.policy_number) q.policy_number = '****' + String(q.policy_number).slice(-4)
    delete q.special_agreement
    delete q._openid // P2-D2：同上，policy 文档经 safeAdd 注入 _openid
    return q
  })
}

// ---------- shareFamily：owner 生成/复用 token ----------
async function shareFamily(db, openid, event) {
  const { familyId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  try {
    const famRes = await db.collection('families').where({ _id: familyId, _openid: openid }).get()
    const fam = famRes.data && famRes.data[0]
    if (!fam) return { code: 404, msg: '家庭不存在或无权访问' }
    const now = Date.now()
    // 已有未过期 token 直接复用（避免每次分享堆积新 token）
    if (fam.share && fam.share.token && fam.share.expires_at && now < fam.share.expires_at) {
      return { code: 200, data: { token: fam.share.token, expiresAt: fam.share.expires_at } }
    }
    const token = crypto.randomBytes(24).toString('hex')
    const expiresAt = now + TOKEN_TTL_MS
    await db.collection('families').where({ _id: familyId, _openid: openid }).update({ data: { share: { token: token, expires_at: expiresAt } } })
    return { code: 200, data: { token: token, expiresAt: expiresAt } }
  } catch (e) {
    return wrapError('生成分享', e)
  }
}

// ---------- getSharedFamily：客户凭 token 读取脱敏报告 ----------
async function getSharedFamily(db, openid, event) {
  const { token } = event
  // 2026-09-22 全面审计 P0-1（NoSQL 操作符注入）：这里必须做**严格类型 + 格式**校验，
  // 不能只判真值。原因是本查询是全仓唯一「用户输入直接当 where 值、且刻意不带 _openid」的
  // 查询（见下方注释），而客户端可原样送达普通对象：
  //   wx.cloud.callFunction({ data: { action:'getSharedFamily', token: { $exists: true } } })
  // 经 JSON 序列化到云端仍是普通对象；@cloudbase/database 的 flattenQueryObject 对
  // `$` 前缀子键 `continue`（不展平但**保留**该键），encodeQueryObject 对非 Command 对象
  // 原样透传（已按 dataQuery/node_modules/@cloudbase/database@1.4.3 源码逐行核对）→
  // 最终下发 `{'share.token': {$exists: true}}`，与 `_.exists(true)` 的线上字节格式完全一致，
  // 服务端按**操作符**解释 → 无需任何 token 即可命中某个已开启分享的家庭，返回其完整客户视图
  // （成员/健康/财务/保单 + AI 叙事）。故此处收口为「48 位小写 hex 字符串」。
  if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) {
    return { code: 400, msg: '分享链接无效' }
  }
  try {
    // token 高熵随机，按 token 反查（不带 _openid，客户非 owner）
    const famRes = await db.collection('families').where({ 'share.token': token }).get()
    const fam = famRes.data && famRes.data[0]
    if (!fam || !fam.share || !fam.share.expires_at) return { code: 404, msg: '分享链接无效或已被撤销' }
    if (Date.now() >= fam.share.expires_at) return { code: 404, msg: '分享链接已过期' }
    const ownerOpenid = fam._openid
    const familyId = fam._id

    const [family, policies, cashValues, factRes] = await Promise.all([
      loadFamilyView(db, ownerOpenid, familyId),
      loadActivePolicies(db, familyId, ownerOpenid),
      loadCashValues(db, familyId, ownerOpenid),
      // 2026-09-20 修（流程审计 P2-3）：客户版要渲染「客户档案」，但客户不是 owner，
      // report 页的 queryFacts 按**客户 openid** 过滤必然取不到（entity-query 一律带 _openid）
      // → 数据必须在共享响应里带下来。分页走 safeQueryAll（fact 随版本历史增长，固定 limit 迟早越界）。
      safeQueryAll(db, 'facts', { family_id: familyId, status: 'active' }, ownerOpenid, { maxPages: 10 })
    ])
    if (!family) return { code: 404, msg: '家庭不存在' }
    // 当前年份现金价值展示（客户版与代理人版均展示；y/v 数值无个人敏感信息，原样透传）
    family.cashValues = cashValues
    // 事实投影 + 脱敏：字段集与 queryFacts 的投影一致（客户版与 owner 版共用同一个
    // buildFactsView 组装视图，只是入参 shared:true），故这里不做视图裁剪、只做脱敏。
    family.facts = _maskFacts(factRes.data || [])

    // 向后兼容字段（前端 buildReportView 读取路径，与 getFamilyDetail 同源）
    // 2026-09-19：实现抽到 _shared/family-compat.js，本处与 owner 读路径共用同一函数
    applyFamilyCompat(family)

    // 脱敏：姓名/保单号；剔除特别约定；2026-10-27：AI 叙事**不再**下发（用户决策：客户手里只留化验单），见下方 family.report 字段删除
    family.name = _maskFamilyName(family.name)
    family.family_name = family.name
    family.members = _maskMembers(family.members)
    family.policies = _maskPolicies(policies)
    // 叙事映射须在清理 last_* 之前执行：toReadReport 读 last_* 生成 report 副本，后续删除不影响副本
    family.report = toReadReport(family)
    // 2026-10-24（用户决策：报告只列事实、AI 仅作代理端独立入口）：
    // 分享给客户的 payload **不得携带 AI 叙事** —— portrait/suggestions/plan 是"诊断与建议"，
    // 一旦随分享下发，客户手里的报告就不再是化验单，且与页面"移出报告正文"的口径互相矛盾。
    // 页面在客户版也不再渲染进阶区（report 页 isShared 分支），这里是数据层的最后一道闸。
    ;['portrait', 'review', 'plan', 'suggestions', 'conclusion', 'analysis', 'core_insights'].forEach(function(k) {
      if (family.report && k in family.report) delete family.report[k]
    })
    // 活报告模型（2026-09）：时效标识——清理 last_* 前透传分析生成时间标量（客户版页头展示）
    family.analysisAt = family.last_analysis_at || ''
    family.shared = true
    // 清理：不暴露 owner openid；last_* 原始字段删除（report 副本已保留叙事文本，客户可读）
    // M-3 修复：循环源对象错位，原用 fam 的 keys 删 family 的字段会漏删 family 中独有的 last_* 字段
    delete family._openid
    for (const k of Object.keys(family)) { if (k.indexOf('last_') === 0) delete family[k] }
    // 2026-09-22 全面审计 P2-2（最小必要）：以上只删了 _openid 与 last_*，仍有一批
    // **只对代理人有意义**的内部字段随响应体下发——最要紧的是 memo（代理人写给自己的
    // 客户私密备注），另有 AI 软画像（soft_profile/quick_profile）、内部提醒
    // （info_alert/protection_alert/has_new_insight/summary_pending）、成交标记
    // （deal_status）、share（token 本身）等。
    // 前端虽未渲染（report 页对 dealStatus 另有 isShared 分支），但原始响应体会完整进入
    // 查看者设备的 JS 运行时（报告页把整份 family 存进实例字段 this._family）→ 可被调试器/越狱
    // 环境读到，属"渲染层挡住、数据层没挡"的越界披露。
    // 全仓核对：以下字段在 miniprogram/ 下零引用（含 wxml/wxss/js），删除不影响任何视图。
    const INTERNAL_ONLY = [
      'memo', 'soft_profile', 'quick_profile', 'profile_state',
      'info_alert', 'protection_alert', 'has_new_insight', 'summary_pending',
      'has_portrait', 'last_portrait', 'deal_status', 'agent_id',
      // 2026-09-22 审计补充（安全子审计遗留项）：AI 待澄清项 = 代理人的工作线索清单，
      // 前端仅在渲染层清空（report/index.js 的 isShared 分支），数据层必须一并剔除。
      'pending_clarifications',
      'profile_progress', 'confirmed_health', 'health_confirmed', 'share'
    ]
    for (const k of INTERNAL_ONLY) delete family[k]

    return { code: 200, data: family }
  } catch (e) {
    return wrapError('获取分享', e)
  }
}

// `_mask*` 导出仅供单测：客户版脱敏是数据红线（姓名掩码 / _openid 与 special_agreement 剔除 /
// 保单号尾 4 位），此前整段无测试（2026-09-28 复审补 tests/shared-family-mask.test.js）。
module.exports = { shareFamily, getSharedFamily, _maskName, _maskFamilyName, _maskMembers, _maskFacts, _maskPolicies }
