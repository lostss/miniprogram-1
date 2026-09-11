/**
 * chapter-builder.js — 报告章节编排（基础版报告 · 7 章单页长图）
 *
 * 设计稿验收（docs 基础版报告）：
 *   1. 家庭结构（成员树）
 *   2. 家庭财务（独立章，R2 从家庭结构拆出）
 *   3. 保障汇总（成员×险种矩阵 + 缺失提示）
 *   4. 缴费月历（12 格 + 峰值高亮）
 *   5. 缴费年历和关键节点（时间轴）
 *   6. 特别提醒（置信度告警，无告警时整章跳过）
 *   7. 附录：保单明细（按成员分组卡片）
 *
 * 免责声明为静态合规文案，不在此处渲染，由报告页底部小字承载
 * （见 pages/report/index.wxml .report-disclaimer）。
 *
 * 依赖 gap-engine / timeline-builder / data-normalizer，
 * 将家庭数据组装为章节卡片数组。AI 分析章节（规划/建议等）由扩展版承载。
 */

var { normalizeFamilyData } = require('./data-normalizer')
var { buildCoverageMatrix } = require('./gap-engine')
var { buildTimeline } = require('./timeline-builder')
var { canonCat } = require('../thresholds')
var { yuanToWan, fmtYuan } = require('../amount')
var createBlock = require('../custom-blocks').create

// 险种短名：卡片展示用（重疾险 → 重疾；寿险保留全称，'寿' 不可读）
function _shortCat(cat) {
  var s = String(cat || '')
  if (s.length > 1 && s.charAt(s.length - 1) === '险') {
    var t = s.slice(0, -1)
    if (t.length >= 2) return t
  }
  return s
}

// 保单状态展示文案（与后端 policy-status.js 保持同构）
const POLICY_STATUS_LABELS = {
  active: '有效',
  lapsed: '失效',
  surrendered: '退保',
  claim_terminated: '理赔终止',
  expired: '到期终止',
  cancelled: '退保',
  suspicious: '数据异常'
}


// 金额展示：薄包装 amount.js fmtYuan（契约 2 位精度，消除 1/2 位漂移）；
// 仅补"未知"语义（null/''/NaN → '未知'），0 是有效值显示 '0元'
function _fmtAmount(v) {
  if (v === null || v === undefined || v === '') return '未知'
  var n = Number(v)
  if (isNaN(n)) return '未知'
  return fmtYuan(n)
}

// 展示行拼接：缺失项以「未知」占位（与 _fmtAmount 口径一致），有值项用给定文本；项间 ' · ' 分隔
function _joinRow(items) {
  return items.map(function(it) { return it.v ? it.text : '未知' }).join(' · ')
}

// 万额展示：去浮点噪音（整数省略 .0），0/NaN → '0'（缺口章/收口章金额展示）
function _numW(v) {
  var n = Number(v)
  if (isNaN(n)) return '0'
  var r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : String(r)
}

// 保障期限：OCR 文本（insurance_period）或对话数字（coverage_term，105=终身，兼容旧 0）——双字段并存兼容
function _periodText(p) {
  if (p.insurance_period) return String(p.insurance_period)
  var ct = p.coverage_term
  if (ct === 105 || ct === '105' || ct === 0 || ct === '0') return '终身'
  if (ct) return String(ct) + '年'
  return ''
}

// 一年期判定：insurance_period 文本「1年/一年(期)」或 coverage_term=1（^ 锚定防误匹配 21年 等）
function _isOneYear(p) {
  if (/^(1|一)年/.test(String(p.insurance_period || '').trim())) return true
  var ct = p.coverage_term
  return ct === 1 || ct === '1'
}

// 缴费年期：OCR 文本（payment_period）或对话数字（premium_term，1=趸交，兼容旧 0）；一年期产品固定「一次性」
function _payTermText(p) {
  if (_isOneYear(p)) return '一次性'
  if (p.payment_period) return String(p.payment_period)
  var pt = p.premium_term
  if (pt === 1 || pt === '1' || pt === 0 || pt === '0') return '趸交'
  if (pt) return '缴' + String(pt) + '年'
  return ''
}

