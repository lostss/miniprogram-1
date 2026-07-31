/**
 * memberRepo — 成员/财务数据的仓库层（候选 3 从 member-store grab-bag 剥离）
 *
 * 承载所有低层成员/财务读写、字段白名单、注入检测与年龄工具。
 * loadFamilyView（深模块）已移至 familyView.js，本层不依赖它。
 * 调用方仍经 member-store 桶引用这些符号，接口不变。
 *
 * v2：写入经 writeSeam 工厂（统一 _openid 注入 + updated_at + markMutated/advanceStage 钩子），
 *     消除 conversationAI 直调路径与 dataWrite 网关路径的双 Adapter 行为分裂。
 */
const { safeQuery } = require('./db-helpers')
const { writeSeam } = require('./writeSeam')
const { calcAgeYears } = require('./calc-age')
const { detectInjection } = require('./guard')

// members 集合允许的字段白名单（防 AI 误写 financial/policy 字段）
// age 直接允许（对话"X岁"场景），birth_date 由 age 推导或用户明确给出
const _MEMBER_FIELDS = ['name', 'birth_date', 'age', 'role', 'gender', 'occupation', 'health']
const _MEMBER_FIELD_ZH = { name: '姓名', birth_date: '出生日期', role: '角色', gender: '性别', occupation: '职业', health: '健康状况', age: '年龄' }

function _shapeMember(m) {
  if (!m) return null
  const age = m.age || calcAgeYears(m.birth_date)
  return {
    _id: m._id,
    member_id: m.member_id,
    name: m.name || '',
    role: m.role || '',
    age,
    birth_date: m.birth_date || '',
    gender: m.gender || '',
    occupation: m.occupation || '',
    health: m.health || '',
    income: m.income || 0,
    is_economic_pillar: m.role === '本人' || m.role === '经济支柱',
    status: m.status || 'active'
  }
}

/** 加载家庭成员（形状对齐旧 families.members）
 * S2-2 修复：统一过滤 status='deleted'，消除 family-detail/_updateCompletenessAsync/member-matcher 的口径分裂
 * family-list/entity-query 中重复的过滤可保留（防御性），但源头在此统一
 */
async function getMembers(db, familyId, openid) {
  const res = await safeQuery(db, 'members', { family_id: familyId }, openid)
  return (res.data || []).filter(m => m.status !== 'deleted').map(_shapeMember)
}

/** 加载家庭财务（形状对齐旧 families.financial_snapshot） */
async function getFinance(db, familyId, openid) {
  const res = await safeQuery(db, 'finances', { family_id: familyId }, openid)
  const f = res.data && res.data[0]
  if (!f) return { income: null, debt: { amount: null, type: '' }, fixed_expense: null, annual_premium_budget: null }
  return {
    income: _toWan(f.annual_income, f.income),
    debt: { amount: _toWan(f.total_debt, f.debt), type: f.debt_type || '' },
    fixed_expense: _toWan(f.fixed_annual_expense, f.fixed_expense),
    annual_premium_budget: f.annual_premium_budget != null ? f.annual_premium_budget : null
  }
}

/** 元 → 万：数值型除以10000，字符串提取数字后返回（已为万的不变） */
function _toWan(newVal, fallbackVal) {
  const v = newVal != null ? newVal : (fallbackVal != null ? fallbackVal : null)
  if (v == null) return null
  if (typeof v === 'string') { const m = String(v).match(/([\d.]+)/); return m ? parseFloat(m[1]) : null }
  const n = Number(v)
  return isNaN(n) ? null : Math.round(n / 100) / 100
}

/** 按 member_id / _id / name 定位成员文档 */
async function findMember(db, familyId, openid, key) {
  if (!key) return null
  let res = await safeQuery(db, 'members', { family_id: familyId, member_id: key }, openid)
  if (res.data && res.data.length > 0) return res.data[0]
  res = await safeQuery(db, 'members', { family_id: familyId, _id: key }, openid)
  if (res.data && res.data.length > 0) return res.data[0]
  res = await safeQuery(db, 'members', { family_id: familyId, name: key }, openid)
  return (res.data && res.data[0]) || null
}

