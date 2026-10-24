/**
 * gantt-builder.js — 保障期间甘特图（时间条）数据构建
 *
 * 回答一个问题：**谁、有什么、保障到什么时候**（横轴时间，纵轴分人分产品；条长=保障期间）。
 * 纯计算模块，不依赖 AI、不落库，可独立单测（同 timeline-builder 的定位）。
 *
 * 设计依据：`specs/report-v2-20261013/design.md`（报告结构 v2.0）③ 保障期间甘特图，
 * 以及其中「评审必改②：分两步」的约束 —— 本轮**只做可做的那一步**，即时间条。
 *
 * ⛔ **明确不做（缺数据基础，别顺手加）**：
 *   - **空白期**（如"60 岁后重疾保障断崖"）：需要按年龄/时间做区间求差的语义判定，
 *     而"保障中断多久算断崖"没有口径，硬做只能靠猜。
 *   - **重叠区**（报销型医疗险重叠）：`docs/data-model-v2.md:177-179` 已决"不按报销型/给付型
 *     拆分"，**无字段** → 只能靠产品名/AI 推断 → 制造误报，违反"误报趋近于零"。
 *     前置条件：补 `reimbursement_type` 字段（见 v2.0 交接清单）。
 *   - **断档倒计时预警**：一年期险是"续保"不是"到期"（`policy-status.isOneYearPolicy`），
 *     对它们做到期倒计时是伪警报 → 本模块只**标注**其为一年期，不做倒计时。
 * 铁律（沿用 v2.0 评审）：**没有字段的判定不出**。
 *
 * 时间粒度取**年**：与 `timeline-builder` 一致（OCR 的 `insurance_period` 多为"至N岁/20年/终身"
 * 这类年级精度文本），避免伪造月级精度。
 */
const { isLifetimeTerm, isOneYearPolicy, isSinglePayTerm } = require('../policy-status')
// 双字段期限口径：直接引用跨树契约（不再经 timeline-builder 转出 —— 2026-10-14 收敛）
const { coverTermYear, payTermYear } = require('../policy-terms')
// 附加险归属（2026-10-21）：附加险不单独画条，并入主险行
const { linkRiders } = require('../rider-link')

// 极短保障期（如一年期）在整条时间轴上的可视宽度下限（%），否则会渲染成一条看不见的线
const MIN_WIDTH_PCT = 3
// 横轴刻度数量上限（含首尾）：小程序窄屏，超过 6 个标签会互相压叠
// 2026-10-17：6 → 4。真机截图（iPhone 12/13）里 6 个刻度在窄轨道上压叠成两行数字，
// 完全不可读（.gt-tick 是 absolute 定位、无 nowrap，挤到就换行）。4 个锚点 + "今天"竖线足够定位。
const MAX_TICKS = 4

function _round1(n) { return Math.round(n * 10) / 10 }

/** 保障期间是否为"终身/长期"（与 timeline-builder 同口径：数字哨兵 105 + 文本关键词） */
function _isLifetimePolicy(p) {
  if (isLifetimeTerm(p && p.coverage_term)) return true
  return /终身|长期/.test(String((p && p.insurance_period) || ''))
}

/** 万为单位的保额展示（与报告其它章同口径：只显示数字，单位由章节 header 承担） */
function _wan(v) {
  const n = Number(v)
  if (!n || isNaN(n)) return ''
  return String(_round1(n / 10000))
}

/**
 * 构建甘特图 block 数据
 *
 * @param {array} policies - 保单（调用方已过滤为 active）
 * @param {array} members - 成员（取年龄用于"至N岁"推算；取顺序用于纵轴排序）
 * @returns {object} customBlock 数据：{ rows, ticks, startYear, endYear, notes }
 *   rows: [{ rowKey, name, product, cat, sumAssured, startY, endY|null, startPct, widthPct, lifetime, oneYear }]
 *   ticks: [{ y, pct }]
 */
