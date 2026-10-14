/**
 * gap-engine.js — 保障缺口展示层
 *
 * 2026-09-11「业务规则双实现」治理：**计算核心已上移** cloudfunctions/_shared/gap-core.js，
 * 经 sync-shared.js 的 CONTRACT_FILES 跨树契约同步为 ../gap-core.js —— 前端页面矩阵与
 * 后端 AI 报告（reportAI/report-context）现调用同一份算法（此前各实现一遍，且后端是简化复刻，
 * 口径分裂 2 次：2026-09-05 P1-A 收入基数、2026-09-10 P1-2）。
 *
 * 本文件只保留**展示层**：gaps 的筛选与排序、缺口矩阵、覆盖矩阵的形状。
 * 改算法请改 cloudfunctions/_shared/gap-core.js（改本文件副本 = 下次 sync 被覆盖）。
 */
// neededCats 已随 buildGapMatrix 删除而失去调用方（2026-10-14 清理，eslint no-unused-vars 提示）
const { evaluateCoverage } = require('../gap-core')
const { canonCat } = require('../thresholds')
const { yuanToWan } = require('../amount')

/**
 * 构建结构化保障缺口（前端纯计算，不消耗 AI）
 * 展示语义：只保留**未满足**项（含 blocked 待补项，其 satisfied=false）
 */
function buildGaps(family) {
  const rows = evaluateCoverage({
    members: (family && family.members) || [],
    policies: (family && family.policies) || [],
    familyIncomeWan: Number(family && family.family_income) || 0,
    debtWan: (family && family.debt && family.debt.amount) || 0
  })
  const gaps = rows.filter(function(r) { return !r.satisfied })
  var order = { high: 0, medium: 1, low: 2 }
  gaps.sort(function(a, b) { return (order[a.priority] - order[b.priority]) || ((b.gap || 0) - (a.gap || 0)) })
  return gaps
}

/**
 * 2026-09-22 全面审计（死代码清理）：`buildGapMatrix(gaps, members)` 已删除。
 * 依据：① 全仓零调用方（grep `buildGapMatrix` 只命中 chapter-builder 里一句"已删除死代码"的
 * 历史注释）；② 它自身还有一个真实缺陷——内层 `for (var i = 0; ...)` 与外层同一个
 * `var i` 共享函数作用域，内层一旦执行就把外层成员索引改写掉（会跳过成员），
 * 留着迟早被误用。缺口矩阵的**唯一**权威实现是 chapter-builder 的 buildCoverageMatrix +
 * _shared/gap-core.evaluateCoverage，不要在此另起一份。
 */

/**
 * 构建保障覆盖矩阵（设计稿第 2 章）：成员×险种 已有保额（万元），缺失格标红
 * 含底部险种合计行（各险种跨成员汇总）；右侧成员合计列已移除（单成员多险种相加无意义）。
 * 纯展示层，不参与缺口判断。
 *
 * 2026-10-14 扩列（用户稿子）：加「年金」列与「年保费」列。两条口径必须守住：
 *   - **年金列不参与"缺失"标红**：年金是储蓄型，`neededCats` 里本就没有它；标红等于说
 *     "你缺年金"＝推荐买年金 → 撞合规红线（不做产品价值判断 / 只出事实不出建议）。
 *     故只有 `GAP_CATS`（需求模型里的四类保障险）才用 missing 状态。
 *   - **年保费列只报事实**：按成员汇总 `annual_premium`，同样不标红（保费高低不是"缺失"）。
 *     它服务稿子那句话——"钱花在人身上的结构对不对（是否全家保一人）"。
 */
var GAP_CATS = ['重疾险', '医疗险', '意外险', '寿险']
var MATRIX_CATS = GAP_CATS.concat(['年金'])

function buildCoverageMatrix(members, policies) {
  var active = (policies || []).filter(function(p) { return p.status === 'active' })
  var memberIdToName = {}
  for (var i = 0; i < members.length; i++) {
    var m = members[i]
    if (m.member_id) memberIdToName[m.member_id] = m.name
  }
  var cats = MATRIX_CATS
  var rows = members.map(function(m) {
    var cells = {}
    // 2026-10-14：除保额外再统计「该格是否有保单」—— 真机截图暴露的自相矛盾：
    // 「已覆盖险种」列了"年金"（organize._categoryList 按"有没有这类保单"判定），
    // 而矩阵年金列全是"—"（按"保额>0"判定）→ 同一份数据两处说法相反。
    // 两种事实都要能表达：无此类保单 = —；有保单但保额 0/未填 = 0。
    var counts = {}
    for (var ci = 0; ci < cats.length; ci++) { cells[cats[ci]] = 0; counts[cats[ci]] = 0 }
    var premium = 0
    for (var k = 0; k < active.length; k++) {
      var p = active[k]
      var n = (p.member_id && memberIdToName[p.member_id]) || p.insured_name
      if (n === m.name) {
        var c = canonCat(p.insurance_category || '其他')
        if (cells[c] !== undefined) { cells[c] += yuanToWan(p.sum_assured || 0); counts[c]++ }
        premium += p.annual_premium || 0
      }
    }
    return { name: m.name, cells: cells, counts: counts, premiumW: yuanToWan(premium) }
  })
  var total = {}
  var totalCounts = {}
  for (var ci2 = 0; ci2 < cats.length; ci2++) { total[cats[ci2]] = 0; totalCounts[cats[ci2]] = 0 }
  var totalPremiumW = 0
  for (var r = 0; r < rows.length; r++) {
    for (var c2 = 0; c2 < cats.length; c2++) {
      total[cats[c2]] += rows[r].cells[cats[c2]]
      totalCounts[cats[c2]] += rows[r].counts[cats[c2]]
    }
    totalPremiumW += rows[r].premiumW
  }
  function fmt(v) { var x = Math.round(v * 100) / 100; return x === Math.floor(x) ? String(x) : String(x) }
  // 单元格状态：保障险空 → missing（红）；年金空 → 中性（不标红，见函数头口径）；保费 → 恒中性
  // 值：保额>0 → 数字；有保单但保额为 0/未填 → '0'（区别于"无此类保单"的 '—'）
  function cellOf(cat, v, n) {
    if (v > 0) return { v: fmt(v), s: 'ok' }
    if (n > 0) return { v: '0', s: GAP_CATS.indexOf(cat) !== -1 ? 'missing' : '' }
    return { v: '—', s: GAP_CATS.indexOf(cat) !== -1 ? 'missing' : '' }
  }
  var out = rows.map(function(row) {
    var cells = cats.map(function(c) { return cellOf(c, row.cells[c], row.counts[c]) })
    cells.push({ v: row.premiumW > 0 ? fmt(row.premiumW) : '—', s: '' })
    return { name: row.name, cells: cells }
  })
  var grandCells = cats.map(function(c) { return cellOf(c, total[c], totalCounts[c]) })
  grandCells.push({ v: totalPremiumW > 0 ? fmt(totalPremiumW) : '—', s: '' })
  out.push({ name: '合计', cells: grandCells })
  return { heads: ['成员'].concat(cats).concat(['年保费']), cats: cats.concat(['年保费']), rows: out }
}

module.exports = { buildGaps, buildCoverageMatrix }
