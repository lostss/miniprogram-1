/**
 * risk-alerts-builder.js — 风险预警 TOP-N（报告结构 v2.0 ① 家庭总检结论）
 *
 * 「总检结论」里的红黄绿灯列表：按**急重缓轻**排序（不按险种、不按成员），每条带可追溯依据。
 * 纯计算，不依赖 AI、不落库，可独立单测。
 *
 * ## 三条设计约束（都是既决口径，别在这里放宽）
 *
 * 1. **不引入主观序**：排序只有四个确定性键（见 `_rank`）—— 等级 → gapPriority → 敞口金额降序 →
 *    成员档案顺序。没有"我觉得这个更严重"这类不可解释的权重；也没有"严重不足"这类需要新阈值
 *    才能成立的说法（阈值只有 `_shared/thresholds` 那份）。
 * 2. **每条都能给出依据**（`basis`）：依据文本来自 `gap-core.basisText` 或契约里的判据说明。
 *    这是"错误不对称"（漏报可容忍、误报趋近于零）的落地方式 —— 给不出依据的结论不出现。
 * 3. **客户版（shared）不显示基于不可见数据得出的结论**：保费收入比只 owner 可见
 *    （家庭财务章对客户隐藏 → 客户无从核对基数；"引用不可见数据下结论" 2026-09-12 已否决）。
 *    其余条目客户版保留，但措辞走既有中性口径（"保障待完善"，不写"缺少"）。
 *
 * ⛔ 明确不做：险种间的"重要性"排序、保额"严重不足"分级、医疗险重叠（无字段）、
 *    带形容词的判断（"偏低/不足"这类留给使用者，本模块只给事实与数字）。
 */
const { listExpiredButActive } = require('../policy-status')
const { premiumRatioVerdict } = require('../thresholds')

/**
 * 客户版（shared）的依据文案 —— **必须中性、不含公式与内部口径**。
 *
 * 为什么需要这一层：owner 的依据会带上"寿险需求=总负债150万+5×年收入30万=300万"这类公式，
 * 而客户版**刻意隐藏家庭财务章与占收入比**（客户无从核对基数，2026-09-12 已否决"引用不可见数据下结论"）。
 * 若把 owner 的依据原样下发，等于把这些数据从"依据"这条侧路又泄露回去 —— 那比不显示更糟
 * （客户看到一个无法核对的数字，且是自家负债/收入的推算式）。
 * 所以客户版依据只描述**判据类型**，不出现任何数值、公式、字段名或模块名。
 */
const SHARED_BASIS = {
  policy_expired: '按保单载明的保障到期日与当前状态比对',
  legal_beneficiary: '按保单填写的受益人比对',
  gap: '按家庭成员角色所需险种与参考保额逐项比对',
  gap_blocked: '所需信息未填写，暂无法完成比对',
  ok: '按家庭成员角色所需险种与参考保额逐项比对'
}
function _basisFor(shared, kind, ownerBasis) {
  if (!shared) return ownerBasis
  return SHARED_BASIS[kind] || ''
}

// 等级序：红（事实型硬伤）→ 黄（关注 / 待确认）→ 绿（达标，建立信任）
const LEVEL_RANK = { red: 0, yellow: 1, green: 2 }
const LEVEL_LABEL = { red: '高危', yellow: '关注', green: '正常' }
// 与 gap-core.gapPriority 的取值一一对应；此处只用于排序，不产生新的优先级
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 }

function _num(v) { return Number(v) || 0 }
function _wan(v) { return Math.round(_num(v) * 10) / 10 }
function _exposure(item) { return _num(item.exposure) }

/**
 * 排序（确定性、可解释）：等级 → 优先级 → 敞口降序 → 成员档案顺序 → 入列顺序
 * 成员档案顺序兜底保证"同一批数据每次渲染顺序一致"（不会因对象键序变化而抖动）。
 */