// 当前年份现金价值：表值 v(每万元保额·元) × 保额万数 = 现金价值(元)
// 取现金价值表中 ≤ 当前保单年度(当前年-生效年+1) 的末行；无现价表/未生效/无保额 → null
// 有现价表即储蓄型产品（OCR 仅储蓄型保单配现价表），天然完成储蓄型过滤，无需 category 判断
function _currentCashValue(p, cashValues) {
  if (!p || !Array.isArray(cashValues) || !cashValues.length) return null
  var pid = p.id || p._id || ''
  if (!pid) return null
  var cv = null
  for (var i = 0; i < cashValues.length; i++) {
    if (cashValues[i] && cashValues[i].policy_id === pid) { cv = cashValues[i]; break }
  }
  if (!cv || !Array.isArray(cv.cash_values) || !cv.cash_values.length) return null
  var scale = Math.max(1, Math.round(yuanToWan(p.sum_assured || 0)))
  if (scale <= 0) return null
  var eff = String(p.contract_effective_date || p.effective_date || '').substring(0, 10)
  if (!eff) return null
  var effYear = new Date(eff).getFullYear()
  if (isNaN(effYear)) return null
  var policyYear = new Date().getFullYear() - effYear + 1
  if (policyYear < 1) return null // 未生效
  var row = null
  for (var j = 0; j < cv.cash_values.length; j++) {
    var r = cv.cash_values[j]
    if (r && r.y <= policyYear && (!row || r.y > row.y)) row = r
  }
  if (!row) return null
  return yuanToWan(row.v * scale) // 万元
}

// 成员角色分组排序：长辈 → 父母 → 本人/配偶 → 子女
function _roleGroup(role) {
  var r = role || ''
  if (/爷爷|奶奶|外公|外婆/.test(r)) return 0
  if (/父亲|母亲|父母|爸爸|妈妈/.test(r)) return 1
  if (/本人|配偶|丈夫|妻子/.test(r)) return 2
  return 3
}

/**
 * 置信度告警（设计稿第 5 章）：need_review 或低置信度保单
 */
function buildConfidenceAlerts(policies) {
  var alerts = []
  for (var i = 0; i < (policies || []).length; i++) {
    var p = policies[i]
    var pid = p.id || p._id || ''
    var name = p.product_name || '未知名保单'
    // 告警携带保单引用（policy_id + 低置信字段），供 [核对] 定位编辑 Sheet
    if (p.need_review) { alerts.push({ name: name, issue: '保额需人工确认', policy_id: pid, field: 'sum_assured' }); continue }
    var conf = typeof p.confidence === 'number' ? p.confidence : 1
    if (conf < 0.95) { alerts.push({ name: name, issue: '识别置信度较低', policy_id: pid }); continue }
    var fc = p.field_confidence
    if (fc && typeof fc === 'object') {
      var lowField = null
      for (var k in fc) {
        if (typeof fc[k] === 'number' && fc[k] < 0.95 && !/^name$/i.test(k)) { lowField = k; break }
      }
      if (lowField) alerts.push({ name: name, issue: '部分字段置信度较低', policy_id: pid, field: lowField })
    }
  }
  return alerts
}

/**
 * 构建所有报告章节（基础版 7 章）
 */
