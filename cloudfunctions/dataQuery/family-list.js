/**
 * family-list — 家庭列表查询领域
 *
 * 导出：listFamilies / searchFamilies
 * 内部助手：_fetchMembersByFam / _projectFamilyList / _computeProgress
 *
 * 设计：listFamilies 与 searchFamilies 共用成员批量查询与投影逻辑，
 *      抽到同一领域文件集中 locality（架构审计第 10 轮：从 handlers.js 拆分）。
 */
const { safeQuery } = require('./_shared/db-helpers')
const { wrapError } = require('./_shared/errorHandler')

// ---------- listFamilies ----------
// 首页/客户列表用：列出 openid 下所有家庭（含成员数、经济支柱名、资料完整度）
async function listFamilies(db, openid, event) {
  const limit = Math.min(Number(event.limit) || 50, 100)
  const since = event.since ? new Date(event.since) : null
  try {
    const _ = db.command
    const famWhere = { _openid: openid }
    if (since) famWhere.updated_at = _.gt(since)
    const famRes = await db.collection('families').where(famWhere).orderBy('updated_at', 'desc').limit(limit).get().catch(() => ({ data: [] }))

    const membersByFam = await _fetchMembersByFam(db, openid, (famRes.data || []).map(f => f._id))
    const families = _projectFamilyList(famRes.data || [], membersByFam)

    return { code: 200, data: { families, family_count: families.length } }
  } catch (e) {
    return wrapError('获取', e)
  }
}

// ---------- searchFamilies ----------
async function searchFamilies(db, openid, event) {
  const keyword = String(event.keyword || '').trim()
  if (!keyword) return listFamilies(db, openid, event)
  try {
    const _ = db.command
    // 按家庭名模糊匹配；families 无全文索引，用正则
    const famRes = await db.collection('families').where({
      _openid: openid,
      family_name: db.RegExp({ regexp: keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' })
    }).orderBy('updated_at', 'desc').limit(50).get().catch(() => ({ data: [] }))

    const membersByFam = await _fetchMembersByFam(db, openid, (famRes.data || []).map(f => f._id))
    const families = _projectFamilyList(famRes.data || [], membersByFam)

    return { code: 200, data: { families, family_count: families.length } }
  } catch (e) {
    return wrapError('搜索', e)
  }
}

// 批量取成员并按 family_id 分组（list/search 共用，避免 N+1）
async function _fetchMembersByFam(db, openid, famIds) {
  const membersByFam = {}
  if (!famIds || famIds.length === 0) return membersByFam
  const _ = db.command
  const memRes = await db.collection('members').where({ family_id: _.in(famIds), _openid: openid }).limit(500).get().catch(() => ({ data: [] }))
  for (const m of (memRes.data || [])) {
    if (!membersByFam[m.family_id]) membersByFam[m.family_id] = []
    membersByFam[m.family_id].push(m)
  }
  return membersByFam
}

// 家庭列表投影（listFamilies/searchFamilies 共用）
function _projectFamilyList(familiesRaw, membersByFam) {
  return familiesRaw.map(f => {
    const ms = membersByFam[f._id] || []
    const active = ms.filter(m => m.status !== 'deleted')
    const pillar = active.find(m => /本人|经济支柱/.test(m.role || '')) || active[0] || null
    return {
      _id: f._id,
      family_name: f.family_name || '',
      name: f.family_name || '',
      member_count: active.length,
      pillar_name: pillar ? pillar.name : '',
      profile_progress: f.profile_progress || _computeProgress(f, active),
      deliverable_status: f.last_portrait ? 'generated' : 'none',
      completeness_score: f.completeness_score || 0,
      engagement_stage: f.engagement_stage || '',
      insight_stale: !!f.insight_stale,
      created_at: f.created_at,
      updated_at: f.updated_at
    }
  })
}

// 简易完整度计算（families.profile_progress 缺失时兜底）
function _computeProgress(f, members) {
  const hasMembers = members.length > 0
  const hasFinance = !!(f.financial_snapshot && (f.financial_snapshot.income || f.financial_snapshot.debt))
  const hasInsurance = !!f.last_portrait
  const hasHealth = members.some(m => m.health && m.health.trim())
  return {
    members: hasMembers ? 50 : 0,
    finance: hasFinance ? 30 : 0,
    insurance: hasInsurance ? 20 : 0,
    health: hasHealth ? 10 : 0
  }
}

module.exports = { listFamilies, searchFamilies }
