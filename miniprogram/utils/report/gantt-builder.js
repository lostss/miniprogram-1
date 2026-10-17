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
  const rows = []
  let missStart = 0   // 缺生效日期（无法定位起点）
  let missTerm = 0    // 有生效日期但无保障期间信息（无法定位终点）→ 均不入图，只在 notes 里标出

  for (let i = 0; i < list.length; i++) {
    const p = list[i] || {}
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
      payEndY: payEndY,
      // 到期时被保人年龄（回答稿子那句"60 岁时还剩什么"）：当前年龄 + 距到期年数
      // 终身险无到期年 → null；年龄未知（未匹配到成员/未填出生日期）→ null（不猜）
      endAge: (!lifetime && endY && age > 0) ? (age + (endY - thisYear)) : null,
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
    // 缴费段长度 = **占本条自身宽度的百分比**（不是占时间轴的）—— 渲染层把它放在条内做绝对定位，
    // 用轴百分比会算错（条宽本身已小于轴宽）。语义：条 = 保障期，条内斜纹段 = 缴费期，
    // 于是"钱交完了但保障还在"一眼可见（2026-10-13 稿子对甘特图的核心要求）。
    // 分母取本条的实际右端：终身条右端是轴末（endYear），定期条右端是 endY。
    const barEndY = r.lifetime ? endYear : r.endY
    if (r.payEndY && r.payEndY > r.startY && barEndY > r.startY) {
      const ratio = (r.payEndY - r.startY) / (barEndY - r.startY) * 100
      r.payRatio = _round1(Math.max(0, Math.min(ratio, 100)))
    } else {
      r.payRatio = null
    }
    delete r._order
  })

  // 刻度：首尾必在，中间按 span 均分（步长向上取整，避免出现半年的刻度）
  const step = Math.max(1, Math.ceil(span / (MAX_TICKS - 1)))
  const ticks = []
  for (let y = startYear; y <= endYear; y += step) {
    ticks.push({ y: y, pct: _round1((y - startYear) / span * 100) })
  }
  if (ticks[ticks.length - 1].y !== endYear) ticks.push({ y: endYear, pct: 100 })

  const notes = []
  if (missStart) notes.push(missStart + ' 张保单缺少生效日期，未在时间轴上显示')
  if (missTerm) notes.push(missTerm + ' 张保单未填写保障期间，未在时间轴上显示')
  if (rows.some(function(r) { return r.oneYear })) notes.push('一年期短险每年需续保，条形表示当前保单年度')
  if (rows.some(function(r) { return r.lifetime })) notes.push('"终身"保单无固定到期日，条形画至右端')

  return {
    rows: rows,
    ticks: ticks,
    startYear: startYear,
    endYear: endYear,
    // "今天"竖线位置（稿子：让客户看到当前处在哪）：当前年在轴上；保单尚未生效（未来生效日）
    // 时落在轴左侧 → 给 null，不画（画在 0% 会被误读成"已生效"）
    nowPct: (thisYear >= startYear && thisYear <= endYear) ? _round1((thisYear - startYear) / span * 100) : null,
    nowYear: thisYear,
    notes: notes
  }
}

module.exports = { buildGantt }
