/**
 * custom-blocks.js — customBlock 类型协议（单一事实源）
 *
 * 6 种 customBlock 类型在此处集中声明，提供：
 *  - SUPPORTED_TYPES：类型集合（用于测试/校验）
 *  - normalize(block)：补齐字段、规整形态（消费端用）
 *  - create(type, data)：构造 block（生成端用，可校验关键字段）
 *
 * 新增类型步骤：
 *   1. 在 BLOCK_REGISTRY 加一行
 *   2. 在 report-markdown/index.wxml 加对应 wx:if
 *   3. 在 report-builder.js 调用 create('xxx', {...})
 *
 * 类型契约（字段说明）：
 *  - panorama:     { heads, cats, rows: [{name, cells: [{v, s}]}] }
 *  - timeline:     { items: [{y, label, type, date, policies: [{name, note}]}] }  年份为第一层节点，policies 内单产品同年多节点 note 以/分隔
 *  - calendar:     { items: [{m, v, h}] }   h: 1=有缴费 2=峰值月
 *  - family_tree:  { nodes: [{name, role, display, member_id}] }
 *  - finance:      { income, debt, expense }
 *  - risk_alerts:  { items: [{name, issue}] }
 *  - policy_cards: { groups: [{name(被保人), subgroups: [{name(保司), policies: [...]}]}] }  二级分组；组内按保单号排序（同号主险+附加险相邻）
 *
 * 已下线类型（清理审计）：overview / urgent_list / insight_cards / dashboard（无生成端）
 */

// 字段契约：必填字段（缺失则 normalize 时 console.warn 并补默认值）
const BLOCK_REGISTRY = {
  panorama: {
    required: ['heads', 'cats', 'rows'],
    defaults: { heads: [], cats: [], rows: [] }
  },
  timeline: {
    required: ['items'],
    defaults: { items: [] }
  },
  calendar: {
    required: ['items'],
    defaults: { items: [] }
  },
  family_tree: {
    required: ['nodes'],
    defaults: { nodes: [] }
  },
  finance: {
    required: ['income', 'debt', 'expense'],
    defaults: { income: 0, debt: 0, expense: 0 }
  },
  risk_alerts: {
    required: ['items'],
    defaults: { items: [] }
  },
  policy_cards: {
    required: ['groups'],
    defaults: { groups: [] }
  }
}

const SUPPORTED_TYPES = Object.keys(BLOCK_REGISTRY)

/**
 * 生成端：构造一个 customBlock
 * @param {string} type - BLOCK_REGISTRY 中的类型
 * @param {object} data - 字段数据
 * @param {string} [section] - 可选的章节标题（部分 block 用）
 * @returns {object} { t, section?, ...fields }
 */
function create(type, data, section) {
  const spec = BLOCK_REGISTRY[type]
  if (!spec) {
    console.warn('[custom-blocks] 未知类型:', type)
    return { t: type, ...data }
  }
  const block = { t: type, ...spec.defaults, ...data }
  if (section) block.section = section
  return block
}

/**
 * 消费端：规整 block，补齐缺失字段
 * 用于 report-markdown observer，防止 wxml 因 undefined 报错
 * @param {object} block
 * @returns {object}
 */
function normalize(block) {
  if (!block || typeof block !== 'object') return block
  const spec = BLOCK_REGISTRY[block.t]
  if (!spec) return block
  return { ...spec.defaults, ...block }
}

/**
 * 校验 block 是否符合契约（用于测试）
 * @param {object} block
 * @returns {{ valid: boolean, missing: string[] }}
 */
function validate(block) {
  if (!block || typeof block !== 'object') return { valid: false, missing: ['block'] }
  const spec = BLOCK_REGISTRY[block.t]
  if (!spec) return { valid: false, missing: ['t:' + block.t] }
  const missing = spec.required.filter(k => block[k] === undefined || block[k] === null)
  return { valid: missing.length === 0, missing }
}

module.exports = {
  BLOCK_REGISTRY,
  SUPPORTED_TYPES,
  create,
  normalize,
  validate
}
