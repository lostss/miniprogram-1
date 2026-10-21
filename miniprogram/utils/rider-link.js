/**
 * 附加险归属（2026-10-21）
 *
 * 背景：本项目**按产品入库**——同保单号的主险与附加险是两条独立文档（见 dataWrite/policy-write.js
 * 的去重键 `policy_number + product_name`，那条注释写得很清楚："同保单号不同产品是独立文档"）。
 * 于是报告侧出现三个与产品口径不符的现象：
 *   ① 份数把附加险各算一份（"8 份"里有 3 份其实是附加险）
 *   ② 明细里附加险平铺，看不出挂在哪张主险下
 *   ③ 甘特图为附加险单独画条，同一个保障期出现两条几乎重合的线
 *
 * 本模块只做**一层关系推断**，不改数据模型、不落库：
 *   同一 `policy_number`（非空）→ 同一张保单组；
 *   组内产品名以「附加」开头的视为附加险，挂到组内**非附加**且保额最大的一条（并列取生效日更早的）。
 *
 * 两条"不猜"的红线（宁可显示两条独立，也不给错关系）：
 *   - **没有保单号就不合并**。按"同被保人+同公司+同生效日"猜，一旦同一天买了两张主险，
 *     会把 A 的附加险挂到 B 上 —— 这比不合并更糟。
 *   - **组内全是「附加」开头时不挑主险**：没有可挂靠的对象，保持独立。
 *   这两种情况都会标记出来（`riderUnlinked`），由报告侧提示"缺保单号，主险与附加险未能关联"。
 *
 * 输出（不修改入参）：
 *   items      —— 逐条带上 isRider / parentKey / riderCount
 *   mainCount  —— 主险数（= 报告里的"份数（按主险计）"）
 *   riderCount —— 已合并的附加险数（"含 N 项附加险"）
 *   unlinkedRiderCount —— 看起来是附加险但没能关联的数量（进待完善）
 */

// 产品名以「附加」开头（允许"附 加"/全角空格）；保险条款里也有"附加险"字样，但产品名统一是前缀
const RIDER_RE = /^附\s*加/

function _s(v) { return String(v == null ? '' : v).trim() }

// 单条文档的稳定标识：优先数据库 id，其次保单号+产品名（与入库去重键同构，便于人工核对）
function _keyOf(p) {
  if (_s(p && (p.id || p._id))) return _s(p.id || p._id)
  return _s(p && p.policy_number) + '|' + _s(p && p.product_name)
}

function linkRiders(policies) {
  const list = Array.isArray(policies) ? policies : []
  // 先复制一份带标识的视图，避免污染调用方的对象（这些对象可能直接进 setData）
  const items = list.map(function(p) {
    return Object.assign({}, p, {
      _linkKey: _keyOf(p),
      isRider: RIDER_RE.test(_s(p && p.product_name)),
      parentKey: '',
      riderCount: 0,
      riderUnlinked: false
    })
  })

  // 按保单号分组（只分非空的；空保单号的条件在下面单独处理）
  const groups = {}
  items.forEach(function(it) {
    const no = _s(it.policy_number)
    if (!no) return
    if (!groups[no]) groups[no] = []
    groups[no].push(it)
  })

  Object.keys(groups).forEach(function(no) {
    const g = groups[no]
    if (g.length < 2) return // 单条（单独投保的附加险也算独立一份）
    const riders = g.filter(function(x) { return x.isRider })
    const mains = g.filter(function(x) { return !x.isRider })
    if (!riders.length || !mains.length) {
      // 全是附加险 → 没有挂靠对象；标记出来但不猜
      riders.forEach(function(r) { r.riderUnlinked = true })
      return
    }
    // 主险选择：保额最大者（附加险通常挂在"主合同"上，金额最大的那条最可能是主险）；
    // 并列时取生效日更早的（更可能是原始合同）
    const parent = mains.slice().sort(function(a, b) {
      const d = (Number(b.sum_assured) || 0) - (Number(a.sum_assured) || 0)
      if (d !== 0) return d
      return _s(a.effective_date).localeCompare(_s(b.effective_date))
    })[0]
    riders.forEach(function(r) {
      r.isRider = true
      r.parentKey = parent._linkKey
      parent.riderCount += 1
    })
  })

  // 没有保单号、但产品名像附加险 → 不合并，标记（报告侧提示补保单号）
  items.forEach(function(it) {
    if (it.isRider && !it.parentKey && !_s(it.policy_number)) it.riderUnlinked = true
  })

  // 主险数 = 「独立成一份的文档数」：没能关联上的附加险**也算一份**
  //（明细里它就是独立一条，若不计入，用户会发现"份数 8 但明细 9 条"）。
  const mainCount = items.filter(function(x) { return !(x.isRider && x.parentKey) }).length
  const riderCount = items.filter(function(x) { return x.isRider && x.parentKey }).length
  const unlinkedRiderCount = items.filter(function(x) { return x.isRider && !x.parentKey }).length
  return { items: items, mainCount: mainCount, riderCount: riderCount, unlinkedRiderCount: unlinkedRiderCount }
}

module.exports = { linkRiders, RIDER_RE }
