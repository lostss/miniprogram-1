/**
 * gap-core.js — 保障缺口计算核心（前后端单一事实源）
 *
 * 2026-09-11「业务规则双实现」根因治理。
 *
 * 背景：此前前端 miniprogram/utils/report/gap-engine.js 与后端 reportAI/report-context.buildGapSnapshot
 * 各自实现一遍缺口算法，且**后端是前端的降级复刻**（固定 4 险种不分角色、无三态可信度、无补全提示）
 * ——两者从结构上就不可能自动一致。口径已实际分裂 2 次：
 *   2026-09-05 P1-A（收入基数：家庭 vs 个人）
 *   2026-09-10 P1-2（后端未跟上前端修复）
 *
 * 现为唯一算法：经 sync-shared.js 的 CONTRACT_FILES 跨树契约同步到 miniprogram/utils/gap-core.js，
 * 前端页面矩阵与后端 AI 报告调用同一份代码 → 同一组数字，口径分裂在机制上不可能再发生。
 *
 * 依赖 ./amount 与 ./thresholds（二者亦为契约文件，同步后同目录解析）。
 * 纯计算：不依赖云函数/小程序 API，可独立单测。
 */

const { yuanToWan } = require('./amount')
const { THRESHOLDS, DEFAULT_THRESHOLD, canonCat } = require('./thresholds')

/**
 * 角色 → 必需险种（最小版需求模型）
 */
function neededCats(role) {
  const r = role || ''
  if (r === '子女' || r === '父母') return ['医疗险', '意外险', '重疾险']
  if (r === '本人' || r === '配偶') return ['重疾险', '医疗险', '意外险', '寿险']
  return ['医疗险', '意外险']
}

function gapPriority(cat, isPillar) {
  if (isPillar && (cat === '寿险' || cat === '重疾险' || cat === '意外险')) return 'high'
  if (isPillar) return 'medium'
  if (cat === '重疾险' || cat === '医疗险') return 'medium'
  return 'low'
}

/**
 * 缺口可信度三态：confirmed（口径完整）/ estimated（含估算成分）/ blocked（无法计算）
 */
function gapReliability(cat, hasIncome, hasDebt) {
  if (cat === '重疾险' || cat === '医疗险') return 'estimated'
  if (cat === '寿险' || cat === '意外险') {
    if (!hasIncome) return 'blocked'
    return hasDebt ? 'confirmed' : 'estimated'
  }
  return 'confirmed'
}

function thresholdFor(cat) {
  return THRESHOLDS[cat] || DEFAULT_THRESHOLD
}

function referenceFor(cat, debt, income) {
  const r = thresholdFor(cat).reference
  return typeof r === 'function' ? r(debt, income) : r
}

/**
 * 「依据」文案（统一口径：前端页面与 AI 报告共用）
 * @param {boolean} incomeEstimated 个人收入缺失、用家庭年收入兜底 → 显式标注（AI 不得误当精确值）
 */
function basisText(cat, exist, debt, income, rel, incomeEstimated) {
  const est = incomeEstimated ? '（个人收入缺失，按家庭年收入估算）' : ''
  if (cat === '重疾险') return '参考50万（治疗费+收入损失），现有' + exist + '万'
  if (cat === '医疗险') return '建议百万医疗，现有' + (exist > 0 ? exist + '万' : '无')
  if (cat === '寿险') {
    if (rel === 'blocked') return '寿险需求=负债+5×年收入，年收入缺失无法计算'
    if (rel === 'estimated') return '寿险需求≈5×年收入' + income + '万（负债缺失暂按0），现有' + exist + '万' + est
    return '寿险需求=负债' + debt + '万+5×年收入' + income + '万=' + Math.round(debt + 5 * income) + '万' + est + '，现有' + exist + '万'
  }
  if (cat === '意外险') {
    if (rel === 'blocked') return '意外险需求=5×年收入或负债取高，年收入缺失无法计算'
    if (rel === 'estimated') return '意外险需求≈5×年收入' + income + '万（负债缺失暂按0），现有' + exist + '万' + est
    return '意外险需求=max(5×年收入' + income + '万, 负债' + debt + '万)=' + Math.round(Math.max(5 * income, debt)) + '万' + est + '，现有' + exist + '万'
  }
  return '参考' + referenceFor(cat, debt, income) + '万，现有' + exist + '万'
}

function completeHint(cat, hasIncome, hasDebt) {
  if (cat === '重疾险' || cat === '医疗险') return ''
  if (!hasIncome) return '补全年收入 → 解锁' + cat + '缺口计算'
  if (!hasDebt) return '补全负债 → ' + cat + '需求计入负债更精确'
  return ''
}

