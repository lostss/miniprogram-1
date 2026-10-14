/**
 * premium-trend.js — 保费现金流趋势（跨树契约）
 *
 * 服务 2026-10-14 用户稿子两处：
 *   ① 「关键节点：2026-12 💰 张三 · 平安福 第7期缴费 ¥12,000」→ `upcoming`（下一期缴费 + 第几期）
 *   ② 「保费按年度趋势：缴费期满后保费下降曲线，释放的现金流可再配置 ⭐」→ `drops` / `years`
 *
 * 页面（缴费月历章）与 PDF（缴费月历节）**必须同源** —— 所以放在 `_shared/` 走 sync-shared 契约，
 * 而不是各写一份（这正是 reportPdf 与前端在"期限口径"上分裂过的地方）。
 *
 * ## 口径与边界（都是既有决策，别在这里放宽）
 * - 保费一律用 `annual_premium`（年缴保费，已年化），本模块**不做**月缴/季缴的期间换算
 *   （字段层没有可靠的频率与期数明细；按年化值算总盘子是既有口径）。
 * - 缴费区间来自 `policy-terms.payTermYear`（文本优先、数字兜底、趸交哨兵）。
 * - **缺生效日期 / 缺缴费期**的保单**不参与**计算，只计入 `notes`（红线 3：不确定就标出来；
 *   不许默认"缴到终身"或"只缴一年"，那两种猜法都会把曲线画错）。
 * - 趸交（`premium_term=1`）按"只计首年"处理（一次性支出，此后不再出现在曲线里）。
 * - 只统计 `status === 'active'`（与报告其它章同口径）。
 */

const { payTermYear } = require('./policy-terms')
const { isSinglePayTerm, isOneYearPolicy } = require('./policy-status')

// 曲线最长推演年数：够覆盖常见长期险缴费期，又不至于把 payload / 渲染撑爆
const MAX_YEARS = 30
// 只报最近两期缴费（当期 + 下一期）：再多就与"缴费月历"章重复了
const MAX_UPCOMING = 2

function _wan(yuan) { return Math.round((yuan / 10000) * 100) / 100 }

/**
 * @param {array} policies — 保单（内部按 status==='active' 过滤）
 * @param {array} members  — 成员（取 age 供"至N岁"推算）
 * @param {object} [opts]  — { now } 便于测试注入时间
 * @returns {{ thisYear, currentW, upcoming, drops, years, notes }}
 */
