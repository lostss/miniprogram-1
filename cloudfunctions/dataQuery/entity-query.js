/**
 * entity-query — 实体查询领域（保单 / 成员 / 事实）
 *
 * 导出：queryPolicies / queryMembers / queryFacts
 *
 * 设计：conversationAI 内部用，统一"validate familyId → 查询 → 过滤 deleted → 返回 {code,msg,data}"模板。
 *      queryPolicies/queryMembers 走 safeQuery 接缝；queryFacts 因动态 where（predicate/subjectId）裸查并自带 _openid 过滤。
 *      集中到同一领域文件提升 locality（架构审计第 10 轮：从 handlers.js 拆分）。
 */
const { safeQuery, safeQueryAll } = require('./_shared/db-helpers')
const { loadActivePolicies } = require('./_shared/policy-read')
const { wrapError } = require('./_shared/errorHandler')
const { axisOf } = require('./_shared/fact-vocab')

// ---------- queryPolicies ----------
// conversationAI 内部用：查家庭保单
// 架构审计第 16 轮候选 #1：读取接缝集中 _openid 注入 + 过滤 deleted 两件套
async function queryPolicies(db, openid, event) {
  const { familyId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  try {
    const policies = await loadActivePolicies(db, familyId, openid, { ensureStatus: false })
    return { code: 200, data: { policies } }
  } catch (e) {
    return wrapError('获取保单', e)
  }
}

// ---------- queryMembers ----------
// conversationAI 内部用：查家庭成员（含 member_id，投影完整）
async function queryMembers(db, openid, event) {
  const { familyId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  try {
    const res = await safeQuery(db, 'members', { family_id: familyId }, openid, { limit: 50 })
    const members = (res.data || []).filter(m => m.status !== 'deleted')
    return { code: 200, data: { members } }
  } catch (e) {
    return wrapError('获取成员', e)
  }
}

// ---------- queryFacts ----------
// conversationAI 内部用：查家庭事实三元组（投影含 subject_id/subject_type，防关联丢失）
async function queryFacts(db, openid, event) {
  // K-S1 修复：AI 工具 schema 参数名为 memberId（conversationAI/tools.js），兼容 subjectId 旧调用
  // 2026-09-14：新增 includePolicyAttrs（默认 false）——保单节点属性（subject_type='policy'：险种/保额/
  // 生效日…约 10 条/保单）是「保单实体的字段」，已由 queryPolicies 与报告「保障汇总/附录保单明细」承载；
  // 混进事实流会把人员信息（收入/职业/约束/线索）挤出前端档案卡片的截断窗口。需要时显式传 true。
  const { familyId, predicate, subjectId, memberId, includePolicyAttrs } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  try {
    const where = { family_id: familyId, _openid: openid, status: 'active' }
    if (predicate) where.predicate = predicate
    const sid = subjectId || memberId
    if (sid) where.subject_id = sid
    // 2026-09-10：改走 safeQueryAll 自动分页——固定 limit(300) 只是把平台截断点后移，
    // facts 随版本历史持续增长（该家庭已 227 条），迟早越界且无告警
    const res = await safeQueryAll(db, 'facts', where, openid, { maxPages: 10 })
    const rows = includePolicyAttrs === true ? (res.data || []) : (res.data || []).filter(f => f.subject_type !== 'policy')
    const facts = rows.map(f => ({
      _id: f._id,
      subject_id: f.subject_id || '',
      subject_type: f.subject_type || '',
      subject_name: f.subject_name || '',
      predicate: f.predicate || '',
      axis: f.axis || '',
      kind: f.kind || 'fact',
      object_value: f.object_value || '',
      object_id: f.object_id || '',
      object_type: f.object_type || '',
      confidence: f.confidence != null ? f.confidence : 1,
      source: f.source || '',
      created_at: f.created_at
    }))
    return { code: 200, data: { facts } }
  } catch (e) {
    return wrapError('获取事实', e)
  }
}

// ---------- queryMemberProfile ----------
// P1-3：对话AI精简查询——单成员画像（基础属性 + 健康人况 + 保障清单）
// 用于回答"王先生有什么保险""王先生的健康情况"等，避免 queryFacts 返回300条让AI自己筛选
async function queryMemberProfile(db, openid, event) {
  const { familyId, memberId, memberName } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  if (!memberId && !memberName) return { code: 400, msg: '缺少 memberId 或 memberName' }
  try {
    // 定位成员
    // 2026-09-22 全面审计 P2：两处定位都必须排除软删成员，否则已删成员仍能被
    // queryMemberProfile 读出（属性 + 保障清单），与同文件 queryMembers（下方 L36 的 filter）
    // 和 getMembers 的口径不一致
    const _notDeleted = db.command.neq('deleted')
    let member = null
    if (memberId) {
      const r = await db.collection('members').where({ family_id: familyId, _openid: openid, member_id: memberId, status: _notDeleted }).limit(1).get()
      if (r.data && r.data.length) member = r.data[0]
    }
    if (!member && memberName) {
      const r = await db.collection('members').where({ family_id: familyId, _openid: openid, name: memberName, status: _notDeleted }).limit(1).get()
      if (r.data && r.data.length) member = r.data[0]
    }
    if (!member) return { code: 404, msg: '未找到成员：' + (memberName || memberId) }

    // 并行查 facts 和 policies
    // 2026-09-11 修复（全面审计 P1-1）：原 policies 查询带 `.catch(() => ({ data: [] }))`，查询失败被
    // **完全静默**地吞成"该成员无保单"（同批 facts 走的 safeQueryAll 虽也降级，但会 console.error 留痕）。
    // 保单是本工具回答的核心数据（"他有什么保险"），降级成空会让 AI 断言"该成员没有保障"——足以误导
    // 加保/退保决策，故此处选择**失败即抛**（→ 外层 wrapError 转 500），而非静默降级。
    const mid = member.member_id
    const [factRes, policyRes] = await Promise.all([
      safeQueryAll(db, 'facts', { family_id: familyId, subject_id: mid, status: 'active' }, openid),
      db.collection('policies').where({ family_id: familyId, _openid: openid, member_id: mid, status: db.command.neq('deleted') }).limit(20).get()
    ])

    // 按归一化属性槽（axis）分组 facts
    // 2026-09-14：原按 predicate 字面量白名单分组，谓词自由化后（"年薪" ≠ "个人年收入"）会漏；
    // axisOf 把同义说法归到同一槽。非标信息（axis 为空）统一落 other_facts 并带 kind，避免把约束/线索当普通事实读。
    const facts = factRes.data || []
    const _ax = f => f.axis || axisOf(f.predicate)
    const _pick = axList => facts.filter(f => axList.indexOf(_ax(f)) !== -1)
    const _mapf = arr => arr.map(f => ({ predicate: f.predicate, axis: f.axis || '', kind: f.kind || 'fact', value: f.object_value, confidence: f.confidence, source: f.source || '' }))
    const HEALTH_AXES = ['健康异常']
    const ECON_AXES = ['职业', '个人年收入', '收入来源', '抚养赡养人数', '社保情况']
    const GOAL_AXES = ['未来计划', '教育规划', '退休规划', '传承意图', '资产隔离需求', '婚嫁规划', '退休预期年龄', '子女教育节点', '婚嫁预期时点']
    const _groupedAxes = new Set(HEALTH_AXES.concat(ECON_AXES, GOAL_AXES))
    const profile = {
      member: {
        member_id: mid,
        name: member.name || '',
        role: member.role || '',
        gender: member.gender || '',
        birth_date: member.birth_date || '',
        age: member.age || 0,
        occupation: member.occupation || '',
        health: member.health || '',
        income: member.income || 0
      },
      // 健康人况类
      health: _mapf(_pick(HEALTH_AXES)),
      // 经济依赖类
      economic: _mapf(_pick(ECON_AXES)),
      // 财富目标类（传承/规划/隔离）
      goals: _mapf(_pick(GOAL_AXES)),
      // 保障清单（policies 集合）
      policies: (policyRes.data || []).map(p => ({
        policy_id: p.id || p._id || '',
        product_name: p.product_name || '',
        insurance_category: p.insurance_category || '',
        sum_assured: p.sum_assured || 0,
        annual_premium: p.annual_premium || 0,
        insurer: p.insurer || '',
        effective_date: p.effective_date || '',
        status: p.status || 'active'
      })),
      // 其他已记录事实（含非标信息：约束/关系/线索一并带出，不丢；kind 由消费方按需区分）
      other_facts: _mapf(facts.filter(f => !_groupedAxes.has(_ax(f))))
    }
    return { code: 200, data: { profile } }
  } catch (e) {
    return wrapError('获取成员画像', e)
  }
}

module.exports = { queryPolicies, queryMembers, queryFacts, queryMemberProfile }