function buildGantt(policies, members) {
  const list = Array.isArray(policies) ? policies : []
  const ageByName = {}
  const orderByName = {}
  ;(members || []).forEach(function(m, i) {
    if (!m || !m.name) return
    ageByName[m.name] = m.age || 0
    if (orderByName[m.name] === undefined) orderByName[m.name] = i
  })

  const thisYear = new Date().getFullYear()

  // 2026-10-18 用户提议「按年龄做时间轴」的落地方式：
  // 全家人以同样速度变老 ⇒ 年龄轴与年份轴在几何上等价，只需给刻度补一行年龄。
  // 但一根年龄轴必须指定基准人（3 位成员年龄不同），这里取"户主"（role=本人）；
  // 没有本人时退化为档案里第一个填了年龄的成员；都没有年龄 → 不显示年龄行（不猜）。
  let refName = ''
  let refAge = 0
  const refMember = (members || []).filter(function(m) { return m && (m.age || 0) > 0 })[0]
  const ownerMember = (members || []).filter(function(m) { return m && m.role === '本人' && (m.age || 0) > 0 })[0]
  const ref = ownerMember || refMember
  if (ref) { refName = ref.name || ''; refAge = ref.age || 0 }

  const rows = []
  let missStart = 0   // 缺生效日期（无法定位起点）
  let missTerm = 0    // 有生效日期但无保障期间信息（无法定位终点）→ 均不入图，只在 notes 里标出

  // 2026-10-21：附加险不单独画条 —— 它与主险共用同一份合同，画两条几乎重合的线只会让人
  // 以为买了两份独立保障。关系由 rider-link 推断（同保单号 + 产品名以「附加」开头）。
  const linked = linkRiders(list)
  const riderCountByParent = {}
  linked.items.forEach(function(it) {
    if (it.isRider && it.parentKey) riderCountByParent[it.parentKey] = (riderCountByParent[it.parentKey] || 0) + 1
  })
  const mainItems = linked.items.filter(function(it) { return !(it.isRider && it.parentKey) })

  for (let i = 0; i < mainItems.length; i++) {
    const p = mainItems[i] || {}
    const eff = String(p.contract_effective_date || p.effective_date || '')
    const d = eff ? new Date(eff) : null
    const startY = d ? d.getFullYear() : NaN
    if (!eff || isNaN(startY)) { missStart++; continue }

    const name = p.insured_name || '未指定被保人'
    const age = ageByName[name] || 0
    const lifetime = _isLifetimePolicy(p)
    const endY = lifetime ? null : coverTermYear(p, startY, age)
    if (!lifetime && !endY) { missTerm++; continue }

    // 缴费期满年（2026-10-13 稿子建议：甘特图要区分"缴费期/保障期"两种语义，
    // 否则一条实色带看不出"钱交完了但保障还在"）：
    //   - 趸交（premium_term=1 / 0 哨兵）→ 缴费期只有 1 年 → 标 singlePay，不画斜纹段
    //   - 无缴费期信息 → payPct=null，不画（不猜"缴到多久"，红线 3）
    const singlePay = isSinglePayTerm(p.premium_term)
    const payEndY = singlePay ? null : payTermYear(p, startY, age)

    const product = p.product_name || '未命名保单'
    rows.push({
      rowKey: name + '|' + product + '|' + startY,
      name: name,
      product: product,
      cat: p.insurance_category || '',
      sumAssured: _wan(p.sum_assured),
      startY: startY,
      endY: endY,
      lifetime: lifetime,
      oneYear: isOneYearPolicy(p),
      singlePay: singlePay,
      // 2026-10-21：失效/退保/理赔终止 → 灰条 + 空心终点（"这张已经不能用了"要看得见）
      inactive: !!(p.status && p.status !== 'active'),
      // 2026-10-21：该主险下已并入的附加险项数（渲染时行尾标"含附加 N 项"）
      riderCount: riderCountByParent[p._linkKey] || 0,
      payEndY: payEndY,
      // 到期时被保人年龄（回答稿子那句"60 岁时还剩什么"）：当前年龄 + 距到期年数
      // 终身险无到期年 → null；年龄未知（未匹配到成员/未填出生日期）→ null（不猜）
      endAge: (!lifetime && endY && age > 0) ? (age + (endY - thisYear)) : null,
      // 缴费期满时的被保人年龄需要 age，但要在算出轴范围之后才能定位置 → 先把 age 带下去（内部字段，最后删除）
      _age: age,
      _order: orderByName[name] === undefined ? 999 : orderByName[name]
    })
  }

  // 纵轴排序：按成员在档案里的顺序（同一人的保单相邻，便于回答"这个人有什么"），再按生效年、产品名
  rows.sort(function(a, b) {
    return a._order - b._order || a.startY - b.startY || String(a.product).localeCompare(String(b.product))
  })

  // 2026-10-17：分组标记。排序已保证同一成员的保单相邻，但渲染时每行都重复成员名 ——
  // 真机截图里"李阳勇"连出 6 行，把产品名挤到第二行且只能 tiny 字号。
  // 现在只在成员第一行渲染成员名（组头），其余行只显示产品。
  let prevName = null
  rows.forEach(function(r) {
    r.firstOfMember = r.name !== prevName
    prevName = r.name
  })

  if (!rows.length) {
    const notes0 = []
    if (missStart) notes0.push(missStart + ' 张保单缺少生效日期，未在时间轴上显示')
    if (missTerm) notes0.push(missTerm + ' 张保单未填写保障期间，未在时间轴上显示')
    return { rows: [], ticks: [], startYear: 0, endYear: 0, notes: notes0 }
  }

  // 横轴范围：最早生效年 → 最晚到期年（终身保单把右端扩到"当前年 + 1"以外不额外拉长，
  // 它直接画到右端并在行尾标"终身"，避免为一张终身险把整条轴拉到 2130 年）
  let startYear = rows[0].startY
  let endYear = thisYear + 1
  rows.forEach(function(r) {
    if (r.startY < startYear) startYear = r.startY
    if (r.endY && r.endY > endYear) endYear = r.endY
    if (r.startY > endYear) endYear = r.startY // 生效年晚于当前年的保单（如未来生效）也要留出位置
  })
  if (endYear <= startYear) endYear = startYear + 1
  const span = endYear - startYear

  rows.forEach(function(r) {
    r.startPct = _round1((r.startY - startYear) / span * 100)
    if (r.lifetime) {
      r.widthPct = _round1(100 - r.startPct)          // 终身：一直画到右端
    } else {
      const w = (r.endY - r.startY) / span * 100
      r.widthPct = _round1(Math.max(MIN_WIDTH_PCT, Math.min(w, 100 - r.startPct)))
    }
    // 缴费期满标记（2026-10-18 改）：原实现用"条内斜纹段"表示缴费期，但条高只有 20rpx，
    // 斜纹在真机上几乎不可见（用户提议"只做保障期间"就是这个观感的直接后果）。
    // 现在改为**条内一根缴费期满竖线**（按时间轴百分比定位，不再需要相对条宽的换算）：
    // 语义不变（钱交完了、保障还在），视觉噪声≈0；具体年份由时间线章与 note 承担。
    // 只在"缴费期满早于保障期满"时画 —— 缴费与保障同时结束（多数定期险）时画在条尾是噪音。
    const barEndY = r.lifetime ? endYear : r.endY
    if (r.payEndY && r.payEndY > r.startY && r.payEndY < barEndY) {
      r.payEndPct = _round1((r.payEndY - startYear) / span * 100)
      r.payEndAge = (r._age > 0) ? (r._age + (r.payEndY - thisYear)) : null
    } else {
      r.payEndPct = null
      r.payEndAge = null
    }
    delete r._order
    delete r._age
  })

  // 人生阶段带（2026-10-24，方案第四部分）：以**基准人**年龄划分阶段，画在轴下方一行。
  // 只做一行色带而不是给每条保单衬底色：后者要跨多个绝对定位容器，漏排一次就会错位，
  // 且 13 条保单叠 5 段底色会盖掉条本身的颜色。方案原文也要求"标注推算、输入缺失不画"。
  var stages = []
  if (refAge > 0) {
    var STAGES = [
      { to: 6, label: '学龄前' }, { to: 18, label: '学龄期' }, { to: 35, label: '立业期' },
      { to: 60, label: '责任期' }, { to: 200, label: '退休期' }
    ]
    // 第 y 年时基准人的年龄
    var ageAtYear = function(y) { return refAge + (y - thisYear) }
    var cursor = startYear
    STAGES.forEach(function(st) {
      // 找到该阶段在轴上的起止年（年龄 < to 的最后一年）
      var fromY = cursor
      var toY = startYear
      for (var y = cursor; y <= endYear; y++) {
        if (ageAtYear(y) < st.to) toY = y
      }
      if (toY < fromY) { cursor = fromY; return }
      var left = (fromY - startYear) / span * 100
      var width = (toY - fromY + 1) / span * 100
      if (width > 0) stages.push({ label: st.label, left: _round1(left), width: _round1(Math.min(width, 100 - left)) })
      cursor = toY + 1
      if (cursor > endYear) return
    })
  }

  // 刻度：首尾必在，中间按 span 均分（步长向上取整，避免出现半年的刻度）
  // 2026-10-18：每个刻度额外带基准人（户主）在该年的年龄 —— 客户读"保障到 72 岁"
  // 比读"保障到 2054 年"更直观；几何不变，只多一行标签。
  const step = Math.max(1, Math.ceil(span / (MAX_TICKS - 1)))
  const ageAt = function(y) { return refAge > 0 ? refAge + (y - thisYear) : null }
  const ticks = []
  for (let y = startYear; y <= endYear; y += step) {
    ticks.push({ y: y, pct: _round1((y - startYear) / span * 100), age: ageAt(y) })
  }
  if (ticks[ticks.length - 1].y !== endYear) ticks.push({ y: endYear, pct: 100, age: ageAt(endYear) })

  const notes = []
  if (missStart) notes.push(missStart + ' 张保单缺少生效日期，未在时间轴上显示')
  if (missTerm) notes.push(missTerm + ' 张保单未填写保障期间，未在时间轴上显示')
  // 缴费期满竖线的图例（替代原斜纹段；斜纹在 20rpx 条高下不可读，已移除）
  if (rows.some(function(r) { return r.payEndPct !== null })) notes.push('条内竖线 = 缴费期满，其后只保留保障（不用再交钱）')
  if (rows.some(function(r) { return r.inactive })) notes.push('灰条 = 已失效 / 退保 / 理赔终止，不计入汇总与缺口')
  if (rows.some(function(r) { return r.oneYear })) notes.push('一年期短险每年需续保，条形表示当前保单年度')
  if (rows.some(function(r) { return r.lifetime })) notes.push('"终身"保单无固定到期日，条形画至右端')

  return {
    rows: rows,
    ticks: ticks,
    startYear: startYear,
    endYear: endYear,
    // 年龄行的基准人（户主）：刻度第二行"62岁"是**谁的** 62 岁，必须标出来，否则读者会以为是自己的
    refName: refName,
    refAge: refAge,
    // 人生阶段带（按基准人年龄推算；refAge=0 时为空数组 → 不画、不注释）
    stages: stages,
    // "今天"竖线位置（稿子：让客户看到当前处在哪）：当前年在轴上；保单尚未生效（未来生效日）
    // 时落在轴左侧 → 给 null，不画（画在 0% 会被误读成"已生效"）
    nowPct: (thisYear >= startYear && thisYear <= endYear) ? _round1((thisYear - startYear) / span * 100) : null,
    nowYear: thisYear,
    notes: notes
  }
}

module.exports = { buildGantt }