function buildPremiumTrend(policies, members, opts) {
  const o = opts || {}
  const now = o.now ? new Date(o.now) : new Date()
  const thisYear = now.getFullYear()
  const thisMonth = now.getMonth() + 1

  const ageByName = {}
  ;(members || []).forEach(function(m) { if (m && m.name) ageByName[m.name] = m.age || 0 })

  const items = []
  let missStart = 0
  let missTerm = 0
  let singleCount = 0
  let oneYearCount = 0
  let noPremium = 0

  ;(policies || []).forEach(function(p) {
    if (!p || p.status !== 'active') return
    const eff = p.contract_effective_date || p.effective_date || ''
    const d = eff ? new Date(eff) : null
    const startY = d && !isNaN(d.getTime()) ? d.getFullYear() : NaN
    if (!eff || isNaN(startY)) { missStart++; return }
    const premium = Number(p.annual_premium) || 0
    const single = isSinglePayTerm(p.premium_term)
    // 一年期短险（线上最常见的医疗险/意外险形态）：**一般没有 payment_period**（每年续保即每年缴费），
    // 若按"缺缴费期"排除，会把最需要提醒"下一期缴费"的一整类保单漏掉（首版真漏了：
    // 实测真实家庭 13 份保单里 6 份是一年期）。
    // 口径：曲线**只计入当前年度**（不假设未来继续续保 —— 续保是投保人每年的决定，
    // 替客户假设"会一直续"会把保费曲线画虚，与"短险不虚高保障感"的既有口径相反）；
    // 但"下一期缴费"照常提醒（当年那一期确实要交）。
    const oneYear = isOneYearPolicy(p)
    const payEndY = single ? startY : (oneYear ? thisYear : payTermYear(p, startY, ageByName[p.insured_name] || 0))
    if (!single && !oneYear && !payEndY) { missTerm++; return }
    if (premium <= 0) { noPremium++; return }
    if (single) singleCount++
    if (oneYear && !single) oneYearCount++
    items.push({
      product: p.product_name || '未命名保单',
      name: p.insured_name || '',
      startY: startY,
      payEndY: payEndY || startY,
      single: single,
      oneYear: oneYear && !single,
      premium: premium,
      payMonth: d.getMonth() + 1
    })
  })

  // 提示统一在这里生成（**包括** items 为空时）：早退分支若只报 missStart/missTerm，
  // 会漏掉"未填年缴保费"这类说明 —— 测试抓到过（无保费但缴费期完整的家庭只剩空白）。
  function buildNotes() {
    const out = []
    if (missStart) out.push(missStart + ' 张保单缺少生效日期，未计入保费趋势')
    if (missTerm) out.push(missTerm + ' 张保单未填写缴费期，未计入保费趋势')
    if (noPremium) out.push(noPremium + ' 张保单未填写年缴保费，未计入保费趋势')
    if (singleCount) out.push(singleCount + ' 张趸交保单按一次性支出计入首年，不进入后续年度')
    if (oneYearCount) out.push(oneYearCount + ' 张一年期保单每年续保，年度曲线仅计入当前年度')
    return out
  }

  if (!items.length) {
    return { thisYear: thisYear, currentW: 0, upcoming: [], drops: [], years: [], notes: buildNotes() }
  }

  // ⚠️ 年度曲线与台阶**只用长期险**（排除一年期与趸交）：
  //   一年期保单在我的口径里"只计当前年度"，若计入曲线，次年必然少掉它 → 会渲染出一级假台阶
  //   （实测文案变成"2027 年起降至 X 万（百万医疗缴费期满）"，而它其实是每年续保，不是期满）。
  //   趸交同理（首年之后本就没有它）。它们的当年保费仍计入 `currentW`（与同章"年总保费"对得上）。
  const longItems = items.filter(function(it) { return !it.oneYear && !it.single })

  // 年度保费：某保单在 y 年仍缴费 ⇔ startY <= y <= payEndY
  function premiumOfYear(y, list) {
    let sum = 0
    for (let i = 0; i < list.length; i++) {
      const it = list[i]
      if (y >= it.startY && y <= it.payEndY) sum += it.premium
    }
    return sum
  }

  const lastPayY = longItems.reduce(function(mx, it) { return Math.max(mx, it.payEndY) }, thisYear)
  // +1 年：最后一张保单缴满的**次年**才是"保费降到 0"的下降点，不进循环就会漏掉最后一个台阶
  const endY = Math.min(thisYear + MAX_YEARS, Math.max(lastPayY + 1, thisYear + 1))
  const years = []
  for (let y = thisYear; y <= endY; y++) years.push({ y: y, w: _wan(premiumOfYear(y, longItems)) })

  // 下降点：缴费期满导致年保费下降的年份 + 当年"缴满"的保单
  const drops = []
  for (let i = 1; i < years.length; i++) {
    const prev = premiumOfYear(years[i].y - 1, longItems)
    const cur = premiumOfYear(years[i].y, longItems)
    if (cur < prev) {
      const ended = longItems.filter(function(it) { return it.payEndY === years[i].y - 1 })
      drops.push({
        y: years[i].y,
        fromW: _wan(prev),
        toW: _wan(cur),
        reducedW: _wan(prev - cur),
        products: ended.map(function(it) { return it.product + (it.name ? '（' + it.name + '）' : '') })
      })
    }
  }

  // 下一期缴费：每张保单的缴费月 = 生效月；取最近的两个月份分组（含"第几期"）。
  // ⚠️ 两类必须排除，否则会报出根本不存在的缴费：
  //   - 趸交（single）：保费在投保时一次性交清，之后没有"期"可言（首版真犯了这个错）
  //   - 已缴满（payEndY < thisYear）：历史保单不再有未来缴费
  const byDate = {}
  items.forEach(function(it) {
    if (it.single) return
    if (it.payEndY < thisYear) return
    const y = it.payMonth >= thisMonth ? thisYear : thisYear + 1
    // 一年期保单每年续保 → 下一期可以跨到明年（its payEndY 只代表"曲线口径"的当年）
    if (!it.oneYear && y > it.payEndY) return // 下一期已超出缴费期（今年缴完了）
    const key = y + '-' + ('0' + it.payMonth).slice(-2)
    if (!byDate[key]) byDate[key] = { y: y, m: it.payMonth, premium: 0, list: [] }
    byDate[key].premium += it.premium
    byDate[key].list.push({
      product: it.product,
      name: it.name,
      premium: it.premium,
      // 第几期：按保单年度推算（"第7期缴费"这类说法要能对得上保单）
      periodNo: y - it.startY + 1
    })
  })
  const upcoming = Object.keys(byDate).sort().slice(0, MAX_UPCOMING).map(function(k) {
    const g = byDate[k]
    return { y: g.y, m: g.m, amountW: _wan(g.premium), count: g.list.length, list: g.list }
  })

  return {
    thisYear: thisYear,
    // 当前年度总保费：**全部**保单（含一年期/趸交当年），与同章"年总保费"行对得上
    currentW: _wan(premiumOfYear(thisYear, items)),
    upcoming: upcoming,
    // 台阶与曲线：长期险口径（见上方 longItems 注释）
    drops: drops,
    years: years,
    notes: buildNotes()
  }
}

module.exports = { buildPremiumTrend, MAX_YEARS }
