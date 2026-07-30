/**
 * family-detail — 家庭详情查询领域
 *
 * 导出：getFamilyDetail
 *
 * 设计：报告页/详情页用，组装 families + members + financial_snapshot + policies + report。
 *      loadFamilyView 与 policies 查询并行，省一次串行往返。
 */
const { loadFamilyView } = require('./_shared/familyView')
const { loadActivePolicies } = require('./_shared/policy-read')
const { toReadReport } = require('./_shared/report-fields')
const { wrapError } = require('./_shared/errorHandler')

// ---------- getFamily ----------
// 报告页/详情页用：组装 families + members + financial_snapshot + policies + report
async function getFamilyDetail(db, openid, event) {
  const { familyId } = event
  if (!familyId) return { code: 400, msg: '缺少参数 familyId' }
  try {
    // loadFamilyView（内部 3 集合并行）与 policies 查询并行，省一次串行往返
    // 架构审计第 16 轮候选 #1：policies 读取走 loadActivePolicies 接缝，
    // 集中 _openid 注入 + 过滤 deleted + ensureStatusBatch 三件套
    const [family, policies] = await Promise.all([
      loadFamilyView(db, openid, familyId),
      loadActivePolicies(db, familyId, openid)
    ])
    if (!family) return { code: 404, msg: '家庭不存在或无权访问' }

    family.policies = policies

    // 报告对象（families.last_* → report.{portrait,review,...}）
    family.report = toReadReport(family)

    // 向后兼容字段：报告页直接读 c.debt / c.family_income / c.name
    const fs = family.financial_snapshot || {}
    if (!family.debt) family.debt = fs.debt || { amount: 0, type: '' }
    if (family.family_income == null) family.family_income = fs.income || 0
    if (!family.name) family.name = family.family_name || ''

    return { code: 200, data: family }
  } catch (e) {
    return wrapError('获取', e)
  }
}

module.exports = { getFamilyDetail }
