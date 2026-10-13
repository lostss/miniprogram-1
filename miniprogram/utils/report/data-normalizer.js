/**
 * data-normalizer.js — family 数据公共预处理
 *
 * 消除 buildChapters / buildGaps / makeHints / assessDataCompleteness 中
 * 4 处重复的聚合统计模式，收敛为一处。
 */
const { yuanToWan } = require('../amount')
// 一年期判定的单一实现（契约文件 cloudfunctions/_shared/policy-status.js 同步副本）
const { isOneYearPolicy } = require('../policy-status')

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
  // 总保额含医疗险报销年限额（2026-09-22 决策：条款自身即称"保险金额=各项医疗费用保险金年限额之和"，
  // 不按报销型/给付型拆分，详见 docs/data-model-v2.md「保额口径」）。需要提醒读者的是期限而非类型。
  const totalCoverage = yuanToWan(active.reduce(function(s, p) { return s + (p.sum_assured || 0) }, 0))
  // 审计·顾问视角（2026-09-04）：一年期短险单独聚合——总保额混算会虚高保障感（百万医疗明年未必续保）。
  //
  // 2026-09-22 修：原判定与 chapter-builder._isOneYear 同构，只认**文本形态** `^(1|一)年` 与
  // coverage_term=1 → 对**日期区间形态**（`至YYYY年MM月DD日`、`…零时起至…二十四时止`）一份都识别不出。
  // 实测线上唯一真实家庭的 13 份保单，本项恒为 0（机制从未触发），其中 400 万医疗险 ×4、
  // 800 万意外险 ×1 全是长年保证续保的一年期产品 → 摘要卡上「总保额」把这些限额一起算进保障感。
  // 改走契约级判据 isOneYearPolicy（文本 / 数字编码 / 日期区间三形态并集，与 calcStatus 的
  // _isOneYearSpan 同源）。
  // ⚠️ 有意**不**同步放宽 chapter-builder._isOneYear：那处的唯一用途是「缴费年期显示为一次性」
  // （_payTermText），放宽会连带改掉缴费方式的展示口径，不在本次范围。
  const shortTermCoverage = yuanToWan(active.reduce(function(s, p) {
    return isOneYearPolicy(p) ? s + (p.sum_assured || 0) : s
  }, 0))
  const policyCount = active.length

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

  return { active, debt, totalIncome, annualPremium, annualPremiumW, premiumRatio, totalCoverage, shortTermCoverage, policyCount, memberIdToName, memberMap, members, policies }
}

module.exports = { normalizeFamilyData }
