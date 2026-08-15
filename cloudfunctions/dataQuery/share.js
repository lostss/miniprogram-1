/**
 * share.js — 报告分享域（token 生成 + 客户只读脱敏读取）
 *
 * 背景：getFamily 强绑 owner _openid，客户（非 owner）无法直接读报告。
 * 机制：owner 生成高熵 token 存 families.share，客户凭 token 读取；
 *      云函数用 token 反查 owner openid 取数，脱敏后返回规则版报告（不含 AI 深度分析文本）。
 */
const crypto = require('crypto')
const { loadFamilyView } = require('./_shared/familyView')
const { loadActivePolicies } = require('./_shared/policy-read')
const { wrapError } = require('./_shared/errorHandler')

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
    return Object.assign({}, m, { name: _maskName(m.name) })
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
  if (!token) return { code: 400, msg: '缺少参数 token' }
  try {
    // token 高熵随机，按 token 反查（不带 _openid，客户非 owner）
    const famRes = await db.collection('families').where({ 'share.token': token }).get()
    const fam = famRes.data && famRes.data[0]
    if (!fam || !fam.share || !fam.share.expires_at) return { code: 404, msg: '分享链接无效或已被撤销' }
    if (Date.now() >= fam.share.expires_at) return { code: 404, msg: '分享链接已过期' }
    const ownerOpenid = fam._openid
    const familyId = fam._id

    const [family, policies] = await Promise.all([
      loadFamilyView(db, ownerOpenid, familyId),
      loadActivePolicies(db, familyId, ownerOpenid)
    ])
    if (!family) return { code: 404, msg: '家庭不存在' }

    // 向后兼容字段（前端 buildReportView 读取路径，与 getFamilyDetail 一致）
    const fs = family.financial_snapshot || {}
    if (!family.debt) family.debt = fs.debt || { amount: 0, type: '' }
    if (family.family_income == null) family.family_income = fs.income || 0
    if (!family.name) family.name = family.family_name || ''

    // 脱敏：姓名/保单号；剔除特别约定；客户只看规则版（不返回 AI 深度分析文本）
    family.name = _maskFamilyName(family.name)
    family.family_name = family.name
    family.members = _maskMembers(family.members)
    family.policies = _maskPolicies(policies)
    family.report = {}
    family.shared = true
    // 清理：不暴露 owner openid + AI 深度分析产物（last_* 文本可能含姓名/具体建议）
    delete family._openid
    for (const k of Object.keys(family)) { if (k.indexOf('last_') === 0) delete family[k] }

    return { code: 200, data: family }
  } catch (e) {
    return wrapError('获取分享', e)
  }
}

module.exports = { shareFamily, getSharedFamily }