function buildChapters(family, report, gaps, opts) {
  var shared = !!(opts && opts.view === 'shared')
  // 审计·顾问视角（2026-09-04）：缺口数据统一复用外部 buildGaps 结果（buildReportView 已算好传入），
  // 删除此前函数内 buildGaps×2 重算 + buildGapMatrix 死代码（结果从未渲染）的浪费
  if (!gaps || !Array.isArray(gaps)) gaps = require('./gap-engine').buildGaps(family)
  var norm = normalizeFamilyData(family)
  var members = norm.members
  var policies = norm.policies
  var active = norm.active
  var debt = norm.debt
  var totalIncome = norm.totalIncome
  var annualPremium = norm.annualPremium
  var annualPremiumW = norm.annualPremiumW
  var premiumRatio = norm.premiumRatio
  var totalCoverage = norm.totalCoverage
  var policyCount = norm.policyCount
  var expense = norm.expense

  var matrix = buildCoverageMatrix(members, active)
  var ch = []
  // 缺口分组（供 ④ 保障缺口章与「下一步」收口章共用）：可行动（有缺口金额）vs 信息缺失（无法计算）
  var actionable = gaps.filter(function(g) { return g.gap > 0 && g.reliability !== 'blocked' })
  var blockedGaps = gaps.filter(function(g) { return g.reliability === 'blocked' })

  // ======== ① 家庭结构 / ② 家庭财务 ========
  // 审计·顾问视角（2026-09-04）：客户版跳过①②——成员结构与收入是顾问的核对工作底稿（带 [编辑] 入口），
  // 客户无需被重新告知自家信息；结论摘要之后直接进入保障汇总/缺口诊断
  if (!shared) {
  var sortedMembers = [].concat(members).sort(function(a, b) {
    return (_roleGroup(a.role) - _roleGroup(b.role)) || String(a.name).localeCompare(String(b.name), 'zh')
  })
  var nodes = sortedMembers.map(function(m) {
    var role = m.role || ''
    return { name: m.name, role: role, age: m.age || '', member_id: m.member_id || '', display: m.age ? (role + '(' + m.age + ')') : role }
  })
  // 去代际分层：成员卡片平铺流动布局（排序仍按角色分组序+中文名）
  ch.push({
    key: 'family_structure', title: '家庭结构', num: '1', edit: 'family',
    customBlocks: [createBlock('family_tree', { nodes: nodes })]
  })

  // ② 家庭财务（独立章，R2 从家庭结构拆出）
  // edit:'financials' → 章标题行渲染 [编辑]（onChapterEdit mode='financials'）
  ch.push({
    key: 'family_finance', title: '家庭财务', num: '2', edit: 'financials',
    customBlocks: [createBlock('finance', {
      income: totalIncome,
      debt: Math.round(debt * 100) / 100,
      expense: Math.round(expense * 100) / 100
    })]
  })
  }

  // ======== ③ 保障汇总 ========
  // 客户版中性措辞："已有XX保障待完善"，不写"缺少XX"式恐吓文案（数据不变，换视角）
  var missingLines = (function() {
    var lines = []
    for (var i = 0; i < members.length; i++) {
      var m = members[i]
      var missing = gaps.filter(function(g) { return g.member === m.name && g.gap > 0 }).map(function(g) { return _shortCat(g.category) })
      if (missing.length > 0) lines.push(shared ? (m.name + '的' + missing.join('、') + '保障待完善') : (m.name + '缺少' + missing.join('、')))
    }
    return lines
  })()
  ch.push({
    key: 'coverage_summary', title: '保障汇总', num: '3',
    unit: '单位：万元',
    pre: missingLines.length > 0 ? ('⚠️ ' + missingLines.join('\n⚠️ ')) : '',
    customBlocks: [createBlock('panorama', { heads: matrix.heads, cats: matrix.cats, rows: matrix.rows })]
  })

  // ======== ④ 保障缺口（审计·顾问视角 2026-09-04：缺口诊断独立成章） ========
  // 此前 buildGaps 算出的金额/依据/优先级从未渲染（缺口只以汇总章顶部红字呈现），核心价值被埋没。
  // 现以 markdown 列表独立成章：成员分组小标题 + 缺口明细。
  // 展示口径：客户版仅缺口金额（中性，不暴露"需求=负债+5×收入"公式）；owner 含需求-已有与优先级。
  // 活报告模型（2026-09）：客户版 blocked（额度无法测算）也展示④章——仅渲染克制说明行（挂载点④）
  var showGapCh = actionable.length > 0 || blockedGaps.length > 0
  if (showGapCh) {
    var gapLines = []
    if (actionable.length > 0) {
      var actByMember = {}
      for (var gi = 0; gi < actionable.length; gi++) {
        var ag = actionable[gi]
        if (!actByMember[ag.member]) actByMember[ag.member] = []
        actByMember[ag.member].push(ag)
      }
      Object.keys(actByMember).forEach(function(mn) {
        var mb = members.find(function(x) { return x.name === mn }) || null
        gapLines.push('**' + mn + '**' + (mb && mb.role && !shared ? '（' + mb.role + '）' : ''))
        // markdown-render 段落会吞并紧随的列表行（while 仅排除 #/>/|/代码块），标题后留空行让列表独立解析
        gapLines.push('')
        actByMember[mn].forEach(function(g) {
          var tail = shared ? '' : ('（需求 ' + _numW(g.reference) + ' 万 - 已有 ' + _numW(g.existing) + ' 万 · 优先级：' + g.priorityLabel + '）')
          gapLines.push('- ' + _shortCat(g.category) + '：缺口 ' + _numW(g.gap) + ' 万' + tail)
        })
      })
    }
    if (blockedGaps.length > 0 && !shared) {
      var bCats = []
      var bMems = []
      for (var bgi = 0; bgi < blockedGaps.length; bgi++) {
        var bg = blockedGaps[bgi]
        if (bCats.indexOf(bg.category) === -1) bCats.push(bg.category)
        if (bMems.indexOf(bg.member) === -1) bMems.push(bg.member)
      }
      gapLines.push('\n\n' + bMems.join('、') + ' 的' + bCats.join('、') + '缺口因年收入等信息缺失暂无法计算；补齐家庭年收入等信息后即可计算。')
    }
    // 活报告模型（2026-09）：客户版 blocked 克制说明（正向、不示弱、不泄公式）
    if (blockedGaps.length > 0 && shared) {
      gapLines.push('\n\n完善家庭收支信息后，本报告将自动补充额度测算')
    }
    ch.push({
      key: 'gap_analysis', title: '保障缺口',
      content: gapLines.join('\n')
    })
  }

  // ======== ⑤ 保障节点（审计 S1：一次性关键时点优先于每年重复的缴费月历） ========
  // 设计稿决策：仅展示三种节点——保障期满/交费期满/现价保本（排除每年缴费提醒 payment）
  // 结构：年份为第一层节点（时间轴行）；该年份下多款产品归类显示；
  //       单产品同年多个节点以「/」分隔。产品分组键含被保人，防同产品跨被保人误合并。
  // 现价保本节点依赖 family.cashValues（getFamily 并行返回，见 dataQuery/family-detail.js）
  var NODE_TEXT = { expiry: '保障期满', paydone: '交费期满', breakeven: '现价保本' }
  // 客户版仅保留"保障期满"类节点（交费期满/现价回本对客户是推销感/无关紧要）
  var timeline = buildTimeline(active, members, family.cashValues)
    .filter(function(e) { return e.type !== 'payment' })
    .filter(function(e) { return shared ? e.type === 'expiry' : true })
  var byYear = {}
  for (var ti = 0; ti < timeline.length; ti++) {
    var ev = timeline[ti]
    var prodKey = String(ev.label || '').replace(/(到期|缴完|现价回本)$/, '')
    if (!byYear[ev.y]) byYear[ev.y] = {}
    if (!byYear[ev.y][prodKey]) byYear[ev.y][prodKey] = []
    byYear[ev.y][prodKey].push(ev)
  }
  var timelineItems = []
  Object.keys(byYear).map(Number).sort(function(a, b) { return a - b }).forEach(function(yr) {
    var prods = byYear[yr]
    var policiesOfYr = Object.keys(prods).map(function(pk) {
      var nodes = prods[pk]
      // 同产品同年多节点：按类型固定顺序排列（保障期满→交费期满→现价保本）
      nodes.sort(function(a, b) {
        var order = { expiry: 0, paydone: 1, breakeven: 2 }
        return order[a.type] - order[b.type]
      })
      return {
        name: pk,
        note: nodes.map(function(n) { return NODE_TEXT[n.type] }).join('/')
      }
    })
    var allNodes = [].concat.apply([], Object.keys(prods).map(function(pk) { return prods[pk] }))
    timelineItems.push({
      label: yr + '年',
      y: yr,
      // dot 颜色（wxml 按 type 着色）：该年含保障期满用红（最需关注），其余绿
      type: allNodes.some(function(n) { return n.type === 'expiry' }) ? 'expiry' : 'paydone',
      soon: false,
      date: yr + '年',
      policies: policiesOfYr
    })
  })
  ch.push({
    key: 'premium_timeline', title: '保障节点', num: '4',
    customBlocks: [createBlock('timeline', { items: timelineItems })]
  })

  // ======== ⑥ 缴费月历（审计 L1：每年重复信息，明细型默认折叠） ========
  var months = (function() {
    var arr = []
    for (var i = 0; i < 12; i++) {
      var t = active.reduce(function(s, p) {
        var mo = -1
        var dt = p.contract_effective_date || p.effective_date || ''
        if (dt) { var d = new Date(dt); if (!isNaN(d.getTime())) mo = d.getMonth() }
        return mo === i ? s + (p.annual_premium || 0) : s
      }, 0)
      arr.push({ m: i + 1, v: t > 0 ? t + '元' : '-', h: t > 0 ? 1 : 0 })
    }
    var max = Math.max.apply(null, arr.map(function(x) { return x.h === 1 ? x.v : 0 }).map(function(v) { return parseInt(v, 10) || 0 }))
    if (max > 0) {
      for (var j = 0; j < arr.length; j++) {
        if ((parseInt(arr[j].v, 10) || 0) === max) arr[j].h = 2
      }
    }
    return arr
  })()
  var peakMonth = months.filter(function(x) { return x.h === 2 }).map(function(x) { return x.m + '月' }).join('、')
  ch.push({
    key: 'premium_calendar', title: '缴费月历', num: '5',
    // 2026-09-06：报告内容默认全部展开（保留手动收起能力）
    collapsible: true, defaultCollapsed: false,
    customBlocks: [createBlock('calendar', { items: months })],
    // 下方提示：无列表垂直排列（年保费 → 峰值月），markdown-render 以 <br> 换行
    // 客户版：占收入比标注"家庭年收入占比，仅供参考"（数据保留，缓解"推销感"顾虑）
    // 2026-09-09：家庭年收入缺失时不再输出"（占收入 0%）"——data-normalizer 在 totalIncome=0 时
    // premiumRatio 回落 0，原实现直接拼成 0%，与"收入未填写"事实矛盾；改为显式缺失说明
    content: '年总保费 ' + annualPremiumW + '万' + (totalIncome > 0
      ? '（占' + (shared ? '家庭年收入 ' + premiumRatio + '%，仅供参考' : '收入 ' + premiumRatio + '%') + '）'
      : '（家庭年收入未填写，暂不计算占比）') + (peakMonth ? '<br>💡 ' + peakMonth + '缴费压力最大，请提前安排资金' : '')
  })

  // ======== ⑦ 特别提醒（置信度告警） ========
  // 免责声明已移至页面底部（index.wxml .report-disclaimer），无告警时整章跳过
  // 客户版整章隐藏（置信度是代理人内部信息，展示给客户损伤信任）
  var alerts = shared ? [] : buildConfidenceAlerts(active)
  if (alerts.length > 0) {
    ch.push({
      key: 'risk_alerts', title: '特别提醒', num: '6',
      customBlocks: [createBlock('risk_alerts', { items: alerts })]
    })
  }

  // ======== ⑦ 附录：保单明细 ========
  // 二级分组：先按被保人、再按保险公司归类；保司缺失归「未知保司」
  // 组名排序：被保人/保司均按名称排序
  // 组内排序：保单号升序为主键（同号主险+附加险自然相邻），同号内按产品名，空保单号排最后
  var groups = []
  var byMember = {}
    // 附录展示所有非软删保单（含失效/退保/理赔终止/到期终止），并带状态标签；
    // 保障汇总/缴费月历仍只使用 active（见 data-normalizer）
    const displayPolicies = policies.filter(function(p) { return p.status !== 'deleted' })

  var sorted = [].concat(displayPolicies).sort(function(a, b) {
    var pa = String(a.policy_number || '')
    var pb = String(b.policy_number || '')
    if (!pa && pb) return 1
    if (pa && !pb) return -1
    if (pa && pb && pa !== pb) return pa.localeCompare(pb, 'zh')
    return String(a.product_name || '').localeCompare(String(b.product_name || ''), 'zh')
  })
  for (var i = 0; i < sorted.length; i++) {
    var p = sorted[i]
    var n = p.insured_name || '未归属'
    var ins = p.insurer || '未知保司'
    if (!byMember[n]) byMember[n] = {}
    if (!byMember[n][ins]) byMember[n][ins] = []
    var eff = (p.contract_effective_date || p.effective_date || '').substring(0, 10)
    var sumD = _fmtAmount(p.sum_assured)
    var premD = _fmtAmount(p.annual_premium)
    var periodD = _periodText(p)
    var payD = _payTermText(p)
    // 三行简写：产品 / 保障信息 / 缴费信息，缺失项以「未知」占位（_joinRow）
    var meta1 = _joinRow([
      { v: eff, text: eff + '起' },
      { v: sumD !== '未知', text: sumD },
      { v: periodD, text: periodD }
    ])
    var meta2 = _joinRow([
      { v: premD !== '未知', text: premD + '/年' },
      { v: payD, text: payD }
    ])
    // 当前年份现金价值（代理人/客户均展示；仅储蓄型保单有现价表，其余为空串）
    var cashW = _currentCashValue(p, family.cashValues)
    var cashDisp = ''
    if (cashW !== null && cashW > 0) {
      cashDisp = '当前现价 ' + String(Math.round(cashW * 10) / 10) + '万'
    }
    byMember[n][ins].push({
      policy_id: p.id || p._id || '',
      product_name: p.product_name || '未知产品',
      category: _shortCat(canonCat(p.insurance_category || '其他')),
        status: p.status || 'active',
        status_label: POLICY_STATUS_LABELS[p.status || 'active'] || (p.status || '有效'),
      // 2026-09-10：移除「保障期已过」标记（用户决策：一年期产品默认有效，除非手动改状态）。
      // 产品规则不变（policy-status.js 的一年期豁免保留，已过期保单仍判 active 并计入保额），
      // 但卡片不再输出 expiry_passed——原标签与「有效」并列会误导用户以为保障已失效。

      sum_assured: p.sum_assured || 0,
      annual_premium: p.annual_premium || 0,
      effective_date: eff,
      sum_display: sumD,
      premium_display: premD,
      period_display: periodD,
      payment_display: payD,
      cash_display: cashDisp,
      meta1: meta1,
      meta2: meta2
    })
  }
  Object.keys(byMember).sort(function(a, b) { return a.localeCompare(b, 'zh') }).forEach(function(n) {
    var subgroups = []
    Object.keys(byMember[n]).sort(function(a, b) { return a.localeCompare(b, 'zh') }).forEach(function(ins) {
      subgroups.push({ name: ins, policies: byMember[n][ins] })
    })
    groups.push({ name: n, subgroups: subgroups })
  })
  // ======== 行动收口（审计·顾问视角 2026-09-04：报告以"下一步"收束，不再以折叠附录 + 免责结束） ========
  // 取可行动缺口前 3 条（gaps 已按优先级 high→low、缺口额降序）；客户版中性措辞，与顶部 topAdvice 呼应
  var topAct = actionable.slice(0, 3)
  // 活报告模型（2026-09）：客户版移除⑧章——行动出口唯一化为 AI 行动清单（C1-suggestions）；owner 保留（结构化核对口径）
  // 2026-09-06 措辞收敛：owner 尾注去话术/去销售引导，改中性状态提示
  if (topAct.length > 0 && !shared) {
    var actLines = topAct.map(function(g, i) {
      var short = _shortCat(g.category)
      return ((i + 1) + '. 优先为 ' + g.member + '补充' + short + '（缺口约 ' + _numW(g.gap) + ' 万）')
    })
    actLines.push('\n\n以上按缺口对家庭的影响程度排序；缺口金额将随家庭收支信息更新而重新计算。')
    ch.push({
      key: 'next_steps', title: '下一步行动',
      content: actLines.join('\n')
    })
  }

  // 附录：保单明细（不作为编号章节，仅保留标题 + 保单卡片）
  // 审计 L1：明细型低频查阅，默认折叠
  ch.push({
    key: 'appendix_policies', title: '附录：保单明细',
    // 2026-09-06：报告内容默认全部展开（保留手动收起能力）
    collapsible: true, defaultCollapsed: false,
    customBlocks: [createBlock('policy_cards', { groups: groups })],
    // 有效保单数提升至标题右侧（unit 字段渲染于标题旁，原 note 在章底部）
    unit: '有效 ' + policyCount + ' 份 / 共 ' + displayPolicies.length + ' 份'
  })

  // 统一章节编号：正式章按渲染顺序重排 1..N（附录不编号）——客户版跳过①②后序号依然连续，
  // 缺口/收口/告警章按是否存在动态插入后编号自动顺延
  var seq = 0
  for (var ci = 0; ci < ch.length; ci++) {
    if (ch[ci].key !== 'appendix_policies') { seq++; ch[ci].num = String(seq) }
  }
  return ch
}

module.exports = { buildChapters, buildConfidenceAlerts }
