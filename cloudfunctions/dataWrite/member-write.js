/**
 * member-write — 成员操作领域
 *
 * 导出：recordField / updateMember / deleteMember
 *
 * 依赖关系（单向，无循环）：
 *   - member-write → fact-write（addFact / DIM_TO_PREDICATE）
 *   - fact-write → fact-member-sync（_syncFactToMember）
 */
const { detectInjection } = require('./_shared/guard')
const { writeSeam } = require('./_shared/writeSeam')
const { ALLOWED_DIMENSIONS, FAMILY_DIMENSIONS_ZH, ZH_TO_EN } = require('./member-dimensions')
const { setMemberField, upsertFinances, _MEMBER_FIELDS } = require('./_shared/memberRepo')
const { VALID_ROLES } = require('./constants')
// 成员移除的事实层清理：与 family-write._syncMembers 软删路径共用同一实现
// （2026-09-19 抽出；2026-09-20 曾加"保单解链"，2026-09-22 因**无效且违反数据模型规则**已回退，
//   证据与原因见 member-facts.js 文件头）
const { supersedeMemberFacts } = require('./member-facts')
const { addFact, DIM_TO_PREDICATE } = require('./fact-write')

// ---------- recordField ----------
// Plan A：家庭级财务 → finances 集合；成员级字段 → members 集合（唯一真相源）
async function recordField(db, openid, event) {
  const familyId = event.familyId
  let memberId = event.memberId || (event.data && event.data.memberId) || null
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  const data = event.data
  if (!data || !data.dimension || !data.value) return { code: 400, msg: '缺少事实数据（dimension/value）' }
  if (!ALLOWED_DIMENSIONS.has(data.dimension)) return { code: 400, msg: '不支持的维度：' + data.dimension }
  const scope = FAMILY_DIMENSIONS_ZH.has(data.dimension) ? 'family' : 'member'
  if (scope === 'family') memberId = null
  const valueStr = String(data.value)
  if (valueStr.length > 200) return { code: 400, msg: '事实值过长（≤200字）' }
  if (detectInjection(valueStr).injected || detectInjection(data.dimension).injected) {
    return { code: 400, msg: '内容校验未通过' }
  }

  // 家庭级财务维度 → finances 集合
  // 2026-09-27：目标键改为**规范元键**。原先借 `income`/`debt` 这些万口径旧名、再由 memberRepo 的
  // 别名表 1:1 归一 —— 能work，但让"这个数字是万还是元"在调用处完全看不出来（本次审计即因此起疑）。
  const FIN_SYNC = { '收入': 'annual_income', '负债': 'total_debt', '总负债': 'total_debt', '年保费预算': 'annual_premium_budget' }
  if (scope === 'family' && FIN_SYNC[data.dimension]) {
    // 契约：金额必须是数字，单位=元（与 updateFinances 工具 schema 一致），**不接受带单位文本** ——
    // 上层应转换后再传，传错就直接报错，不静默写坏数据。
    // 收入支 2026-09-22 已如此（原实现 isNaN 时原样落库字符串 "30万" → 读取侧 _toWan 得 NaN →
    // 家庭年收入变 null、报告写"未填写"；实测复现，见 tests/data-quality-batch1 ③）。
    // 负债支原先**开例外**：从自由文本里抠第一个数字（'房贷150万' → 150）直接落库 → 写进元字段
    // 等于**少报 10000 倍**；且 `[一-龥]+` 连单位字一起抠成负债类型（'房贷万'）。现与收入支同契约。
    // 负债类型不再从金额文本里猜：改由 `updateFinances` 传入（其白名单与 AI schema 均含 debt_type）。
    const num = Number(data.value)
    if (!isFinite(num)) return { code: 400, msg: data.dimension + ' 必须是数字（单位：元）' }
    const patch = {}
    patch[FIN_SYNC[data.dimension]] = num
    await upsertFinances(db, familyId, openid, patch)
    // upsertFinances 内部经 writeSeam 已触发 markMutated + advanceStage，无需重复
    return { code: 200, data: { written: true, scope } }
  }

  // 成员级维度 → members 集合 + facts 集合（双写）
  // 2026-09-22 全面审计 P0-1：memberField 原声明在下方 if 块内（块级作用域），
  // 却在 L78（块外）被引用 → 命中 pred 的成员级维度必抛 ReferenceError，
  // 被 createHandler 兜成 500「写入失败」。而 L75 的 addFact 已先落库 →
  // **事实已写入、钩子未触发、用户看到失败**（重试即产生重复事实）。
  // 现提升到函数级作用域，两处引用同一变量。
  const memberField = scope === 'member' && memberId ? ZH_TO_EN[data.dimension] : undefined
  if (scope === 'member' && memberId) {
    if (memberField) {
      const numMatch = String(data.value).match(/(\d+)/)
      const val = data.dimension === '年龄' ? (numMatch ? parseInt(numMatch[1], 10) : data.value) : data.value
      const r = await setMemberField(db, familyId, openid, memberId, memberField, val)
      if (r.code !== 200) return r
    }
  }
  // 无论家庭/成员维度，同步写入 facts 集合（portrait 消费源）
  const pred = DIM_TO_PREDICATE[data.dimension]
  if (pred) {
    await addFact(db, openid, { familyId, subjectId: memberId || '', subjectType: memberId ? 'member' : 'family', subjectName: '', predicate: pred, objectValue: valueStr, source: 'user_form', confidence: 1 })
    // addFact 内部经 writeSeam 已触发 markMutated + advanceStage，无需重复
    // setMemberField 用 silent 模式未触发钩子，此处补一次确保成员字段变更也触发
    if (scope === 'member' && memberId && memberField) {
      const ws = writeSeam(db, openid, familyId)
      await ws.triggerHooks()
    }
    return { code: 200, data: { written: true, scope } }
  }
  // 仅 setMemberField（无 facts 同步）→ 手动触发钩子
  const ws = writeSeam(db, openid, familyId)
  await ws.triggerHooks()
  return { code: 200, data: { written: true, scope } }
}

