/**
 * data-normalizer.js — family 数据公共预处理
 *
 * 消除 buildChapters / buildGaps / makeHints / assessDataCompleteness 中
 * 4 处重复的聚合统计模式，收敛为一处。
 */

/**
 * @param {object} family — { policies, members, debt, family_income }
 * @returns {{ active, debt, totalIncome, annualPremium, annualPremiumW, premiumRatio, memberIdToName, memberMap }}
 */
function normalizeFamilyData(family) {
  const policies = family.policies || []
  const members = family.members || []
  const active = policies.filter(function(p) { return p.status === 'active' })
  const debt = (family.debt && family.debt.amount) || 0
  const memIncome = members.reduce(function(s, m) { return s + (m.income || 0) }, 0)
  const totalIncome = memIncome > 0 ? memIncome : (parseInt(family.family_income) || 0)
  const annualPremium = active.reduce(function(s, p) { return s + (p.annual_premium || 0) }, 0)
  const annualPremiumW = Math.round(annualPremium / 10000 * 100) / 100
  const premiumRatio = totalIncome > 0 ? Math.round(annualPremiumW / totalIncome * 1000) / 10 : 0

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
      sum: Number(((p.sum_assured || 0) / 10000).toFixed(1))
    })
  }

  return { active, debt, totalIncome, annualPremium, annualPremiumW, premiumRatio, memberIdToName, memberMap, members, policies }
}

/**
 * 章节编号生成器工厂
 * @returns {function} () => string 返回 '1','2',...
 */
function createNumbering() {
  var g = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
  var gi = -1
  return function() { return g[(++gi) % g.length] }
}

module.exports = { normalizeFamilyData, createNumbering }
