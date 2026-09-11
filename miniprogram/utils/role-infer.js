/** role-infer.js — OCR 角色推断纯模块（候选 2 下沉）
 * 自 components/ocr-flow/index.js _runRoleStage/_applyRoleState 提取：
 * 保单人员 → 出生日期 map；年龄差推断 子女/父母/配偶；本人/配偶占用互斥；冲突标注。
 * 零 wx/api 依赖，可被 tests 直接单测。UI/写回留在组件。
 */

// policies → { 姓名: 出生日期 }（投保人/被保人/受益人，后出现覆盖）
function buildBirthMap(policies) {
  const m = {}
  ;(policies || []).forEach(function(p) {
    if (p.policyholder_name && p.policyholder_birth_date) m[p.policyholder_name] = p.policyholder_birth_date
    if (p.insured_name && p.insured_birth_date) m[p.insured_name] = p.insured_birth_date
    if (p.beneficiary_name && p.beneficiary_birth_date) m[p.beneficiary_name] = p.beneficiary_birth_date
  })
  return m
}

// 出生日期 → 周岁（当年减出生年；无效/缺失返回 NaN）
function ageFromBirth(b) {
  if (!b) return NaN
  const d = new Date(b)
  if (isNaN(d.getTime())) return NaN
  return new Date().getFullYear() - d.getFullYear()
}

// 家庭既有 本人/配偶 占用表（全局唯一），携带 memberId 供替换清除
function occupiedRoles(members) {
  const occ = {}
  ;(members || []).forEach(function(m) {
    if (m.role === '本人' || m.role === '配偶') occ[m.role] = { name: m.name, memberId: m.member_id }
  })
  return occ
}

// 按与投保人年龄差推断角色（原 _infer + _inferRole）：
// d > 18 → 子女；d < -18 → 父母；其余 → 配偶。出生缺失/年龄不可比 → '其他'。
// 推断出的 本人/配偶 若已被家庭占用 → '其他'（角色互斥，防双占）
function inferRelation(name, holderAge, birthMap, occupied) {
  const a = ageFromBirth(birthMap && birthMap[name])
  if (isNaN(a) || isNaN(holderAge)) return '其他'
  const d = holderAge - a
  let r = null
  if (d > 18) r = '子女'
  else if (d < -18) r = '父母'
  else r = '配偶'
  if ((r === '本人' || r === '配偶') && occupied && occupied[r]) return '其他'
  return r
}

// 实时互斥标注：家庭占用 + 列表内已选 → 每项 conflict { 角色: 占用者姓名 }（原 _applyRoleState）
function applyRoleConflicts(list, occupied) {
  const occ = {}
  Object.keys(occupied || {}).forEach(function(k) { occ[k] = occupied[k].name })
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    if (r.role === '本人' || r.role === '配偶') occ[r.role] = r.name
  }
  return list.map(function(r) {
    const conflict = {}
    if (occ['本人'] && occ['本人'] !== r.name) conflict['本人'] = occ['本人']
    if (occ['配偶'] && occ['配偶'] !== r.name) conflict['配偶'] = occ['配偶']
    return Object.assign({}, r, { conflict: conflict })
  })
}

module.exports = { buildBirthMap, ageFromBirth, occupiedRoles, inferRelation, applyRoleConflicts }