// ---------- updateMember ----------
// Plan A：直接修改 members 集合中某个成员的指定字段
async function updateMember(db, openid, event) {
  const { familyId, memberId, field, value, data } = event
  const memId = memberId || (data && data.memberId)
  const fld = field || (data && data.field)
  const val = value !== undefined ? value : (data && data.value)
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!memId) return { code: 400, msg: '缺少参数 memberId' }
  if (!fld) return { code: 400, msg: '缺少参数 field' }

  // 候选 4：白名单单源（memberRepo._MEMBER_FIELDS），避免第二份文本漂移
  if (!_MEMBER_FIELDS.includes(fld)) return { code: 400, msg: '不允许修改成员字段：' + fld }

  // 校验值
  let safeValue = val
  if (fld === 'age' || fld === 'income') {
    const n = Number(val)
    if (isNaN(n)) return { code: 400, msg: fld + ' 必须为数字' }
    safeValue = fld === 'age' ? Math.floor(n) : n
  } else if (fld === 'gender') {
    if (!['男', '女'].includes(String(val))) return { code: 400, msg: 'gender 必须为"男"或"女"' }
    safeValue = String(val)
  } else if (fld === 'role') {
    if (!VALID_ROLES.includes(String(val))) return { code: 400, msg: 'role 必须为：' + VALID_ROLES.join('/') }
    safeValue = String(val)
  } else {
    safeValue = String(val)
    if (safeValue.length > 100) return { code: 400, msg: fld + ' 过长（≤100字）' }
    if (detectInjection(safeValue).injected) return { code: 400, msg: '内容校验未通过' }
  }

  const r = await setMemberField(db, familyId, openid, memId, fld, safeValue)
  if (r.code !== 200) return r
  // B2: 成员字段变更 → 经 writeSeam 统一触发 markMutated + advanceStage（setMemberField 内部 silent 未触发）
  const ws = writeSeam(db, openid, familyId)
  await ws.triggerHooks()
  return { code: 200, data: { updated: true, memberId: memId, field: fld, value: safeValue } }
}

// ---------- deleteMember ----------
// 单成员删除：移除 members 文档 + 级联软删该成员相关事实
// P0-3：补充反向关系清理——其他成员指向被删成员的关系边（配偶/子女/父母）也需 supersede
async function deleteMember(db, openid, event) {
  const { familyId, memberId, memberName } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!memberId && !memberName) return { code: 400, msg: '缺少 memberId 或 memberName' }
  let target = null
  if (memberId) {
    const r = await db.collection('members').where({ family_id: familyId, _openid: openid, member_id: memberId }).limit(1).get()
    if (r.data && r.data.length) target = r.data[0]
  }
  if (!target && memberName) {
    const r = await db.collection('members').where({ family_id: familyId, _openid: openid, name: memberName }).limit(1).get()
    if (r.data && r.data.length) target = r.data[0]
  }
  if (!target) return { code: 404, msg: '未找到该成员' }
  const mid = target.member_id
  const ws = writeSeam(db, openid, familyId)
  // S2-4 修复：不再静默吞错，失败时聚合标记返回 partial，让用户知道删除未完成
  const failures = []
  await ws.silentRemoveDoc('members', target._id).catch(e => { console.error('[dataWrite] deleteMember 失败:', e.message); failures.push('members') })
  // 正向 facts + P0-3 反向关系边清理（2026-09-19：抽到 dataWrite/member-facts.js，
  // 与 updateFamily.members 整组覆盖的软删路径共用同一实现——后者原先完全不做清理，
  // 报告页删除成员会留下 active 的孤儿事实）。返回失败标签，保持本函数 207 partial 语义不变。
  failures.push(...await supersedeMemberFacts(db, ws, familyId, openid, mid))
  await ws.triggerHooks()
  if (failures.length > 0) return { code: 207, partial: true, msg: '部分删除失败：' + failures.join(','), data: { deleted: failures.length === 0, memberId: mid, name: target.name } }
  return { code: 200, data: { deleted: true, memberId: mid, name: target.name } }
}

module.exports = { recordField, updateMember, deleteMember }
