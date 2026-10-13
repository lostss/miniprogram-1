/**
 * fact-write — 事实（facts）写入领域
 *
 * 导出：addFact / updateFactConfidence / deleteFact
 * 常量：DIM_TO_PREDICATE
 * 2026-09-27（dsh 审计 P3）：`addMemberFact` 函数与导出、`strategyOf` 再导出均已删除（详见各自原位注释）。
 *
 * 依赖关系（单向，无循环）：
 *   - fact-write → fact-member-sync（_syncFactToMember，仅反向同步）
 *   - member-write / message-write → fact-write（`addFact` / DIM_TO_PREDICATE）
 *   架构审计第 13 轮：_writeMemberFact 曾移回本文件改名 addMemberFact（现删除），
 *   fact-member-sync 仅保留 fact→members 反向同步，循环依赖彻底消失，懒加载删除。
 */
const _ = require('wx-server-sdk').database().command
const { writeSeam } = require('./_shared/writeSeam')
const { _syncFactToMember } = require('./fact-member-sync')
const { detectInjection } = require('./_shared/guard')
const { desensitize } = require('./_shared/pii-rules')
const { AXIS_SET, axisOf, kindOf, strategyOf } = require('./_shared/fact-vocab')

// S2：表单路径维度 → 统一谓词（predicate 三元组），使 submitProfiling 写入的 fact 在报告/分析中可见
// 单一事实源：家庭级（收入/负债/年保费预算）+ 成员级（职业/健康/教育程度/偏好/年龄/性别）
// 2026-09-12 字段治理：固定支出维度已移除（数据模型不再有该字段）
const DIM_TO_PREDICATE = {
  '收入': '个人年收入', '职业': '职业', '健康': '健康异常',
  // 2026-09-12 用词统一：维度标签兼容「负债」与「总负债」，写入谓词统一为「总负债」
  '负债': '总负债', '总负债': '总负债',
  '教育程度': '教育程度', '偏好': '有偏好',
  '年龄': '年龄', '性别': '性别', '年保费预算': '年保费预算'
}

// 2026-09-14：PREDICATE_NORMALIZE 手写同义表已删除 → 归一化迁移到 _shared/fact-vocab.js（axis 字典）。
// 关键语义变化：谓词不再被"替换"为规范词（保留 AI 原话，见 addFact），归一化结果落 axis 字段；
// 未命中槽的事实 axis 留空但照常落库（旧实现未命中即被谓词字面量困住，消费侧白名单再筛一次 = 等于没采）。

