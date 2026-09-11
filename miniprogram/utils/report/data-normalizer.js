/**
 * data-normalizer.js — family 数据公共预处理
 *
 * 消除 buildChapters / buildGaps / makeHints / assessDataCompleteness 中
 * 4 处重复的聚合统计模式，收敛为一处。
 */
const { yuanToWan } = require('../amount')

/**
 * @param {object} family — { policies, members, debt, family_income }
 * @returns {{ active, debt, totalIncome, annualPremium, annualPremiumW, premiumRatio, memberIdToName, memberMap }}
 */
function normalizeFamilyData(family) {
  const policies = family.policies || []
  const members = family.members || []
  const active = policies.filter(function(p) { return p.status === 'active' })
  const debt = (family.debt && family.debt.amount) || 0
  // 家庭收入锚点修复（2026-09-06）：家庭财务展示/占收入比应以 finances 唯一真相源
  // （financial_snapshot.income / family_income 兼容）为准；成员个人收入仅服务成员级画像
  // （个人寿险缺口，见 gap-engine P1-A），不再加总冒充家庭收入——曾致"改了家庭收入报告不刷新"
  const famIncome = parseInt(family.family_income != null ? family.family_income : ((family.financial_snapshot && family.financial_snapshot.income) || 0)) || 0
  const memIncome = members.reduce(function(s, m) { return s + (m.income || 0) }, 0)
  const totalIncome = famIncome > 0 ? famIncome : memIncome
  const annualPremium = active.reduce(function(s, p) { return s + (p.annual_premium || 0) }, 0)
  const annualPremiumW = yuanToWan(annualPremium)
  const premiumRatio = totalIncome > 0 ? Math.round(annualPremiumW / totalIncome * 1000) / 10 : 0
  const totalCoverage = yuanToWan(active.reduce(function(s, p) { return s + (p.sum_assured || 0) }, 0))
  // 审计·顾问视角（2026-09-04）：一年期短险单独聚合——总保额混算会虚高保障感（百万医疗明年未必续保）。
  // 判定口径与 chapter-builder _isOneYear 同构：insurance_period ^(1|一)年 或 coverage_term=1
  const shortTermCoverage = yuanToWan(active.reduce(function(s, p) {
    const txt = String(p.insurance_period || '').trim()
    const ct = p.coverage_term
    const oneYear = /^(1|一)年/.test(txt) || ct === 1 || ct === '1'
    return oneYear ? s + (p.sum_assured || 0) : s
  }, 0))
  const policyCount = active.length
  const fs = (family && family.financial_snapshot) || {}
  const expense = fs.fixed_expense || 0

  const memberIdToName = {}
  for (var i = 0; i < members.length; i++) {
    var m = members[i]
    if (m.member_id) memberIdToName[m.member_id] = m.name
  }
  var memberMap = {}
  for (var j = 0; j < members.length; j++) {
    var mb = members[j]
    memberMap[mb.name] = { name: mb.name, items: [] }
  }
  for (var k = 0; k < active.length; k++) {
    var p = active[k]
    var n = (p.member_id && memberIdToName[p.member_id]) || p.insured_name || ''
    if (!memberMap[n]) memberMap[n] = { name: n, items: [] }
    memberMap[n].items.push({
      cat: p.insurance_category || '其他',
      sum: Number(yuanToWan(p.sum_assured || 0).toFixed(1))
    })
  }

  return { active, debt, totalIncome, annualPremium, annualPremiumW, premiumRatio, totalCoverage, shortTermCoverage, policyCount, expense, memberIdToName, memberMap, members, policies }
}

module.exports = { normalizeFamilyData }
