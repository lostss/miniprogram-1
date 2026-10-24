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
// 经济支柱口径（2026-10-21）：与缺口测算同源 —— 否则会出现"报告写张三、缺口按李四算"
var { resolvePillar } = require('../gap-core')
var { buildTimeline } = require('./timeline-builder')
var { buildGantt } = require('./gantt-builder')
var { canonCat, premiumRatioVerdict } = require('../thresholds')
// 保费现金流趋势：跨树契约（与 reportPdf 缴费月历节同源）
var { buildPremiumTrend } = require('../premium-trend')
var { yuanToWan, fmtYuan } = require('../amount')
// 现价取行唯一事实源（2026-09-27 起：保单年度也在此契约内，勿再自行写年差公式）
var { policyYearAt, cashAtYear, coverScale } = require('../cash-value-math')
var createBlock = require('../custom-blocks').create
// 附加险归属（2026-10-21）：附录里附加险缩进挂主险下
var { linkRiders } = require('../rider-link')
// 异常与待核验 A1–A6（2026-10-21）：只列有字段支撑的事实，不下诊断
// 2026-10-22：升为跨树契约（_shared/anomaly-list.js），页面与 PDF 共用同一份 ——
// 之前只在 utils/report 下，PDF 无从引用，纸上就没有 A1–A6。
var { buildAnomalies } = require('../anomaly-list')

// 原文出处（2026-10-18，v2.0「结论可溯源」最小实现）：
// 把 OCR 阶段 AI 摘录的 field_evidence 拼成一行给附录保单卡展示。
// 只取有值的键、保持固定顺序（金额 → 保费 → 生效日 → 保单号），超长截断——
// 卡片是"核对用的提示"，不是条款原文段落，不追求完整。
var EVIDENCE_ORDER = [
  ['sum_assured', '保额'],
  ['annual_premium', '保费'],
  ['effective_date', '生效日'],
  ['policy_number', '保单号']
]
function _evidenceLine(ev) {
  if (!ev || typeof ev !== 'object') return ''
  var parts = []
  EVIDENCE_ORDER.forEach(function(pair) {
    var v = ev[pair[0]]
    if (typeof v !== 'string') return
    var s = v.replace(/\s+/g, ' ').trim()
    if (!s) return
    if (s.length > 28) s = s.slice(0, 28) + '…'
    parts.push(pair[1] + '：' + s)
  })
  return parts.join('　·　')
}

// 险种短名：卡片展示用（重疾险 → 重疾；寿险保留全称，'寿' 不可读）
function _shortCat(cat) {
  var s = String(cat || '')
  if (s.length > 1 && s.charAt(s.length - 1) === '险') {
    var t = s.slice(0, -1)
    if (t.length >= 2) return t
  }
  return s
}

// 保单状态展示文案：单一事实源（跨树契约文件，勿手写镜像——原镜像缺 deleted/unknown）
const { STATUS_LABELS: POLICY_STATUS_LABELS, isLifetimeTerm, isSinglePayTerm } = require('../policy-status')
// 置信度阈值契约（2026-09-24 口径自查：原为内联 0.95，与 CONF_THRESHOLD(0.9) 语义不同、勿混用）
const { OCR_RELIABLE_THRESHOLD } = require('../ocr-confidence')


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
  if (isLifetimeTerm(ct)) return '终身'
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
  if (isSinglePayTerm(pt)) return '趸交'
  if (pt) return '缴' + String(pt) + '年'
  return ''
}