// ---------- addFact ----------
// S2 统一事实 schema：predicate 三元组（CONTEXT.md 规范）。conversationAI.addFact 经 dataWrite 网关调用
// 2026-09-14：FACT_STRATEGIES（66 谓词手写表）已删除 → 写策略由 _shared/fact-vocab 的 axis 派生：
//   - versioned：属性/状态/数值类槽，新值覆盖旧值（旧值 superseded）
//   - dedup：关系/事件/多值类，同值不重复写入（未命中槽的默认）
// 旧表的问题：谓词不在表中 → 兜底「备注/有特征」→ 语义被压平，消费侧白名单再筛一次 = 等于没采。
// addFact 重构（全部重构）：
// - 支持直接传入 subjectId/subjectType（结构化路径如保单节点），或仅 subjectName（对话路径按姓名解析 member_id）
// - objectType 支持 'policy'，objectId 可指向保单
// - 开放谓词：未知 predicate 默认 dedup，支持目的驱动提取（不再硬阻断）
// - confidence 可覆盖（OCR 透传真实置信度）
async function addFact(db, openid, event) {
  const {
    familyId,
    subjectName, subjectId, subjectType = 'member',
    predicate: rawPredicate,
    objectValue, objectName, objectId = '', objectType = 'literal',
    kind: rawKind, axis: rawAxis,
    reasoning, source = 'ai', confidence = 0.9
  } = event
  const conf = Math.max(0, Math.min(1, Number(confidence) || 0))
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!rawPredicate || objectValue == null || objectValue === '') return { code: 400, msg: '缺少 predicate/objectValue' }
  // 安全审计 H3：AI 产出内容写入前注入检测（防提示词注入产物持久化成二次注入载体，与 upsertMember/writePolicy 对齐）
  // 2026-09-28 全面审计 P2（已实测复现）：原判据只覆盖 objectValue + reasoning，**漏了 predicate** ——
  // 同一句"忽略以上所有指令…"作为 objectValue 被 400 拦截，作为 predicate 却 200 原样入库；
  // 而 predicate 会被 familyPortrait._groupFacts 当作 label 渲染进**后续每一条** AI 上下文
  // （画像/报告）→ 正是本行注释声称要防的"持久化成二次注入载体"。现逐字段检测。
  if (detectInjection(String(rawPredicate) + ' ' + String(objectValue) + ' ' + String(reasoning || '')).injected) {
    return { code: 400, msg: '内容校验未通过，已拦截' }
  }
  // 安全审计 P1-2：objectValue/reasoning 落库前脱敏（纵深防御，AI/表单双路径）。
  // 注意：解构参数为 const 绑定不可重赋值，用 safe* 局部变量
  const safeObjectValue = desensitize(String(objectValue))
  const safeReasoning = reasoning ? desensitize(String(reasoning)) : ''
  // 2026-09-14 事实体系：predicate 保留 AI 原话（开放写入），归一化结果落 axis（未命中留空，不丢弃）
  const predicate = String(rawPredicate).slice(0, 60)
  const axis = (rawAxis && AXIS_SET.has(rawAxis)) ? rawAxis : axisOf(predicate)
  const kind = kindOf(predicate, rawKind)

  let resolvedSubjectId = subjectId
  let resolvedSubjectType = subjectType
  let resolvedSubjectName = subjectName || ''
  // 对话路径：仅给 subjectName，按姓名解析 member_id（subject_type 默认 member）
  // 2026-09-28 审计 P3（已实测复现）：必须排除软删成员，否则新写的 active fact 会挂到已删成员上
  // —— 与已决「删除规则」（成员软删 ⇒ 其 facts 置 superseded）相反：那次清理已经跑过，
  // 这条新 fact 不会再被清，画像又跳过已删成员 → 只剩 queryFacts/孤儿保障提示会读到它。
  if (!resolvedSubjectId && resolvedSubjectName) {
    const subRes = await db.collection('members')
      .where({ family_id: familyId, _openid: openid, name: resolvedSubjectName, status: db.command.neq('deleted') })
      .limit(1).get()
    if (!subRes.data || subRes.data.length === 0) return { code: 404, msg: '未找到主体成员：' + resolvedSubjectName }
    resolvedSubjectId = subRes.data[0].member_id
    resolvedSubjectType = 'member'
  }
  // P1-D1 修复（2026-09-05）：family 级决策备注（deletePolicy/updatePolicy 状态留痕）——
  // subjectType='family' 且无 subjectId 时以 familyId 为主体。此前无此分支，备注 addFact 恒 400，
  // 备注永不落库且 triggerHooks 不触发（deletePolicy/updatePolicy 全程 silent 写，钩子依赖 addFact）
  if (!resolvedSubjectId && resolvedSubjectType === 'family' && familyId) {
    resolvedSubjectId = familyId
  }
  if (!resolvedSubjectId) return { code: 400, msg: '缺少主体标识（subjectId 或 subjectName）' }

  const now = new Date()
  const strategy = strategyOf(predicate, axis)
  // writeSeam 接缝：silent 写入 + 末尾统一 triggerHooks，避免多次 markFamilyMutated
  const ws = writeSeam(db, openid, familyId)
  if (strategy === 'dedup') {
    // 去重键含 axis：同槽的不同说法（"年薪" 与 "个人年收入"）算同一条，避免重复落库
    const dupWhere = { family_id: familyId, _openid: openid, subject_id: resolvedSubjectId, object_value: safeObjectValue, status: 'active' }
    if (axis) dupWhere.axis = axis
    else dupWhere.predicate = predicate
    const exists = await db.collection('facts').where(dupWhere).limit(1).get()
    if (exists.data && exists.data.length > 0) return { code: 200, data: { action: 'skipped', reason: '已存在' } }
  }
  let resolvedObjectId = objectId
  if (objectType === 'member' && objectName && !resolvedObjectId) {
    // 同上：对象侧同样排除软删成员（关系边不应指向已删成员）
    const objRes = await db.collection('members')
      .where({ family_id: familyId, _openid: openid, name: objectName, status: db.command.neq('deleted') })
      .limit(1).get()
    if (objRes.data && objRes.data.length > 0) resolvedObjectId = objRes.data[0].member_id
  }
  const addRes = await ws.silentAdd('facts', {
    family_id: familyId,
    subject_type: resolvedSubjectType, subject_id: resolvedSubjectId, subject_name: resolvedSubjectName,
    predicate, axis, kind,
    object_type: objectType, object_id: resolvedObjectId, object_value: safeObjectValue, object_value_type: 'string',
    confidence: conf, source, status: 'active', reasoning: safeReasoning, created_at: now
  })
  // 审计 H2：先 add 后 supersede，并在 where 排除刚写入的 fact——
  // 原"先 supersede 后 add"在同轮并发 addFact（writePolicy→policyToFacts 多 fact 并发）时旧值链互相作废
  if (strategy === 'versioned') {
    // 5.2b：已 agent_confirmed 的事实不被普通事实覆盖（除非新事实也是 agent_confirmed）
    // 2026-09-14：按归一化槽（axis）消解——同槽不同说法（"年薪"/"个人年收入"）也要互相作废；未归一的退回谓词字面量
    const whereActive = { family_id: familyId, subject_id: resolvedSubjectId, status: 'active' }
    if (axis) whereActive.axis = axis
    else whereActive.predicate = predicate
    if (source !== 'agent_confirmed' && _ && typeof _.neq === 'function') whereActive.source = _.neq('agent_confirmed')
    if (addRes && addRes._id && _ && typeof _.neq === 'function') whereActive._id = _.neq(addRes._id)
    await ws.silentUpdateWhere('facts', whereActive, { status: 'superseded' }).catch(async (e) => {
      console.error('[dataWrite] addFact versioned supersede 失败:', e.message)
      // 回滚刚写入的事实，保持"作废旧值+入新值"原子语义
      await ws.silentRemoveDoc('facts', addRes._id).catch(function() {})
      throw new Error('旧事实作废失败：' + e.message)
    })
  }
  await ws.triggerHooks()
  // 高置信度事实反向同步回 members（健康/职业/收入）。原注写"覆盖对话路径（表单路径由 addMemberFact 同步）"——
  // addMemberFact 已于 2026-09-27 作为死代码删除，此处只陈述本函数实际所做的事（反向同步）。
  // 2026-09-14：按 axis 判定目标字段（predicate 已自由化，不能再靠字面量匹配）
  await _syncFactToMember(db, familyId, openid, resolvedSubjectId, axis, safeObjectValue, conf)
  return { code: 200, data: { action: strategy === 'dedup' ? 'added' : strategy, factId: addRes._id } }
}

