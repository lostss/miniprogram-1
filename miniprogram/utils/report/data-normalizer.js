/**
 * data-normalizer.js — family 数据公共预处理
 *
 * 消除 buildChapters / buildGaps / makeHints / assessDataCompleteness 中
 * 4 处重复的聚合统计模式，收敛为一处。
 */
const { yuanToWan } = require('../amount')
// 保额按险种拆分：跨树契约（与 reportPdf / reportAI 同源，勿在此另写聚合）
const { summarizeCoverage } = require('../coverage-summary')

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
  // 保额汇总：2026-10-14 用户决策「不再展示单一总保额，按保障类型统计」
  // （医疗险报销年限额与重疾保险金额相加无意义 → 客户会把报销上限当成能拿到手的钱）。
  // 聚合收进跨树契约 coverage-summary.js（此前 data-normalizer / reportPdf / report-context 三份独立实现）。
  // totalCoverage 仅保留给内部核对与旧调用方，**不再作为"总保额"对外展示**。
  const cov = summarizeCoverage(active)
  const totalCoverage = cov.totalW
  const shortTermCoverage = cov.shortTermW
  const policyCount = cov.policyCount

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

  return {
    active, debt, totalIncome, annualPremium, annualPremiumW, premiumRatio,
    totalCoverage, shortTermCoverage, policyCount,
    // 2026-10-14：按保障类型拆分（摘要卡与 AI 上下文的展示口径）
    coverageByCat: cov.byCat, protectionCoverage: cov.protectionW, savingsCoverage: cov.savingsW, payoutCoverage: cov.payoutW, quotaCoverage: cov.quotaW,
    unknownCoverage: cov.unknownW,
    memberIdToName, memberMap, members, policies
  }
}

module.exports = { normalizeFamilyData }