function _rank(a, b, memberIndex) {
  const pa = PRIORITY_RANK[a.priority] === undefined ? 3 : PRIORITY_RANK[a.priority]
  const pb = PRIORITY_RANK[b.priority] === undefined ? 3 : PRIORITY_RANK[b.priority]
  const ma = memberIndex[a.member] === undefined ? 999 : memberIndex[a.member]
  const mb = memberIndex[b.member] === undefined ? 999 : memberIndex[b.member]
  return (LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
    || (pa - pb)
    || (_exposure(b) - _exposure(a))
    || (ma - mb)
    || (a._seq - b._seq)
}

/**
 * 构建风险预警列表
 *
 * @param {object} input
 * @param {array}  input.gaps          — buildGaps 结果（含 gap/reliability/priority/role/basis）
 * @param {array}  input.members       — 成员（取档案顺序用于稳定排序）
 * @param {array}  input.policies      — 保单（判"载明期限已过"与"受益人为法定"）
 * @param {number} input.premiumRatio  — 年保费占家庭年收入（%）；<=0 视为未填写（不判定）
 * @param {string} [input.view]        — 'shared' 为客户版
 * @param {number} [input.limit=3]     — 红/黄条目的展示上限（TOP-N），超出计入 more
 * @returns {{ items, counts, more, total }}  items[].level 为 red/yellow/green
 */
function buildRiskAlerts(input) {
  const o = input || {}
  const gaps = o.gaps || []
  const members = o.members || []
  const policies = o.policies || []
  const shared = o.view === 'shared'
  const limit = o.limit === undefined ? 3 : o.limit

  const memberIndex = {}
  members.forEach(function(m, i) { if (m && m.name && memberIndex[m.name] === undefined) memberIndex[m.name] = i })

  const items = []
  let seq = 0
  // levelLabel 由构建器统一给出（不留给渲染侧映射：红黄绿的字面口径应只有一处）
  function push(item) { items.push(Object.assign({ _seq: seq++, levelLabel: LEVEL_LABEL[item.level] || '' }, item)) }

  // ---------- 事实型硬伤：依据是保单字段本身，无需推断 ----------
  listExpiredButActive(policies).forEach(function(e) {
    const p = e.policy || {}
    push({
      key: 'expired:' + (p.id || p._id || e.product_name),
      level: 'red',
      kind: 'policy_expired',
      title: '保单载明期限已过',
      detail: e.product_name + (e.insured_name ? '（' + e.insured_name + '）' : '') + ' 载明至 ' + e.expiryText +
        (e.isOneYear ? '，一年期产品一般默认续保，请确认是否已续保' : '，状态仍为有效，请核实保障是否仍有效'),
      member: e.insured_name || '',
      exposure: p.sum_assured ? _num(p.sum_assured) / 10000 : 0,
      priority: 'high',
      basis: _basisFor(shared, 'policy_expired', '载明到期日早于今天、状态为有效（判据与 policy-status.calcStatus 同源）')
    })
  })
  policies.forEach(function(p) {
    if (!p || String(p.beneficiary_name || '').trim() !== '法定') return
    push({
      key: 'legal_beneficiary:' + (p.id || p._id || p.product_name),
      level: 'red',
      kind: 'legal_beneficiary',
      title: '受益人为「法定」',
      detail: (p.product_name || '保单') + (p.insured_name ? '（' + p.insured_name + '）' : '') + ' 的受益人填写为「法定」',
      member: p.insured_name || '',
      exposure: 0,
      priority: 'high',
      basis: _basisFor(shared, 'legal_beneficiary', '保单字段 beneficiary_name = 法定')
    })
  })

  // ---------- 缺口：依据为阈值口径，金额可追溯 ----------
  gaps.forEach(function(g) {
    const isBlocked = g.reliability === 'blocked'
    const isPillar = /本人|经济支柱/.test(String(g.role || ''))
    const level = isBlocked ? 'yellow' : (g.priority === 'high' ? 'red' : 'yellow')
    let title
    if (isBlocked) {
      title = shared ? '部分保障待确认' : (g.category + '缺口无法测算')
    } else if (isPillar && g.category === '寿险' && _num(g.existing) === 0) {
      title = shared ? '保障待完善' : '经济支柱无寿险'
    } else {
      title = shared ? '保障待完善' : (g.category + '低于参考保额')
    }
    push({
      key: 'gap:' + (g.id || (g.member + '_' + g.category)),
      level: level,
      kind: isBlocked ? 'gap_blocked' : 'gap',
      title: title,
      detail: shared
        ? ('涉及 ' + g.member + ' 的' + g.category + (isBlocked ? '（待确认）' : ''))
        : (g.member + '：' + (isBlocked
          ? (g.category + ' 因年收入等信息缺失暂无法测算')
          : (g.category + ' 缺口 ' + _wan(g.gap) + ' 万（建议 ' + _wan(g.reference) + ' 万 − 已有 ' + _wan(g.existing) + ' 万）'))),
      member: g.member,
      exposure: isBlocked ? 0 : _num(g.gap),
      // 待确认与高危同级靠前：不确定本身就需要处理，不能因为"算不出"就沉到列表底部
      priority: isBlocked ? 'high' : g.priority,
      basis: _basisFor(shared, isBlocked ? 'gap_blocked' : 'gap', g.basis || '')
    })
  })

  // ---------- 保费收入比：owner only（见文件头约束 3）----------
  if (!shared) {
    const v = premiumRatioVerdict(o.premiumRatio)
    if (v.code === 'watch' || v.code === 'heavy') {
      push({
        key: 'premium_ratio',
        level: 'yellow',
        kind: 'premium_ratio',
        title: '保费占收入比偏高',
        detail: '年缴保费占家庭年收入 ' + _wan(o.premiumRatio) + '%。' + v.text,
        member: '',
        exposure: 0,
        priority: v.code === 'heavy' ? 'medium' : 'low',
        basis: '参考区间取自 thresholds.PREMIUM_RATIO（行业经验值，非监管标准）'
      })
    }
  }

  // ---------- 达标项（正常）：v2.0 ① 明确要求"达标项同样展示，不只制造焦虑" ----------
  const okMembers = members.filter(function(m) {
    if (!m || !m.name) return false
    return !gaps.some(function(g) { return g.member === m.name && (_num(g.gap) > 0 || g.reliability === 'blocked') })
  })
  if (okMembers.length) {
    const names = okMembers.slice(0, 3).map(function(m) { return m.name }).join('、')
    push({
      key: 'ok_members',
      level: 'green',
      kind: 'ok',
      title: '必需险种已达参考保额',
      detail: okMembers.length + ' 位成员（' + names + (okMembers.length > 3 ? ' 等' : '') + '）无确切缺口',
      member: '',
      exposure: 0,
      priority: 'low',
      basis: _basisFor(shared, 'ok', '按成员角色所需险种逐项比对 thresholds 参考保额（evaluateCoverage 同源）')
    })
  }

  const sorted = items.slice().sort(function(a, b) { return _rank(a, b, memberIndex) })
  sorted.forEach(function(it) { delete it._seq })

  const counts = { red: 0, yellow: 0, green: 0 }
  sorted.forEach(function(it) { counts[it.level] = (counts[it.level] || 0) + 1 })

  // TOP-N：红/黄取前 N 条，超出部分计入 more；绿色（达标项）始终保留在末尾
  const primary = sorted.filter(function(it) { return it.level !== 'green' })
  const green = sorted.filter(function(it) { return it.level === 'green' })
  const shown = primary.slice(0, limit)

  // 未展开部分按等级再拆一次：只写"另有 N 项"会把**被截断的高危项**藏起来，
  // 而"高危有 2 项没展开"与"关注有 2 项没展开"对读者的含义完全不同（前者必须点开看）。
  const hidden = primary.slice(limit)
  return {
    items: shown.concat(green),
    counts: counts,
    more: hidden.length,
    moreRed: hidden.filter(function(it) { return it.level === 'red' }).length,
    total: primary.length + green.length
  }
}

module.exports = { buildRiskAlerts, LEVEL_LABEL, LEVEL_RANK }