// 当前保单年度的现金价值：表值 v(每万元保额·元) × 保额万数 = 现金价值(元)
// 取现金价值表中 ≤ 当前保单年度 的末行；无现价表/未生效/无保额 → null
// 有现价表即储蓄型产品（OCR 仅储蓄型保单配现价表），天然完成储蓄型过滤，无需 category 判断
//
// 2026-09-27 修（dsh 审计 ①：现价取行前后端相差 1 年）：原实现自行用「当前年 − 生效年 + 1」近似
// 保单年度，且**不看周年日**（周年日未到时多算 1 年）；而后端 `report-coverage._paidYears` 用
// 「当前年 − 生效年」（少算 1 年）→ 同一保单同一时刻报告页与 AI 上下文取到**不同行**：
// 实测 `多倍保障青少年重大疾病保险(A1款)`（生效 2020-05-20，实际第 7 保单年度）
// 报告页取 y=7 → 现价 7960，AI 上下文取 y=6 → 6240 ✗。
// 现两处都走契约：`policyYearAt`（按生效日周年判定）+ `cashAtYear`（取 ≤ 年度 的最近一行；
// 无合格行返回 null，由调用方不展示 —— 2026-09-27 已删掉"无则取首行"的回落，
// 那会把**未来年度**的现价当成当前现价；见 cash-value-math.js 该函数的说明）。
function _currentCashValue(p, cashValues, now) {
  if (!p || !Array.isArray(cashValues) || !cashValues.length) return null
  var pid = p.id || p._id || ''
  if (!pid) return null
  var cv = null
  for (var i = 0; i < cashValues.length; i++) {
    if (cashValues[i] && cashValues[i].policy_id === pid) { cv = cashValues[i]; break }
  }
  if (!cv || !Array.isArray(cv.cash_values) || !cv.cash_values.length) return null
  var policyYear = policyYearAt(p.contract_effective_date || p.effective_date || '', now)
  if (!policyYear) return null // 未生效 / 日期判不出 → 不猜
  var row = cashAtYear(cv.cash_values, policyYear)
  if (!row) return null
  return yuanToWan(row.v * coverScale(p.sum_assured)) // 万元
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
    if (conf < OCR_RELIABLE_THRESHOLD) { alerts.push({ name: name, issue: '识别置信度较低', policy_id: pid }); continue }
    var fc = p.field_confidence
    if (fc && typeof fc === 'object') {
      var lowField = null
      for (var k in fc) {
        if (typeof fc[k] === 'number' && fc[k] < OCR_RELIABLE_THRESHOLD && !/^name$/i.test(k)) { lowField = k; break }
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
  var annualPremiumW = norm.annualPremiumW
  var premiumRatio = norm.premiumRatio
  var policyCount = norm.policyCount

  var matrix = buildCoverageMatrix(members, active)

  // ======== 分险种保额合计表（2026-10-21，方案第一部分第 3 项）========
  // 矩阵是"成员 × 险种"（回答谁有什么），这张表是"险种为行"的汇总（回答每类保障总量、覆盖几人、几份）。
  // 两类不可加总的必须在表内直接说明，否则客户会把报销上限当成可领取金额：
  //   · 医疗险（报销型）→ 不汇总，只给份数与覆盖成员
  //   · 储蓄型（年金等）→ 不汇总保额（看的是年领/现价）
  var CAT_ORDER = ['寿险', '重疾险', '意外险', '医疗险', '年金']
  var catAgg = {}
  CAT_ORDER.forEach(function(c) { catAgg[c] = { sum: 0, count: 0, members: [], riders: 0 } })
  active.forEach(function(p) {
    var c = canonCat(p.insurance_category || '其他')
    // 2026-10-24：任何未归一到五类的险种都要有落点，**否则这笔保额在表里彻底消失**。
    // （之前只 return，增额寿/两全就属于"钱不见了"；canonCat 已补映射，这里是兜底。）
    if (!catAgg[c]) {
      if (!catAgg['其他']) catAgg['其他'] = { sum: 0, count: 0, members: [], riders: 0 }
      c = '其他'
    }
    var a = catAgg[c]
    if (!(p.isRider && p.parentKey)) a.count += 1
    else a.riders += 1
    a.sum += Number(p.sum_assured) || 0
    var who = p.insured_name || ''
    if (who && a.members.indexOf(who) === -1) a.members.push(who)
  })
  // 展示名：规范词「年金」在报告里统一叫「储蓄」（客户听得懂的口径），「其他」也保留兜底行
  var CAT_LABEL = { '寿险': '寿险', '重疾险': '重疾', '意外险': '意外', '医疗险': '医疗', '年金': '储蓄', '其他': '其他' }
  var catRows = CAT_ORDER.concat(['其他']).filter(function(c) {
    var a = catAgg[c]
    return a && (a.count > 0 || a.riders > 0)
  }).map(function(c) {
    var a = catAgg[c]
    var noSum = (c === '医疗险' || c === '年金')
    return {
      cat: CAT_LABEL[c] || c,
      sumText: noSum ? '—' : _fmtAmount(a.sum),
      membersText: a.members.join('、') || '—',
      countText: a.count + (a.riders ? '（含附加 ' + a.riders + ' 项）' : ''),
      note: c === '医疗险' ? '报销型，保额不可加总'
        : (c === '年金' ? '储蓄型（年金 / 增额寿 / 两全），不汇总保额'
          : (c === '其他' ? '未归类的险种，建议在保单里补全险种' : '名义保额'))
    }
  })

  var ch = []
  // 缺口分组（供 ④ 保障缺口章与「下一步」收口章共用）：可行动（有缺口金额）vs 信息缺失（无法计算）
  var actionable = gaps.filter(function(g) { return g.gap > 0 && g.reliability !== 'blocked' })
  var blockedGaps = gaps.filter(function(g) { return g.reliability === 'blocked' })

  // ======== 概览（2026-10-18 IA 重构，第 1 章）========
  // 动机：原「整理汇总卡 + 保障覆盖与风险卡」是页面级的两个卡片，与下面的章节正文是两套排版；
  // 且同一批信息重复：缺口出现在诊断卡 / 保障汇总章红条 / 保障缺口章三处，
  // 成员在卡片与家庭结构章各一遍，金额在汇总卡与汇总章矩阵合计各一遍。
  // 现在把它们合并成**正文的第 1 章**：一套排版、进目录、顺序由 CHAPTER_SEQ 单点定义。
  // 数据来自 caller（report-builder 传入 hero / risks / checkup），本文件不做二次计算。
  var ovHero = (opts && opts.hero) || null
  var ovRisks = (opts && opts.risks) || null
  var ovCk = opts && opts.checkup
  if (ovCk && ovCk.summary) {
    var os = ovCk.summary
    ch.push({
      key: 'overview', title: '概览',
      customBlocks: [createBlock('overview', {
        // 规模一句话：张数 / 成员数 / 年保费
        policyCount: os.policyCount,
        memberCount: os.memberCount,
        premiumText: os.annualPremiumText,
        // 保额按险种分两组（payout + quota === protection，不给合计 —— 见 coverage-summary）
        payoutText: os.payoutSumAssuredText,
        quotaText: os.quotaSumAssuredText,
        savingsText: os.savingsSumAssuredText,
        unknownText: os.unknownSumAssuredText,
        inactiveNote: os.inactiveNote || '',
        // 2026-10-21（方案第一部分第 1 项）："谁没有保单"是给客户的第一个价值点，
        // 不能只藏在家庭结构里 —— 它要出现在抬头事实那一屏。
        noPolicyNote: (os.membersWithoutPolicy && os.membersWithoutPolicy.length)
          ? '无任何保单：' + os.membersWithoutPolicy.join('、')
          : '',
        // 2026-10-21（方案「经济支柱认定」）：支柱口径改为可推断，就必须把来源写出来 ——
        // "按投保人推断"与"手动标注"对读者是两件事，不能混成一句"经济支柱：张三"。
        pillarNote: (function() {
          var pi = resolvePillar(members, active)
          if (!pi || !pi.member) return ''
          return '经济支柱：' + pi.member.name + (pi.label ? '（' + pi.label + '）' : '')
        })(),
        categories: os.categories || [],
        // 2026-10-24（审计 2.1 + 用户决策「缺口按拆法」）：概览**只留事实**。
        // 原覆盖检查（alerts「缺少X / 保额不足」）与 TOP-N 风险都建立在"需求模型"上
        // （5×收入、负债兜底），属推算而非保单事实 —— 已移出概览：
        //   · 覆盖检查 → 缺口章（明确标注"模型推算"）
        //   · TOP-N 风险 → 「数据质量提示」章（只保留可核对的事实类提示）
        // 这里不再传 alerts / risks；custom-blocks 的 overview 默认值同步保留字段仅为兼容老数据。
        // 2026-10-24（方案第一部分 2）：保障型 / 储蓄型构成。
        // 方案要求环形图；小程序 WebView 对 conic-gradient 支持不稳，改用**两段横向条 + 图例**——
        // 同一个信息（各占多少）在不引入 canvas 的前提下能稳定渲染，且横条比环更容易读绝对值。
        protectionText: os.protectionSumAssuredText || '',
        mixBars: (function() {
          var protW = 0, savW = 0
          active.forEach(function(p) {
            var c = canonCat(p.insurance_category || '其他')
            var yuan = Number(p.sum_assured) || 0
            if (c === '年金') savW += yuan
            else if (c !== '其他' && CAT_ORDER.indexOf(c) !== -1) protW += yuan
          })
          var total = protW + savW
          if (total <= 0) return []
          return [
            { key: 'prot', label: '保障型', text: _fmtAmount(protW), pct: Math.round(protW / total * 100) },
            { key: 'sav', label: '储蓄型', text: _fmtAmount(savW), pct: Math.round(savW / total * 100) }
          ]
        })(),
        // 被保人数 / 登记人数（方案第一部分第 1 项："4 人持有 / 5 人登记"）
        coveredMemberCount: (function() {
          var n = {}
          active.forEach(function(p) { if (p.insured_name) n[p.insured_name] = 1 })
          return Object.keys(n).length
        })()
      })]
    })
  }

  // ======== 异常与待核验（A1–A6，2026-10-21）========
  // 用户方案「家庭保单化验单」的第一部分第 4 项：编号固定，供 AI 导读与面谈引用（"见 A3"）。
  // 只列有字段支撑的事实（见 utils/report/anomaly-list.js 头注释）；本次为空的事项不出现（缺号=无此事项）。
  var ageByName = {}
  members.forEach(function(m) { if (m && m.name) ageByName[String(m.name)] = Number(m.age) || 0 })
  var anomalies = buildAnomalies({ policies: linkRiders(active).items, now: new Date(), ageByName: ageByName })
  if (anomalies.length) {
    ch.push({
      key: 'anomalies', title: '异常与待核验',
      customBlocks: [createBlock('anomaly_list', { items: anomalies })],
      unit: anomalies.length + ' 项'
    })
  }

  // ======== ① 家庭结构 / ② 家庭财务 ========
  // 审计·顾问视角（2026-09-04）：客户版跳过①②——成员结构与收入是顾问的核对工作底稿（带 [编辑] 入口），
  // 客户无需被重新告知自家信息；结论摘要之后直接进入保障汇总/缺口诊断
  if (!shared) {
  // 2026-10-24（方案「经济支柱认定」+ 成员顺序规则）：**支柱优先，其余按年龄降序**，
  // 同年龄再按角色组/姓名。原实现只按角色组（本人→配偶→子女→父母→其他）+ 姓名，
  // 当支柱不是"本人"（例如祖父投保、子女被保）时，支柱会排到后面 —— 与方案「支柱优先」相反。
  var pillarForSort = resolvePillar(members, active)
  var pillarName = (pillarForSort && pillarForSort.member && pillarForSort.member.name) || ''
  var sortedMembers = [].concat(members).sort(function(a, b) {
    var ap = a.name === pillarName ? 0 : 1
    var bp = b.name === pillarName ? 0 : 1
    if (ap !== bp) return ap - bp
    var aa = Number(a.age) || 0
    var ba = Number(b.age) || 0
    if (aa !== ba) return ba - aa // 年龄降序（年长靠前）
    return (_roleGroup(a.role) - _roleGroup(b.role)) || String(a.name).localeCompare(String(b.name), 'zh')
  })
  // 2026-10-18 第二步 IA：把原页面「按成员整理」的规模（N 张 · 保额）并入家庭结构节点 ——
  // 它本就是"这个人有几份保障"的信息，和姓名/角色/年龄是一件事的不同侧面。
  // 数据同源（opts.checkup.groups），不在页面另算一份。
  var ckGroups = (ovCk && ovCk.groups) || []
  var nodes = sortedMembers.map(function(m, i) {
    var role = m.role || ''
    var g = null
    for (var gi = 0; gi < ckGroups.length; gi++) {
      var gg = ckGroups[gi]
      if ((m.member_id && gg.memberId === m.member_id) || (!m.member_id && gg.name === m.name)) { g = gg; break }
    }
    // 2026-09-18 报告页审计：补稳定唯一 key —— 原 WXML 用 wx:key="name"，同名成员碰撞；
    // 而 member_id 在缺 id 的成员上为 ''，单用也会碰撞 → 用「member_id|下标」组合保证唯一
    return {
      key: (m.member_id || 'n') + '|' + i, name: m.name, role: role, age: m.age || '', member_id: m.member_id || '',
      display: m.age ? (role + '(' + m.age + ')') : role,
      // 2026-10-21：按方案「成员卡片」口径补两个事实 —— 含附加 N 项、失效 K 份。
      // 失效不计入保额，但必须写在成员旁边（否则"6 张保单 1220 万"里少了那张失效的，没人知道）
      scaleText: g
        ? (g.policyCount + ' 张' + (g.riderCount ? '（含附加 ' + g.riderCount + ' 项）' : '') +
           ' · 保额 ' + g.sumAssuredText + (g.inactiveCount ? ' · 失效 ' + g.inactiveCount + ' 份' : ''))
        : ''
    }
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
      // 2026-09-18 报告页审计：totalIncome 在"家庭收入与成员收入均未填写"时回落 0（data-normalizer L23），
      // 直传会渲染成"年收入 0万"，与⑦缴费月历章 L360 的"（家庭年收入未填写，暂不计算占比）"口径矛盾
      // ——同一份 owner 视图里两章对同一事实说法不一。传 null 让渲染侧区分"未填写"与"真的是 0"。
      // 注：debt 不这样处理——"总负债 0万"是准确表述（无负债），不存在未填写歧义。
      income: totalIncome > 0 ? totalIncome : null,
      debt: Math.round(debt * 100) / 100
    })]
  })
  }

  // ======== ③ 保障汇总 ========
  // 客户版中性措辞："已有XX保障待完善"，不写"缺少XX"式恐吓文案（数据不变，换视角）
  // 2026-10-17 修：原实现把 `gap > 0` 一律写成"缺少"——**有保单但低于需求也是 gap > 0**
  // （真机截图里矩阵写着"李阳勇 重疾险 20万"，红条却写"缺少…重疾"，代理人当场被问住）。
  // 现在区分两种事实：无此类保单 → "缺少X"；有但不足 → "X保额不足（缺口 N 万）"。
  var missingLines = (function() {
    var lines = []
    for (var i = 0; i < members.length; i++) {
      var m = members[i]
      var mg = gaps.filter(function(g) { return g.member === m.name && g.gap > 0 })
      if (mg.length === 0) continue
      if (shared) {
        // 客户版不报缺口金额（金额在缺口章统一给），只给"待完善"
        lines.push(m.name + '的' + mg.map(function(g) { return _shortCat(g.category) }).join('、') + '保障待完善')
        continue
      }
      var absent = mg.filter(function(g) { return !(Number(g.existing) > 0) }).map(function(g) { return _shortCat(g.category) })
      var short = mg.filter(function(g) { return Number(g.existing) > 0 })
        .map(function(g) { return _shortCat(g.category) + '保额不足（缺口 ' + _numW(g.gap) + ' 万）' })
      var segs = []
      if (absent.length) segs.push('缺少' + absent.join('、'))
      if (short.length) segs.push(short.join('；'))
      lines.push(m.name + segs.join('；'))
    }
    return lines
  })()
  ch.push({
    key: 'coverage_summary', title: '保障汇总', num: '3',
    unit: '单位：万元',
    // 2026-10-24（审计 2.1）：原红条「缺少 X / Y 保额不足」是**需求模型判断**，
    // 与缺口章重复且会把"够不够"放在矩阵上方先入为主。事实性内容（谁有哪些险种、保额多少）
    // 已由矩阵与下方分险种表承担；判断统一收在缺口章的「模型推算」段。
    pre: '',
    customBlocks: [
      createBlock('panorama', { heads: matrix.heads, cats: matrix.cats, rows: matrix.rows }),
      // 分险种合计（方案第一部分第 3 项）：矩阵回答"谁有什么"，这张表回答"每类保障总量/覆盖几人/几份"
      createBlock('cat_table', { rows: catRows })
    ]
  })

  // ======== ④ 保障期间（甘特图 + 未来关键时点）========
  // 2026-10-13 报告结构 v2.0 ③（P0）：**紧接保障汇总**——先看"有什么够不够"（③矩阵），
  // 立刻看"保障到什么时候"（本章），再看缺口（⑤）。原位置在缺口之后（第 5 章），
  // 与 v2.0 把甘特图列为 P0 的定位不符（时间维是"有没有"的第二问，不是缺口的注脚）。
  // 甘特图与节点清单同章：甘特图=全局"谁有什么保障到何时"，节点清单=未来关键时点，
  // 拆两章会把时间信息打散；也避免与 ③保障统计矩阵的重叠进一步恶化。
  // ⛔ 甘特图只画时间条：空白期/重叠区/断档倒计时**不做**（缺字段，理由见 gantt-builder.js 头注释）。
  //
  // 节点部分（审计 S1）：一次性关键时点优先于每年重复的缴费月历。仅展示三种节点
  // ——保障期满/交费期满/现价保本（排除每年缴费提醒 payment）；年份为第一层，年份下多款产品归类，
  // 单产品同年多节点以「/」分隔；产品分组键含被保人，防同产品跨被保人误合并。
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
  // 2026-10-21（方案第四部分）：失效保单也进甘特图，画成灰条 + 空心终点 ——
  // "这张已经不能用了"本身是重要事实，之前只在 A1 与附录里，时间轴上完全看不见。
  // 节点清单（timeline）仍只用 active：已失效保单的期满日不是"待办"。
  var ganttData = buildGantt(policies, members)
  // 2026-10-21（方案第四部分第 9 项）：节点清单按"距今"分三组，而不是一条长列表。
  // 分组的价值是读者知道"哪些要现在处理、哪些是十年后的事"；逐条时间线读起来像流水账。
  var nowY = new Date().getFullYear()
  var TL_GROUPS = [
    { key: 'now', title: '未来 12 个月', test: function(y) { return y <= nowY + 1 } },
    { key: 'mid', title: '中期（1–5 年）', test: function(y) { return y > nowY + 1 && y <= nowY + 5 } },
    { key: 'far', title: '长期（5 年以上）', test: function(y) { return y > nowY + 5 } },
    { key: 'past', title: '已过（核对状态）', test: function(y) { return y < nowY } }
  ]
  var tlGroups = TL_GROUPS.map(function(g) {
    return { key: g.key, title: g.title, items: timelineItems.filter(function(it) { return g.test(it.y) }) }
  }).filter(function(g) { return g.items.length > 0 })
  ch.push({
    key: 'premium_timeline', title: '保障期间',
    customBlocks: (ganttData.rows.length ? [createBlock('gantt', ganttData)] : [])
      .concat([createBlock('timeline', { items: timelineItems, groups: tlGroups })])
  })

  // ======== ⑦ 成员卡片（2026-10-24，方案第二部分第 6 项）========
  // 每个成员一张固定五行的表（意外/医疗/重疾/寿险/储蓄），列 = 保额 / 年缴保费 / 保险期间 / 缴费期间。
  // 这是"按人看"的唯一视图：矩阵是按险种横向比、附录是按保单逐条列，两者都不能回答
  // "张先生这一年到底交了多少钱、都保到什么时候"。
  // 附加险并入主险的险种行（保额与保费计入），份数按主险计。
  var linkedActive = linkRiders(active).items
  var MEMBER_ROWS = [['意外险', '意外'], ['医疗险', '医疗'], ['重疾险', '重疾'], ['寿险', '寿险'], ['年金', '储蓄']]
  var _distinct = function(arr) {
    var out = []
    arr.forEach(function(v) { if (v && out.indexOf(v) === -1) out.push(v) })
    return out
  }
  var memberCards = members.map(function(m) {
    var mine = linkedActive.filter(function(p) { return String(p.insured_name || '') === String(m.name || '') })
    var rows = []
    MEMBER_ROWS.forEach(function(pair) {
      var cat = pair[0], label = pair[1]
      var inCat = mine.filter(function(p) { return canonCat(p.insurance_category || '') === cat })
      if (!inCat.length) return
      var mains = inCat.filter(function(p) { return !(p.isRider && p.parentKey) })
      var riders = inCat.length - mains.length
      var sumYuan = inCat.reduce(function(s, p) { return s + (Number(p.sum_assured) || 0) }, 0)
      var premYuan = inCat.reduce(function(s, p) { return s + (Number(p.annual_premium) || 0) }, 0)
      var periods = _distinct(inCat.map(function(p) { return _periodText(p) }))
      var pays = _distinct(inCat.map(function(p) { return _payTermText(p) }))
      rows.push({
        cat: label,
        // 医疗险是报销型，保额不可加总 → 只给份数（与分险种表同一口径）
        sumText: cat === '医疗险'
          ? (mains.length + ' 份' + (riders ? '（含附加 ' + riders + ' 项）' : ''))
          : (sumYuan > 0 ? _fmtAmount(sumYuan) : '—'),
        premiumText: premYuan > 0 ? _fmtAmount(premYuan) : '—',
        periodText: periods.length === 1 ? periods[0] : (periods.length ? '多种（见附录）' : '未知'),
        payText: pays.length === 1 ? pays[0] : (pays.length ? '多种（见附录）' : '未知'),
        inactive: false
      })
    })
    // 失效保单单独成行（方案：失效行也进卡片，但不计入合计）
    var inactiveMine = linkRiders(policies.filter(function(p) {
      return p.status !== 'deleted' && p.status !== 'active' && String(p.insured_name || '') === String(m.name || '')
    })).items
    MEMBER_ROWS.forEach(function(pair) {
      var cat = pair[0], label = pair[1]
      var inCat = inactiveMine.filter(function(p) { return canonCat(p.insurance_category || '') === cat })
      if (!inCat.length) return
      var sumYuan = inCat.reduce(function(s, p) { return s + (Number(p.sum_assured) || 0) }, 0)
      rows.push({
        cat: label + '（失效）',
        sumText: cat === '医疗险' ? (inCat.length + ' 份') : (sumYuan > 0 ? _fmtAmount(sumYuan) + '（不计入合计）' : '—'),
        premiumText: '—', periodText: '—', payText: '—', inactive: true
      })
    })
    var activeCount = mine.filter(function(p) { return !(p.isRider && p.parentKey) }).length
    var riderCount = mine.length - activeCount
    var premTotal = mine.reduce(function(s, p) { return s + (Number(p.annual_premium) || 0) }, 0)
    return {
      name: m.name || '待补姓名',
      role: m.role || '',
      age: m.age || '',
      rows: rows,
      premiumTotalText: _fmtAmount(premTotal),
      footNote: '有效 ' + activeCount + ' 份' + (riderCount ? '（含附加 ' + riderCount + ' 项）' : '') +
        (inactiveMine.length ? ' · 失效 ' + inactiveMine.length + ' 份' : '')
    }
  }).filter(function(c) { return c.rows.length > 0 })
  if (memberCards.length) {
    ch.push({
      key: 'member_cards', title: '成员卡片',
      pre: '每个成员一张表：五类险种各自的保额、年缴保费与期间。附加险并入所属险种，份数按主险计。',
      customBlocks: [createBlock('member_cards', { members: memberCards })]
    })
  }

  // ======== ⑤ 保障缺口（2026-10-24 拆分：**事实段 / 推算段**）========
  // 用户决策（采纳审计建议的"拆"法）：保留"谁有哪些险种、保额多少"这类保单事实，
  // 把"需求—缺口"明确标为**模型推算**。
  // 原因：需求靠 5×收入、负债兜底等参数推出来，不是保单上写的东西。混在一张表里，
  // 客户会把"缺口 30 万"当成合同金额 —— 而它连"要不要补"都取决于顾问的判断。
  var showGapCh = gaps.length > 0
  if (showGapCh) {
    var gapLines = []
    var gapByMember = {}
    gaps.forEach(function(g) {
      if (!gapByMember[g.member]) gapByMember[g.member] = []
      gapByMember[g.member].push(g)
    })
    // —— 事实段：每人每险种的"已有保额 / 无"
    Object.keys(gapByMember).forEach(function(mn) {
      var mb = members.find(function(x) { return x.name === mn }) || null
      gapLines.push('**' + mn + '**' + (mb && mb.role ? '（' + mb.role + '）' : ''))
      // markdown-render 段落会吞并紧随的列表行，标题后留空行让列表独立解析
      gapLines.push('')
      gapByMember[mn].forEach(function(g) {
        var has = Number(g.existing) > 0
        gapLines.push('- ' + _shortCat(g.category) + '：' + (has ? _numW(g.existing) + ' 万' : '无'))
      })
    })
    // —— 推算段：需求 / 缺口 / 优先级（明确标注来源）
    if (actionable.length > 0) {
      gapLines.push('')
      gapLines.push('**模型推算（不是保单事实）**')
      gapLines.push('')
      gapLines.push('需求与缺口按家庭收入、负债等参数推算，随收支信息更新而重算；仅供顾问参考。')
      gapLines.push('')
      actionable.forEach(function(g) {
        gapLines.push('- ' + g.member + ' ' + _shortCat(g.category) + '：需求 ' + _numW(g.reference) +
          ' 万 − 已有 ' + _numW(g.existing) + ' 万 = 缺口 ' + _numW(g.gap) + ' 万（优先级：' + g.priorityLabel + '）')
      })
    }
    if (blockedGaps.length > 0) {
      var bCats = []
      var bMems = []
      blockedGaps.forEach(function(bg) {
        if (bCats.indexOf(bg.category) === -1) bCats.push(bg.category)
        if (bMems.indexOf(bg.member) === -1) bMems.push(bg.member)
      })
      gapLines.push('')
      // 2026-10-17 修：原文案写"因年收入缺失无法计算"，但第 2 章明明显示年收入——
      // 真实原因是家庭年收入只兜底给经济支柱（gap-core.js）。
      gapLines.push(bMems.join('、') + ' 的' + bCats.join('、') + '需按个人收入测算：家庭年收入仅用于测算经济支柱，未拆分到其他成员；补充成员收入后即可计算。')
    }
    ch.push({
      key: 'gap_analysis',
      // 章名改为「保额与缺口」：前半是事实（保额），后半是推算（缺口），章名两者都要说清
      title: '保额与缺口',
      pre: '上半部分是保单事实（各成员各险种的已有保额）；下半部分的需求与缺口为模型推算，不是保单载明金额。',
      unit: '单位：万元',
      content: gapLines.join('\n')
    })
  }

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
  // 保费收入比判定（报告结构 v2.0 ④）：仅 owner 且收入已知时输出。口径见 thresholds.PREMIUM_RATIO
  // （7%/10% 属行业经验值、非监管标准 → 文案只写"常见参考区间"）。收入缺失时 premiumRatio 回落 0
  // → verdict.code='unknown' → text 为空 → 不输出（有依据才出结论）。
  var premiumNote = (!shared && totalIncome > 0) ? premiumRatioVerdict(premiumRatio).text : ''
  // 保费现金流（2026-10-14 用户稿子）：下一期缴费（含第几期）+ 缴费期满释放的现金流。
  // 口径走跨树契约 premium-trend.js（与 PDF 缴费月历节同源）；这两条都是**事实**，
  // 客户版照样给（金额与期数不属"对客户隐藏的内部口径"），只有占收入比才是 owner 专属。
  var trend = buildPremiumTrend(active, members)
  var trendLines = []
  if (trend.upcoming.length) {
    var _u = trend.upcoming[0]
    // 带保单名 + 第几期（与 PDF 同节同文案）：只写"1 笔"会让读者不知道是哪张保单的哪一期
    var _names = _u.list.slice(0, 2).map(function(it) { return it.product + ' 第' + it.periodNo + ' 期' }).join('、')
    if (_u.list.length > 2) _names += ' 等'
    trendLines.push('下一期缴费：' + _u.y + '年' + _u.m + '月，合计 ' + _u.amountW + ' 万（' + _u.count + ' 笔' + (_names ? '：' + _names : '') + '）')
  }
  // 最多两级台阶：最近一次下降 + 最终归零（中间的逐个列没信息量）
  var _stepIdx = trend.drops.length > 2 ? [0, trend.drops.length - 1] : trend.drops.map(function(_, i) { return i })
  _stepIdx.forEach(function(i) {
    var d = trend.drops[i]
    trendLines.push(d.y + ' 年起年缴保费降至 ' + d.toW + ' 万（' + d.products.join('、') + ' 缴费期满），每年减少支出 ' + d.reducedW + ' 万')
  })
  // ======== 保费分布 7a 成员×险种 / 7b 按公司（2026-10-21）========
  // 用户方案第三部分要求四段铺陈：成员×险种、公司、月份、年份。后两段已有
  // （premium_trend 年度柱 + calendar 月历），这里补前两段。
  // 口径：只计有效保单、按险种归列（附加险保费计入自身险种）；储蓄型不并入保障型。
  var PREM_COLS = ['意外险', '医疗险', '重疾险', '寿险', '储蓄', '其他']
  var SAVING_CATS = ['年金', '增额终身寿', '两全', '储蓄']
  function _premCol(cat) {
    var c = canonCat(cat || '')
    if (!c) return '其他'
    if (SAVING_CATS.indexOf(c) !== -1) return '储蓄'
    if (PREM_COLS.indexOf(c) !== -1) return c
    // 险种归一后仍不在六列内（如"其他"）→ 归"其他"，不硬塞进某个险种
    return '其他'
  }
  var premByMember = {}
  var premColTotal = {}
  PREM_COLS.forEach(function(c) { premColTotal[c] = 0 })
  members.forEach(function(m) { premByMember[m.name] = {} })
  // 单位用**元**不用万元：800 元在"万元 / 1 位小数"下会显示成 0.1 万，
  // 行合计再相加就与真实总额对不上（实测真值 1.42 万被算成 1.4 万）。
  // 用元做整数求和，∑行 = 合计 = ∑公司 精确相等 —— 这张表的价值就是"能对上"。
  active.forEach(function(p) {
    var who = p.insured_name || '未指定被保人'
    if (!premByMember[who]) premByMember[who] = {}
    var col = _premCol(p.insurance_category)
    var yuan = Math.round(Number(p.annual_premium) || 0)
    premByMember[who][col] = (premByMember[who][col] || 0) + yuan
    premColTotal[col] += yuan
  })
  var memberRows = Object.keys(premByMember).map(function(n) {
    var rowTotal = 0
    var cells = PREM_COLS.map(function(c) {
      var v = premByMember[n][c] || 0
      rowTotal += v
      return { v: v > 0 ? String(v) : '—', s: v > 0 ? '' : 'none' }
    })
    return { name: n, cells: cells, total: String(rowTotal), totalNum: rowTotal }
  }).sort(function(a, b) { return b.totalNum - a.totalNum })
  var grandTotal = memberRows.reduce(function(s, r) { return s + r.totalNum }, 0)
  // 按公司：份数用"独立份数"（附加险不重复计），金额含附加险（那是真实支出）
  var insMap = {}
  active.forEach(function(p) {
    var key = p.insurer || '未知保司'
    if (!insMap[key]) insMap[key] = { name: key, count: 0, premium: 0 }
    if (!(p.isRider && p.parentKey)) insMap[key].count += 1
    insMap[key].premium += Math.round(Number(p.annual_premium) || 0)
  })
  var insurerRows = Object.keys(insMap).map(function(k) { return insMap[k] })
    .sort(function(a, b) { return b.premium - a.premium })
    .map(function(x) {
      return {
        name: x.name, count: x.count, premiumText: String(x.premium),
        pct: grandTotal > 0 ? Math.round(x.premium / grandTotal * 100) : 0
      }
    })
  var premiumSplit = {
    memberHeads: ['成员', '意外', '医疗', '重疾', '寿险', '储蓄', '其他', '合计'],
    memberRows: memberRows,
    // 合计行也做成"与列一一对应"的数组（模板里用 wx:for + wx:if 拼空单元格容易出错）
    memberTotalCells: PREM_COLS.map(function(c) {
      var v = premColTotal[c] || 0
      return { v: v > 0 ? String(v) : '—', s: v > 0 ? '' : 'none' }
    }),
    memberTotal: String(grandTotal),
    insurerRows: insurerRows,
    // 单位与口径写在块内（不放 chapter content，避免与下方月历文案混在一起）
    unitText: '单位：元 / 年',
    note: '仅计有效保单；附加险保费计入自身险种；储蓄型单列'
  }

  // 年度保费柱（2026-10-18 用户提议「做成保费年历、看到现金流释放」）：
  // 与甘特图的缴费期满竖线**不是重复**——甘特图是单张保单视角（这份何时缴完），
  // 这里是家庭合计视角（全家哪一年松一口气）。阶梯数据早已由 premium-trend 算出，
  // 之前只输出两行文字，看不出"形状"。
  // 口径：只含长期险（一年期按年续保、趸交不计入曲线）—— 否则一年期保单次年"消失"会造成假台阶。
  var trendMax = 0
  trend.years.forEach(function(x) { if (x.w > trendMax) trendMax = x.w })
  var dropYears = {}
  trend.drops.forEach(function(d) { dropYears[d.y] = 1 })
  var lastY = trend.years.length ? trend.years[trend.years.length - 1].y : 0
  var trendYears = trend.years.map(function(x) {
    var isNow = x.y === trend.thisYear
    var isDrop = !!dropYears[x.y]
    return {
      y: x.y,
      w: x.w,
      pct: trendMax > 0 ? Math.round(x.w / trendMax * 100) : 0,
      isNow: isNow,
      isDrop: isDrop,
      // 标签不是每年都画（年数最多 40，全标会糊成一片）：每 5 年 + 首尾 + 当前 + 掉档年
      showLabel: x.y % 5 === 0 || isNow || isDrop || x.y === trend.thisYear || x.y === lastY
    }
  })
  ch.push({
    // 章名由「缴费月历」改为「缴费与现金流」：本章现在有年度趋势（跨年）+ 月历（年内）两个维度，
    // 原名只描述了后者。
    key: 'premium_calendar', title: '缴费与现金流', num: '5',
    // V1.5（2026-09-12）：明细型章节默认折叠——首屏只保留结论/缺口，月历与附录按需展开（保留手动展开能力）
    // 2026-10-22（方案阅读规则「非必要不折叠」）：本章改为**默认展开** —— 它现在承载
    // 保费分布四段（构成/公司/月份/年份），是"钱花在哪"的主答案，折起来等于让客户多点一次。
    // 附录仍默认折叠（方案明确允许：保单明细为"列表摘要 + 点击展开"）。
    collapsible: true, defaultCollapsed: false,
    customBlocks: [
      // 2026-10-21 用户方案「保费分布四段」：成员×险种 + 按公司（月份、年份由下方两块承担）
      createBlock('premium_split', premiumSplit),
      // 年度柱：造型（哪几年高、哪一年掉一档）；精确金额仍写在下方文字里，图不重复标数字
      createBlock('premium_trend', { years: trendYears, maxW: trendMax, thisYear: trend.thisYear, currentW: trend.currentW }),
      createBlock('calendar', { items: months })
    ],
    // 下方提示：无列表垂直排列（年保费 → 峰值月），markdown-render 以 <br> 换行
    // 客户版：占收入比标注"家庭年收入占比，仅供参考"（数据保留，缓解"推销感"顾虑）
    // 2026-09-09：家庭年收入缺失时不再输出"（占收入 0%）"——data-normalizer 在 totalIncome=0 时
    // premiumRatio 回落 0，原实现直接拼成 0%，与"收入未填写"事实矛盾；改为显式缺失说明
    // 2026-09-12 客户版去除占收入比：家庭财务章对客户隐藏（:181），客户无从核对"家庭年收入"基数，
    // 引用不可见数据并附"仅供参考"是双重减分（数字算不出 + 结论自我注销）。owner 侧保留占比。
    // 2026-10-13 报告结构 v2.0 ④：owner 侧补"参考区间判定"（thresholds.PREMIUM_RATIO 7%/10%）。
    // ⚠️ 判定文案只随 owner 的占比一起出现 —— 客户版不显示占比，也不得显示基于占比的结论
    // （引用不可见数据下结论，与上一行同一条口径）；家庭年收入缺失时不判定（verdict.code='unknown'）。
    content: '年总保费 ' + annualPremiumW + '万' + (!shared
      ? (totalIncome > 0 ? '（占收入 ' + premiumRatio + '%）' : '（家庭年收入未填写，暂不计算占比）')
      : '') + (premiumNote ? '<br>' + premiumNote : '')
      + (trendLines.length ? '<br>' + trendLines.join('<br>') : '')
      + (peakMonth ? '<br>💡 ' + peakMonth + '缴费压力最大，请提前安排资金' : '')
  })

  // ======== 数据质量提示（原「特别提醒」，2026-10-24 改造）========
  // 审计建议"并入待完善"，但它与待完善是**两类**事实：
  //   待完善 = 缺字段（没读到/没填）；本段 = 读到了但**不确定**（置信度低，可能识别错）。
  // 因此不合并，而是改名、去掉"告警"语气、放在待完善之前（同属数据质量，位置相邻），
  // 并给固定编号 A7，供导读/面谈引用（与 A1–A6 同一套索引体系）。
  var alerts = shared ? [] : buildConfidenceAlerts(active)
  if (alerts.length > 0) {
    ch.push({
      key: 'risk_alerts', title: '数据质量提示（A7）',
      pre: '以下字段的识别置信度较低，可能与保单原文不一致；已在卡片上标注，供核对时优先看。',
      customBlocks: [createBlock('risk_alerts', { items: alerts })]
    })
  }

  // ======== ⑦ 附录：保单明细 ========
  // 二级分组：先按被保人、再按保险公司归类；保司缺失归「未知保司」
  // 组名排序：被保人/保司均按名称排序
  // 组内排序：保单号升序为主键（同号主险+附加险自然相邻），同号内按产品名，空保单号排最后
  var groups = []
  // 2026-10-21（方案第五部分）：先按**状态**分组 —— 失效/异常组在前、有效组在后，组内再按成员。
  // 原实现只有"成员 → 保司"两级，失效保单混在有效里只靠一个小标签区分，
  // 读者要逐张看完才知道"哪些已经不能用了"。
  var byStatus = { inactive: {}, active: {} }
    // 附录展示所有非软删保单（含失效/退保/理赔终止/到期终止），并带状态标签；
    // 保障汇总/缴费月历仍只使用 active（见 data-normalizer）
    // 2026-10-21：附加险归属（项目按产品入库 → 主险/附加险是两条文档），用于"缩进挂主险"
    const displayPolicies = linkRiders(policies.filter(function(p) { return p.status !== 'deleted' })).items

  var sorted = [].concat(displayPolicies).sort(function(a, b) {
    var pa = String(a.policy_number || '')
    var pb = String(b.policy_number || '')
    if (!pa && pb) return 1
    if (pa && !pb) return -1
    if (pa && pb && pa !== pb) return pa.localeCompare(pb, 'zh')
    // 同一张保单内：主险排在附加险之前（否则"附加XX"按中文字序会跑到主险上面）
    if (!!a.isRider !== !!b.isRider) return a.isRider ? 1 : -1
    return String(a.product_name || '').localeCompare(String(b.product_name || ''), 'zh')
  })
  // 主险索引：附加险的"状态/受益人/节点随主险"（方案「附加险口径」第 3 条）
  var byLinkKey = {}
  sorted.forEach(function(x) { byLinkKey[x._linkKey] = x })

  for (var i = 0; i < sorted.length; i++) {
    var p = sorted[i]
    var n = p.insured_name || '未归属'
    var ins = p.insurer || '未知保司'
    // 附加险：状态与受益人取自挂靠的主险（同一份合同，主险失效时附加险不可能仍有效）
    var parent = (p.isRider && p.parentKey && byLinkKey[p.parentKey]) || null
    var effStatus = parent ? (parent.status || 'active') : (p.status || 'active')
    var effBeneficiary = parent ? (parent.beneficiary_name || '') : p.beneficiary_name
    var bucket = (effStatus && effStatus !== 'active') ? 'inactive' : 'active'
    if (!byStatus[bucket][n]) byStatus[bucket][n] = {}
    if (!byStatus[bucket][n][ins]) byStatus[bucket][n][ins] = []
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
    // 2026-09-18 报告页审计：补保单号 / 投保人 / 受益人。
    // 保单号是代理人向保司查档的第一键；受益人此前报告全无展示，而 AI 会在建议里讲
    // 「指定受益人做资产隔离」——建议与现状脱节，代理人无法据此核对。
    // ⚠️ 此处**不能用 _joinRow**：它把缺失项渲染成「未知」（见 L51-53），三项皆缺时会输出
    // "未知 · 未知 · 未知" 的纯噪音。改为只拼接有值项，全缺时 meta3 为空串 → WXML 整行不渲染。
    // （投保人通常是本人，故多数卡片只有「保单号」项。）
    var meta3Parts = []
    // 2026-10-21：分组改为"状态 → 成员"后，保司不再出现在组名里 → 下沉到卡片
    if (p.insurer) meta3Parts.push('保司 ' + p.insurer)
    if (p.policy_number) meta3Parts.push('保单号 ' + p.policy_number)
    if (p.policyholder_name) meta3Parts.push('投保人 ' + p.policyholder_name)
    if (effBeneficiary) meta3Parts.push('受益人 ' + effBeneficiary)
    var meta3 = meta3Parts.join(' · ')
    // 当前年份现金价值（代理人/客户均展示；仅储蓄型保单有现价表，其余为空串）
    var cashW = _currentCashValue(p, family.cashValues)
    var cashDisp = ''
    if (cashW !== null && cashW > 0) {
      cashDisp = '当前现价 ' + String(Math.round(cashW * 10) / 10) + '万'
    }
    byStatus[bucket][n][ins].push({
      policy_id: p.id || p._id || '',
      product_name: p.product_name || '未知产品',
      category: _shortCat(canonCat(p.insurance_category || '其他')),
        // 附加险显示主险状态（同一份合同；主险失效时附加险不可能仍有效）
        status: effStatus,
        status_label: POLICY_STATUS_LABELS[effStatus] || effStatus || '有效',
      // 2026-09-10：移除「保障期已过」标记（用户决策：一年期产品默认有效，除非手动改状态）。
      // ⚠️ 2026-09-22 交叉引用：本条**不移除**后来新增的"载明期限已过"提醒（PDF `_expiryNote` /
      // AI 上下文 `_renderExpiryAlerts`），两者词面相似但语义相反，勿据本条去删它们：
      //   - 被移除的卡片标签：把保单**判成已失效**（与"有效"并列 → 用户以为保障没了）✗
      //   - 现在的提醒：声明**载明期限已过、按保证续保默认仍有效**，请确认是否续保 ✓
      //   依据是 2026-09-22 决策「一年期产品默认是续保的，但是可以在文中给出提醒」。
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
      meta2: meta2,
      meta3: meta3,
      // 2026-10-18（v2.0「结论可溯源」最小实现）：OCR 时 AI 摘录的原文片段。
      // 只拼一行、只取有值的，供代理人在附录里核对"这个数字是从哪句话读来的"。
      evidence: _evidenceLine(p.field_evidence),
      // 2026-10-21：附加险在附录里缩进挂在主险下（项目按产品入库，两者本是独立文档）
      isRider: !!p.isRider,
      parentKey: p.parentKey || '',
      rider_count: p.riderCount || 0
    })
  }
  // 状态分组：失效/异常在前（方案第五部分），有效在后；组内按成员，成员内按保司
  ;[['inactive', '失效 / 异常'], ['active', '有效']].forEach(function(pair) {
    var bucketKey = pair[0]
    var bucketLabel = pair[1]
    var map = byStatus[bucketKey]
    var memberNames = Object.keys(map).sort(function(a, b) { return a.localeCompare(b, 'zh') })
    if (!memberNames.length) return
    var total = memberNames.reduce(function(s, n) {
      return s + Object.keys(map[n]).reduce(function(s2, ins) { return s2 + map[n][ins].length }, 0)
    }, 0)
    var subgroups = memberNames.map(function(n) {
      var insurers = Object.keys(map[n]).sort(function(a, b) { return a.localeCompare(b, 'zh') })
      var policies = []
      insurers.forEach(function(ins) { policies = policies.concat(map[n][ins]) })
      return { name: n, policies: policies }
    })
    groups.push({ name: bucketLabel + '（' + total + ' 张）', subgroups: subgroups })
  })
  // ======== 原「下一步行动」章已删除（2026-10-21 用户决策：现阶段报告不做诊断、不给建议）========
  // 它原来输出的是"1. 优先为 X 补充寿险（缺口约 N 万）"—— 这是建议，不是事实。
  // 事实层面的信息（谁的哪个险种有缺口、缺口多少）已经在 gap_analysis 章里按成员列出，
  // 并带有优先级字段；把它再翻译成"该补什么"，就把报告从"化验单"变成了"处方"。
  // AI 阶段（页尾进阶报告，手动生成）仍然给行动清单，那是明确标注来源的解读层，与事实层分开。
  // 排序说明改为写在缺口章的尾注里（见 gap_analysis 的收尾），只陈述排序依据，不派任务。

  // 待完善（2026-10-18 第二步 IA）：原页面级「待完善」清单搬进正文，作为附录前的最后一章。
  // 数据源不变（organize 的 pending，已按保单聚合），只是换渲染位置 —— 页面不再自己列。
  if (ovCk && ovCk.pending && ovCk.pending.length) {
    ch.push({
      key: 'pending_data', title: '待完善',
      // 一句话说明这一章存在的意义（否则用户会以为是系统错误清单）
      pre: '以下保单有字段缺失或待核对，补充后报告中的金额与缺口会更准。',
      customBlocks: [createBlock('pending_list', { items: ovCk.pending })],
      unit: ovCk.pending.length + ' 张保单'
    })
  }

  // 附录：保单明细（不作为编号章节，仅保留标题 + 保单卡片）
  // 审计 L1：明细型低频查阅，默认折叠
  ch.push({
    key: 'appendix_policies', title: '附录：保单明细',
    // V1.5（2026-09-12）：明细型章节默认折叠（首屏只留结论与缺口），保留手动展开能力
    collapsible: true, defaultCollapsed: true,
    customBlocks: [createBlock('policy_cards', { groups: groups })],
    // 有效保单数提升至标题右侧（unit 字段渲染于标题旁，原 note 在章底部）
    unit: '有效 ' + policyCount + ' 份 / 共 ' + displayPolicies.length + ' 份'
  })

  // 章序（2026-10-17）：缺口紧跟保障汇总，保障期间（时间维）后置。
  // 依据 v2.0 诊断优先级「有没有（覆盖）→ 够不够（保额/缺口）→ 贵不贵（结构）」：
  // 缺口是诊断核心，原先排在"保障期间"这层时间信息之后，读者要越过一张甘特图才看到最该看的东西。
  // 用显式序列而非就地搬代码块：① diff 小、可回退 ② 未列出的章节按原顺序兜底追加（未来新增章不丢）。
  // ⚠️ 必须列全：漏掉的章节会走下方"兜底追加"被推到附录之后（next_steps 第一次就漏了）
  // ⚠️ 必须列全：漏掉的章节会走下方"兜底追加"被推到附录之后（next_steps 曾经就漏了）
  // 待完善放最后（附录前）：它是"数据质量补录"清单，不该插在诊断结论之间。
  // 异常清单紧跟概览：它是"先看结论，再看哪几件事要处理"的第二眼
  // 2026-10-21：「下一步行动」章已删除（现阶段不做诊断/不给建议），排序说明并入缺口章尾注
  // 2026-10-24：数据质量提示（原特别提醒）与待完善相邻 —— 两者都是"数据质量"，只是缺字段 vs 不确定
  var CHAPTER_SEQ = ['overview', 'anomalies', 'family_structure', 'family_finance', 'coverage_summary', 'member_cards', 'gap_analysis', 'premium_timeline', 'premium_calendar', 'risk_alerts', 'pending_data', 'appendix_policies']
  var ordered = []
  CHAPTER_SEQ.forEach(function(k) {
    ch.forEach(function(c) { if (c.key === k) ordered.push(c) })
  })
  ch.forEach(function(c) { if (CHAPTER_SEQ.indexOf(c.key) === -1) ordered.push(c) })

  // 统一章节编号：正式章按渲染顺序重排 1..N（附录不编号）——客户版跳过①②后序号依然连续，
  // 缺口/收口/告警章按是否存在动态插入后编号自动顺延
  var seq = 0
  for (var ci = 0; ci < ordered.length; ci++) {
    if (ordered[ci].key !== 'appendix_policies') { seq++; ordered[ci].num = String(seq) }
  }
  return ordered
}

module.exports = { buildChapters, buildConfidenceAlerts, _currentCashValue }