// 检测成员年龄/出生日期是否与历史记录矛盾（≥2 年差视为矛盾）
// userProvidedBirth: 用户原始输入是否含 birth_date（用于决定报哪个字段，避免 age 被推导成 birth_date 后误报）
function _detectMemberConflict(existing, cleanData, userProvidedBirth) {
  // 用户明确给了出生日期 → 直接比年份，报 birth_date
  if (userProvidedBirth && existing.birth_date) {
    const ey = new Date(existing.birth_date).getFullYear()
    const iy = new Date(cleanData.birth_date).getFullYear()
    if (!isNaN(ey) && !isNaN(iy) && Math.abs(ey - iy) >= 2) {
      return { field: 'birth_date', existingValue: existing.birth_date, incomingValue: cleanData.birth_date, message: `历史记录 ${existing.birth_date}，本次输入 ${cleanData.birth_date}` }
    }
  }
  // 比年龄（含由出生日期推导，跨字段也检测）
  const exAge = existing.age || calcAgeYears(existing.birth_date)
  const inAge = cleanData.age != null ? Number(cleanData.age) : (cleanData.birth_date ? calcAgeYears(cleanData.birth_date) : null)
  if (exAge && inAge && !isNaN(exAge) && !isNaN(inAge) && Math.abs(exAge - inAge) >= 2) {
    return { field: 'age', existingValue: exAge, incomingValue: inAge, message: `历史记录 ${exAge} 岁，本次输入 ${inAge} 岁` }
  }
  return null
}

// ---------- members: upsert by family_id + name + role ----------
// confirmOnConflict: 对话路径开启——与历史矛盾时返回 409 needsConfirm（不直接覆盖，交给确认卡片）
// confirmed: 确认卡片二次调用——跳过矛盾检测强制写入
async function upsertMember(db, familyId, openid, { memberId, memberName, role, data, confirmed = false, confirmOnConflict = false }) {
  if (!memberId && !memberName) return { code: 400, msg: '缺少 memberId 或 memberName' }
  if (!data || Object.keys(data).length === 0) return { code: 400, msg: '缺少更新数据' }
  // 记录用户原始是否给了出生日期（推导的不算），用于矛盾字段判定
  const userProvidedBirth = data.birth_date != null

  const cleanData = {}
  const unknownFields = []
  for (const [k, v] of Object.entries(data)) {
    if (_MEMBER_FIELDS.includes(k)) cleanData[k] = v
    else unknownFields.push(k)
  }
  if (unknownFields.length > 0) {
    return { code: 400, msg: 'upsertMember 不接受字段: ' + unknownFields.join(',') + '。收入/负债请用 updateFinances，其他请用 addFact' }
  }
  if (Object.keys(cleanData).length === 0) return { code: 400, msg: '无有效成员字段（白名单：' + _MEMBER_FIELDS.join(',') + '）' }

  for (const v of Object.values(cleanData)) {
    if (typeof v === 'string' && detectInjection(v).injected) return { code: 400, msg: '内容校验未通过' }
  }

  // 仅传 age 未传 birth_date → 推导出生日期（当年1月1日），保证报告"至N周岁"可计算
  if (cleanData.age != null && cleanData.birth_date == null) {
    const y = Number(cleanData.age)
    if (!isNaN(y)) cleanData.birth_date = (new Date().getFullYear() - y) + '-01-01'
  }

  const now = new Date()
  const updateData = { ...cleanData, updated_at: now }
  const checkConflict = confirmOnConflict && !confirmed

  // 优先 memberId
  if (memberId) {
    const existing = await findMember(db, familyId, openid, memberId)
    if (existing) {
      if (checkConflict) {
        const conflict = _detectMemberConflict(existing, cleanData, userProvidedBirth)
        if (conflict) return { code: 409, needsConfirm: true, msg: '与历史信息矛盾，需代理人确认', data: { memberId: existing.member_id, action: 'pending_confirm', conflict, proposed: cleanData } }
      }
      const ws = writeSeam(db, openid, familyId)
      await ws.silentUpdateDoc('members', existing._id, updateData)
      await ws.triggerHooks()
      return { code: 200, data: { memberId: existing.member_id, action: 'updated' } }
    }
  }

  // memberName + role 匹配
  if (memberName) {
    const query = { family_id: familyId, name: memberName }
    if (role) query.role = role
    const existingRes = await safeQuery(db, 'members', query, openid)
    if (existingRes.data && existingRes.data.length > 0) {
      const ex = existingRes.data[0]
      if (checkConflict) {
        const conflict = _detectMemberConflict(ex, cleanData, userProvidedBirth)
        if (conflict) return { code: 409, needsConfirm: true, msg: '与历史信息矛盾，需代理人确认', data: { memberId: ex.member_id, action: 'pending_confirm', conflict, proposed: cleanData } }
      }
      const ws = writeSeam(db, openid, familyId)
      await ws.silentUpdateDoc('members', ex._id, updateData)
      await ws.triggerHooks()
      return { code: 200, data: { memberId: ex.member_id, action: 'updated' } }
    }
  }

  // 不存在 → 创建
  const newMemberId = 'mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)
  const newMember = {
    member_id: newMemberId,
    family_id: familyId,
    name: memberName || data.name,
    role: role || data.role || '本人',
    status: 'active',
    created_at: now,
    ...updateData
  }
  const ws = writeSeam(db, openid, familyId)
  await ws.silentAdd('members', newMember)
  await ws.triggerHooks()
  return { code: 200, data: { memberId: newMemberId, action: 'created' } }
}

