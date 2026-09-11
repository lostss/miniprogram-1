/**
 * family-list — 家庭列表查询领域
 *
 * 导出：listFamilies / searchFamilies
 * 内部助手：_fetchMembersByFam / _projectFamilyList / _computeProgress
 *
 * 设计：listFamilies 与 searchFamilies 共用成员批量查询与投影逻辑，
 *      抽到同一领域文件集中 locality（架构审计第 10 轮：从 handlers.js 拆分）。
 */
const { wrapError } = require('./_shared/errorHandler')

// ---------- listFamilies ----------
// 首页/客户列表用：列出 openid 下所有家庭（含成员数、经济支柱名、资料完整度）
// 客户列表审计 P1-1：主查询失败必须传播（外层 wrapError → 前端错误态），
// 不能吞成空列表伪装"未找到/尚无客户"；成员查询失败仍容错降级（见 _fetchMembersByFam）
async function listFamilies(db, openid, event) {
  const limit = Math.min(Number(event.limit) || 50, 100)
  const since = event.since ? new Date(event.since) : null
  try {
    const _ = db.command
    const famWhere = { _openid: openid }
    if (since) famWhere.updated_at = _.gt(since)
    const famRes = await db.collection('families').where(famWhere).orderBy('updated_at', 'desc').limit(limit).get()

    const membersByFam = await _fetchMembersByFam(db, openid, (famRes.data || []).map(f => f._id))
    const families = _projectFamilyList(famRes.data || [], membersByFam)

    return { code: 200, data: { families, family_count: families.length } }
  } catch (e) {
    return wrapError('获取', e)
  }
}

// ---------- searchFamilies ----------
// 搜索审计 #7（产品决策）：搜索范围 = 家庭名 + 成员名（命中成员名返回其所属家庭）
// 双路并发查询 + 合并去重；关键词正则转义防注入；软删成员不参与匹配
async function searchFamilies(db, openid, event) {
  const keyword = String(event.keyword || '').trim()
  if (!keyword) return listFamilies(db, openid, event)
  try {
    const _ = db.command
    // families/members 均无全文索引，用正则（转义防正则注入）
    const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const famWhere = { _openid: openid, family_name: db.RegExp({ regexp: esc, options: 'i' }) }
    const memWhere = { _openid: openid, name: db.RegExp({ regexp: esc, options: 'i' }) }

    // 双路并发：家庭名直查 + 成员名命中取 family_id
    const [famRes, memRes] = await Promise.all([
      db.collection('families').where(famWhere).orderBy('updated_at', 'desc').limit(50).get(),
      db.collection('members').where(memWhere).limit(200).get()
    ])

    // 成员命中：排除软删（status=deleted），取其 family_id；补查家庭名未命中的家庭
    const memberFamIds = (memRes.data || [])
      .filter(m => m.status !== 'deleted')
      .map(m => m.family_id).filter(Boolean)
    const knownIds = new Set((famRes.data || []).map(f => f._id))
    const missingIds = [...new Set(memberFamIds)].filter(id => !knownIds.has(id))

    let extraFams = []
    if (missingIds.length > 0) {
      const extraRes = await db.collection('families')
        .where({ _openid: openid, _id: _.in(missingIds) }).limit(50).get()
      extraFams = extraRes.data || []
    }

    // 合并去重 + 统一按 updated_at desc（成员命中的家庭未经 DB 排序，JS 侧补序）
    const seen = new Set()
    const merged = []
    for (const f of (famRes.data || []).concat(extraFams)) {
      if (!f || seen.has(f._id)) continue
      seen.add(f._id)
      merged.push(f)
    }
    merged.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    const top = merged.slice(0, 50)

    const membersByFam = await _fetchMembersByFam(db, openid, top.map(f => f._id))
    const families = _projectFamilyList(top, membersByFam)

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
  // 降级保留（见文件头：主查询失败传播、成员查询容错降级——家庭列表仍可显示）。
  // 2026-09-11 修复（全面审计 P1-1）：但降级**必须可观测**——原实现完全静默，
  // 成员查询失败时列表成员数变 0 却无任何日志，线上无法察觉（不掩盖失败原则）。
  const memRes = await db.collection('members').where({ family_id: _.in(famIds), _openid: openid }).limit(500).get()
    .catch(e => {
      console.error('[family-list] 成员批量查询失败，已降级为空（家庭列表仍显示）:', e.message)
      return { data: [] }
    })
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