// ---------- addMemberFact：已于 2026-09-27 删除（dsh 审计 P3 · 死代码）----------
// 它原是「成员级事实统一写入」的便捷入口（预设 subjectType:'member' + source:'user_form'），
// 但全仓 grep 确认**零调用方**：member-write / message-write 都是直接调 `addFact`，
// 文件头与 fact-member-sync 的注释却仍写着"member-write / message-write → fact-write（addMemberFact）"
// —— 过时注释会让下一个读者以为它在用（本次审计即据此把它列为"零调用方，请确认"）。
// 结论：函数与其导出、以及那两处过时注释一并清理。

// ---------- updateFactConfidence ----------
// 5.2a：代理人确认低置信度事实后，将其置信度升级为 1.0 并标记 agent_confirmed（受 5.2b 防降级/防覆盖保护）
// Bug-4 修复：重新激活已 superseded 的事实前，先 supersede 同 subject+predicate 的其他 active 事实，避免多 active
async function updateFactConfidence(db, openid, event) {
  const { familyId, factId, confidence = 1, source = 'agent_confirmed' } = event
  if (!familyId || !factId) return { code: 400, msg: '缺少 familyId/factId' }
  const cur = await db.collection('facts').doc(factId).get().catch(() => ({ data: null }))
  const rec = cur.data
  if (!rec || rec._openid !== openid || rec.family_id !== familyId) return { code: 404, msg: '未找到该事实或无权修改' }
  const ws = writeSeam(db, openid, familyId)
  // 重新激活前，先 supersede 同 subject+predicate 的其他 active 事实（避免多 active 并存）
  // K-S4 修复：与 addFact versioned 路径（5.2b）对齐——被激活的事实若非 agent_confirmed，
  // 不得覆盖同 subject+predicate 下已 agent_confirmed 的用户确认事实
  if (rec.subject_id && (rec.axis || rec.predicate)) {
    const _ = db.command
    const whereSupersede = {
      family_id: familyId, _openid: openid,
      subject_id: rec.subject_id,
      status: 'active', _id: _.neq(factId)
    }
    // 按归一化槽消解；未归一的退回谓词字面量
    if (rec.axis) whereSupersede.axis = rec.axis
    else whereSupersede.predicate = rec.predicate
    if (rec.source !== 'agent_confirmed') whereSupersede.source = _.neq('agent_confirmed')
    await ws.silentUpdateWhere('facts', whereSupersede, { status: 'superseded' }).catch(e => console.error('[fact-write] updateFactConfidence supersede 失败:', e.message))
  }
  await ws.updateDoc('facts', factId, { confidence, source, status: 'active' })
  return { code: 200, data: { factId, confidence, source } }
}

