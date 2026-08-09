/**
 * entity-query — 实体查询领域（保单 / 成员 / 事实）
 *
 * 导出：queryPolicies / queryMembers / queryFacts
 *
 * 设计：conversationAI 内部用，统一"validate familyId → 查询 → 过滤 deleted → 返回 {code,msg,data}"模板。
 *      queryPolicies/queryMembers 走 safeQuery 接缝；queryFacts 因动态 where（predicate/subjectId）裸查并自带 _openid 过滤。
 *      集中到同一领域文件提升 locality（架构审计第 10 轮：从 handlers.js 拆分）。
 */
const { safeQuery } = require('./_shared/db-helpers')
const { loadActivePolicies } = require('./_shared/policy-read')
const { wrapError } = require('./_shared/errorHandler')

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
  const { familyId, predicate, subjectId, memberId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  try {
    const where = { family_id: familyId, _openid: openid, status: 'active' }
    if (predicate) where.predicate = predicate
    const sid = subjectId || memberId
    if (sid) where.subject_id = sid
    const res = await db.collection('facts').where(where).limit(300).get().catch(() => ({ data: [] }))
    const facts = (res.data || []).map(f => ({
      _id: f._id,
      subject_id: f.subject_id || '',
      subject_type: f.subject_type || '',
      subject_name: f.subject_name || '',
      predicate: f.predicate || '',
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
    let member = null
    if (memberId) {
      const r = await db.collection('members').where({ family_id: familyId, _openid: openid, member_id: memberId }).limit(1).get()
      if (r.data && r.data.length) member = r.data[0]
    }
    if (!member && memberName) {
      const r = await db.collection('members').where({ family_id: familyId, _openid: openid, name: memberName }).limit(1).get()
      if (r.data && r.data.length) member = r.data[0]
    }
    if (!member) return { code: 404, msg: '未找到成员：' + (memberName || memberId) }

    // 并行查 facts 和 policies
    const mid = member.member_id
    const [factRes, policyRes] = await Promise.all([
      db.collection('facts').where({ family_id: familyId, _openid: openid, subject_id: mid, status: 'active' }).limit(100).get().catch(() => ({ data: [] })),
      db.collection('policies').where({ family_id: familyId, _openid: openid, member_id: mid, status: db.command.neq('deleted') }).limit(20).get().catch(() => ({ data: [] }))
    ])

    // 按维度分组 facts
    const facts = factRes.data || []
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
      health: facts.filter(f => ['健康异常', '病史时间线', '吸烟习惯', '饮酒习惯', 'BMI指数'].includes(f.predicate)).map(f => ({ predicate: f.predicate, value: f.object_value, confidence: f.confidence })),
      // 经济依赖类
      economic: facts.filter(f => ['职业', '个人年收入', '收入来源', '抚养赡养人数', '社保情况'].includes(f.predicate)).map(f => ({ predicate: f.predicate, value: f.object_value, confidence: f.confidence })),
      // 财富目标类（传承/规划/隔离）
      goals: facts.filter(f => ['未来计划', '教育规划', '退休规划', '传承意图', '资产隔离需求', '婚嫁规划', '退休预期年龄', '子女教育节点', '婚嫁预期时点'].includes(f.predicate)).map(f => ({ predicate: f.predicate, value: f.object_value, confidence: f.confidence })),
      // 保障清单（policies 集合）
      policies: (policyRes.data || []).map(p => ({
        policy_id: p.id || '',
        product_name: p.product_name || '',
        insurance_category: p.insurance_category || '',
        sum_assured: p.sum_assured || 0,
        annual_premium: p.annual_premium || 0,
        insurer: p.insurer || '',
        effective_date: p.effective_date || '',
        status: p.status || 'active'
      })),
      // 其他已记录事实（兜底展示，不含上面已分组的）
      other_facts: facts.filter(f => !['健康异常', '病史时间线', '吸烟习惯', '饮酒习惯', 'BMI指数', '职业', '个人年收入', '收入来源', '抚养赡养人数', '社保情况', '未来计划', '教育规划', '退休规划', '传承意图', '资产隔离需求', '婚嫁规划', '退休预期年龄', '子女教育节点', '婚嫁预期时点'].includes(f.predicate)).map(f => ({ predicate: f.predicate, value: f.object_value, confidence: f.confidence }))
    }
    return { code: 200, data: { profile } }
  } catch (e) {
    return wrapError('获取成员画像', e)
  }
}

module.exports = { queryPolicies, queryMembers, queryFacts, queryMemberProfile }
