/**
 * facts-view.js — 客户档案视图构建（纯函数，2026-09-14）
 *
 * 背景：报告页「客户档案」原为时间线流水（按 created_at 倒序取前 30 条），三个问题：
 *   1) 保单节点属性（每张保单约 10 条）混入 → 把人员信息挤出截断窗口（5 张保单即 50 条 > 30）；
 *   2) 稳定属性（收入/职业）写一次半年不动 → 按时间排序必然沉底被截断；
 *   3) kind='lead'（待核实线索）无任何标记 → 易被当成客户确认的事实（业务风险）。
 *
 * 本模块按「信息稳定性」重组为四档（顺序即渲染顺序）：
 *   关键属性（axis 命中，按成员聚合，常驻不截断）
 *   → 需要留意（kind='constraint'）
 *   → 待核实（kind='lead'，前端显式标注"未确认"）
 *   → 记录时间线（其余事实，按时间倒序，仅复盘用）
 *
 * 客户版（opts.shared）规则不同：不给线索（猜测给客户看会引起不安/误导）、不给时间线，
 * 只保留已确认的客观信息（confidence >= SHARED_MIN_CONFIDENCE）。
 */
const { axisOf } = require('./fact-vocab')

// 「关键属性」展示槽（顺序即渲染顺序；不含年龄/性别——已在第 1 章家庭结构的成员卡片呈现）
const DISPLAY_AXES = [
  '个人年收入', '职业', '健康异常', '总负债', '房贷余额', '持有资产',
  '房产价值', '金融资产', '收入来源', '抚养赡养人数', '社保情况',
  '年保费预算', '有偏好', '教育程度', '婚姻状态'
]

// axis → 展示短标签
const AXIS_LABEL = {
  '个人年收入': '收入',
  '健康异常': '健康',
  '房贷余额': '房贷',
  '持有资产': '资产',
  '房产价值': '房产',
  '金融资产': '金融资产',
  '抚养赡养人数': '赡养人数',
  '社保情况': '社保',
  '有偏好': '偏好',
  '教育程度': '学历',
  '婚姻状态': '婚姻'
}

const TIMELINE_MAX = 20
const SHARED_MIN_CONFIDENCE = 0.8

/** 事实时间文案：近 30 天用相对时间，更早用日期 */
function _timeText(ts) {
  if (!ts) return ''
  const t = new Date(ts).getTime()
  if (isNaN(t)) return ''
  const days = Math.floor((Date.now() - t) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return days + ' 天前'
  const d = new Date(ts)
  return (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

function _factText(f) {
  const label = f.predicate || ''
  const val = f.object_value || ''
  return val && val !== label ? label + '：' + val : label
}

/**
 * @param {Array} facts  queryFacts 返回的 fact 数组
 * @param {Object} opts   { shared: boolean } —— shared=客户版视角
 * @returns {{members, constraints, leads, timeline, truncated, total, empty}}
 */
function buildFactsView(facts, opts) {
  const shared = !!(opts && opts.shared)
  // 保单节点属性不进档案（防御性过滤：后端 queryFacts 默认已排除）
  const all = (facts || []).filter(f => f && f.subject_type !== 'policy')
  const visible = shared
    ? all.filter(f => (f.kind || 'fact') !== 'lead' && (f.confidence == null ? 1 : f.confidence) >= SHARED_MIN_CONFIDENCE)
    : all

  const memberMap = {}
  const constraints = []
  const leads = []
  const timeline = []

  for (const f of visible) {
    const kind = f.kind || 'fact'
    const ax = f.axis || axisOf(f.predicate)
    if (kind === 'constraint') { constraints.push({ key: f._id, text: _factText(f) }); continue }
    if (kind === 'lead') { leads.push({ key: f._id, text: _factText(f) }); continue }
    if (DISPLAY_AXES.indexOf(ax) !== -1) {
      const sid = f.subject_id || '_family'
      const m = memberMap[sid] || (memberMap[sid] = { key: sid, name: f.subject_name || '家庭', attrs: {}, order: [] })
      if (!m.attrs[ax]) { m.attrs[ax] = []; m.order.push(ax) }
      if (f.object_value && m.attrs[ax].indexOf(f.object_value) === -1) m.attrs[ax].push(f.object_value)
      continue
    }
    timeline.push({
      key: f._id,
      ts: new Date(f.created_at || 0).getTime() || 0,
      timeText: _timeText(f.created_at),
      text: (f.subject_name ? f.subject_name + ' · ' : '') + _factText(f)
    })
  }

  const members = Object.keys(memberMap).map(k => {
    const m = memberMap[k]
    m.order.sort((a, b) => DISPLAY_AXES.indexOf(a) - DISPLAY_AXES.indexOf(b))
    return {
      key: m.key,
      name: m.name,
      text: m.order.map(ax => (AXIS_LABEL[ax] || ax) + ' ' + m.attrs[ax].join('、')).join(' · ')
    }
  })

  timeline.sort((a, b) => b.ts - a.ts)
  const truncated = !shared && timeline.length > TIMELINE_MAX
  const tl = shared ? [] : timeline.slice(0, TIMELINE_MAX)

  return {
    members,
    constraints,
    leads,
    timeline: tl,
    truncated,
    total: visible.length,
    empty: !members.length && !constraints.length && !leads.length && !tl.length
  }
}

module.exports = { buildFactsView, DISPLAY_AXES, AXIS_LABEL, TIMELINE_MAX, SHARED_MIN_CONFIDENCE }