// ---------- deleteFact ----------
// 软删事实（status:'superseded'），保留可追溯
async function deleteFact(db, openid, event) {
  const { familyId, factId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!factId) return { code: 400, msg: '缺少 factId' }
  const r = await db.collection('facts').where({ _id: factId, family_id: familyId, _openid: openid }).limit(1).get()
  if (!r.data || !r.data.length) return { code: 404, msg: '未找到该事实' }
  const fact = r.data[0]
  const ws = writeSeam(db, openid, familyId, { advanceStageHook: false })
  await ws.updateDoc('facts', fact._id, { status: 'superseded' }).catch(e => { console.error('[dataWrite] deleteFact 失败:', e.message); throw new Error('事实删除失败：' + e.message) })
  // P2-A 修复：关系类谓词（配偶/子女/父母）删除时同步清理对向事实，防孤儿关系边残留（对齐 member-write.deleteMember P0-3）
  if (['配偶', '子女', '父母'].includes(fact.predicate) && fact.subject_id) {
    await ws.silentUpdateWhere('facts',
      { family_id: familyId, predicate: fact.predicate, object_id: fact.subject_id, status: 'active', _id: _.neq(fact._id) },
      { status: 'superseded' }
    ).catch(e => console.error('[dataWrite] deleteFact 反向关系清理失败:', e.message))
  }
  return { code: 200, data: { deleted: true, factId } }
}

// 2026-09-27（dsh 审计 P3）：`strategyOf` 的**再导出**已删 —— 它在本文件 L88 仍被调用（保留顶部 import），
// 但没有第二个消费方从本模块取它（测试与其他模块一律直接从契约 `_shared/fact-vocab` 取）→ 再导出是死面。
module.exports = { addFact, updateFactConfidence, deleteFact, DIM_TO_PREDICATE }