/** 精确修改单个成员字段（dataWrite recordField / updateMember 走此） */
async function setMemberField(db, familyId, openid, memberId, field, value) {
  if (!memberId) return { code: 400, msg: '缺少 memberId' }
  const m = await findMember(db, familyId, openid, memberId)
  if (!m) return { code: 404, msg: '成员不存在：' + memberId }
  // setMemberField 被 recordField 在事务中途调用，不重复触发钩子（由调用方末尾 triggerHooks）
  const ws = writeSeam(db, openid, familyId, { markMutated: false, advanceStageHook: false })
  await ws.silentUpdateDoc('members', m._id, { [field]: value })
  return { code: 200, data: { updated: true, memberId: m.member_id, field, value } }
}

/** 批量更新成员字段（submitProfiling / OCR 匹配走此） */
async function updateMemberFields(db, familyId, openid, memberId, fields) {
  if (!memberId) return { code: 400, msg: '缺少 memberId' }
  const m = await findMember(db, familyId, openid, memberId)
  if (!m) return { code: 404, msg: '成员不存在：' + memberId }
  const patch = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === '') continue
    if (k === 'birth_date') {
      patch.birth_date = v
      const a = calcAgeYears(v)
      if (a) patch.age = a
    } else {
      patch[k] = v
    }
  }
  if (Object.keys(patch).length === 0) return { code: 200, data: { updated: false, memberId: m.member_id } }
  // submitProfiling 批量同步，由调用方末尾统一触发钩子
  const ws = writeSeam(db, openid, familyId, { markMutated: false, advanceStageHook: false })
  await ws.silentUpdateDoc('members', m._id, patch)
  return { code: 200, data: { updated: true, memberId: m.member_id, fields: Object.keys(patch) } }
}

// ---------- finances: upsert by family_id (singleton) ----------
async function upsertFinances(db, familyId, openid, patch) {
  if (!patch || Object.keys(patch).length === 0) return { code: 400, msg: '缺少更新数据' }
  const now = new Date()
  const existing = await safeQuery(db, 'finances', { family_id: familyId }, openid)
  const ws = writeSeam(db, openid, familyId)
  if (existing.data && existing.data.length > 0) {
    await ws.silentUpdateDoc('finances', existing.data[0]._id, { ...patch, updated_at: now })
    await ws.triggerHooks()
    return { code: 200, data: { action: 'updated' } }
  }
  await ws.silentAdd('finances', { family_id: familyId, ...patch, updated_at: now })
  await ws.triggerHooks()
  return { code: 200, data: { action: 'created' } }
}

/** 创建家庭的成员文档（替代写 families.members 内嵌） */
async function createMembersForFamily(db, familyId, openid, members) {
  const now = new Date()
  const docs = (members || []).map(m => {
    const memberId = m.member_id && m.member_id.indexOf('m_') !== 0 ? m.member_id : ('mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6))
    return {
      member_id: memberId,
      family_id: familyId,
      name: m.name || '',
      role: m.role || '',
      age: m.age || 0,
      birth_date: m.birth_date || '',
      gender: m.gender || '',
      occupation: m.occupation || '',
      health: m.health || '',
      income: m.income || 0,
      status: 'active',
      created_at: now,
      updated_at: now
    }
  })
  // createFamily 中间步骤，钩子由调用方末尾统一触发
  const ws = writeSeam(db, openid, familyId, { markMutated: false, advanceStageHook: false })
  const created = await Promise.all(docs.map(doc => ws.silentAdd('members', doc)))
  return created.map((res, i) => ({ ...docs[i], _id: res && res._id }))
}

/** 删除家庭时级联清空成员文档 */
async function deleteMembersForFamily(db, familyId, openid) {
  try {
    const res = await safeQuery(db, 'members', { family_id: familyId }, openid)
    await Promise.all((res.data || []).map(m => db.collection('members').doc(m._id).remove().catch(() => {})))
  } catch (_) { /* 静默 */ }
}

module.exports = {
  getMembers, getFinance, findMember,
  upsertMember, setMemberField, updateMemberFields,
  upsertFinances, createMembersForFamily, deleteMembersForFamily,
  _MEMBER_FIELDS, _MEMBER_FIELD_ZH, calcAgeYears, _shapeMember
}