/**
 * 全量评估：每个成员 × 其角色所需险种 → 逐行结果（含"已满足"行）
 *
 * 与旧前端 buildGaps 的差异：旧实现只产出「有缺口的行」（满足阈值的 continue 掉），
 * 而后端矩阵需要「已覆盖」行 → 现统一产出全量行（带 satisfied 标记），
 * 前端 filter(!satisfied) 即得原有 gaps[]，后端直接格式化全量矩阵。
 *
 * 收入口径（2026-09-05 P1-A，两端口径的唯一来源）：
 *   1) 成员有个人收入 → 用个人收入
 *   2) 支柱个人收入缺失 → 家庭年收入全额兜底（estimated，basis 显式标注）
 *   3) 非支柱收入缺失 → 按 0（不出虚假收入）
 *   4) 家庭收入也缺失 → 视为缺失（寿险/意外走 blocked）
 *
 * 注：insured_name 不在成员名单的保单不在此表体现（结构化保单清单承载其明细）——与前端既有行为一致。
 *
 * @param {object} input { members, policies, familyIncomeWan, debtWan }  金额单位：万（保额字段为元）
 * @returns {array} rows[{ id, member, role, category, existing, reference, gap, satisfied,
 *                         reliability, reliabilityLabel, priority, priorityLabel, basis, completeHint, why }]
 */
function evaluateCoverage(input) {
  const src = input || {}
  const members = src.members || []
  const policies = src.policies || []
  const familyIncomeWan = Number(src.familyIncomeWan) || 0
  const debt = Number(src.debtWan) || 0
  const hasDebt = debt > 0
  const active = policies.filter(p => p.status === 'active')

  const pillar = members.find(m => /本人|经济支柱/.test((m && m.role) || '')) || members[0] || null
  const memberIdToName = {}
  for (const m of members) {
    if (m && m.member_id) memberIdToName[m.member_id] = m.name
  }

  const rows = []
  for (const mb of members) {
    if (!mb) continue
    const isPillar = !!(pillar && mb.name === pillar.name)
    const rawMemIncome = Number(mb.income) || 0
    const hasOwnIncome = rawMemIncome > 0
    const useFamilyFallback = !hasOwnIncome && isPillar && familyIncomeWan > 0
    const hasMemIncome = hasOwnIncome || useFamilyFallback
    const isEstimatedIncome = useFamilyFallback
    const memIncome = hasOwnIncome ? rawMemIncome : (useFamilyFallback ? familyIncomeWan : 0)

    // 该成员已有保额（按险种归集，元 → 万）
    const existing = {}
    for (const p of active) {
      const n = (p.member_id && memberIdToName[p.member_id]) || p.insured_name
      if (n === mb.name) {
        const c = canonCat(p.insurance_category || '其他')
        existing[c] = (existing[c] || 0) + yuanToWan(p.sum_assured || 0)
      }
    }

    for (const cat of neededCats(mb.role)) {
      const exist = existing[cat] || 0
      const relBase = gapReliability(cat, hasMemIncome, hasDebt)
      const rel = isEstimatedIncome && relBase === 'confirmed' ? 'estimated' : relBase
      const priority = gapPriority(cat, isPillar)
      const priorityLabel = priority === 'high' ? '高' : (priority === 'medium' ? '中' : '低')
      const reliabilityLabel = rel === 'confirmed' ? '✅ 已确认' : (rel === 'estimated' ? '⚠️ 估算值' : '⚠️ 无法计算')

      const base = {
        id: mb.name + '_' + cat,
        member: mb.name,
        role: mb.role || '',
        category: cat,
        existing: exist,
        reliability: rel,
        reliabilityLabel: reliabilityLabel,
        priority: priority,
        priorityLabel: priorityLabel,
        completeHint: completeHint(cat, hasMemIncome, hasDebt),
        why: ''
      }

      if (rel === 'blocked') {
        rows.push(Object.assign({}, base, {
          reference: null, gap: null, satisfied: false,
          basis: basisText(cat, exist, debt, memIncome, rel, isEstimatedIncome)
        }))
        continue
      }

      const satisfied = !!thresholdFor(cat).statusFn(exist, debt, memIncome)
      const ref = referenceFor(cat, debt, memIncome)
      rows.push(Object.assign({}, base, {
        reference: ref,
        gap: satisfied ? 0 : Math.max(0, ref - exist),
        satisfied: satisfied,
        basis: basisText(cat, exist, debt, memIncome, rel, isEstimatedIncome)
      }))
    }
  }
  return rows
}

module.exports = { evaluateCoverage, neededCats }
