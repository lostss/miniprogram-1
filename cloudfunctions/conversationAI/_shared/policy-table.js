/**
 * policy-table.js — 保单清单 Markdown 表生成的单一事实源
 *
 * 解决问题：conversationAI._policyTable 与 reportAI.buildStructuredCoverage
 * 各持一份"跳过 deleted/cancelled → 表头 → 行"骨架，列不同但模板同构。
 * 后端新增列或调整状态映射须改两处。
 *
 * 设计：列配置驱动 + 上下文注入
 *   buildPolicyTable(policies, { title, columns, skipStatuses, ctx })
 *     - columns: [{ header, get: (policy, ctx) => string }]
 *     - ctx: 调用方上下文（如 cashMap），传给 columns.get
 *
 * 状态映射（STATUS_TXT）作为公共常量导出，避免各处再写一份。
 */
const { yuanToWan } = require('./amount')
const STATUS_TXT = { active: '有效', expired: '已失效', deleted: '已删除', cancelled: '已取消', suspicious: '异常', unknown: '待确认' }

const DEFAULT_SKIP = ['deleted', 'cancelled']

function fmtStatus(p) { return STATUS_TXT[p.status] || '有效' }

function fmtOr(v, fallback = '-') { return v == null || v === '' ? fallback : v }

/**
 * 生成保单清单 Markdown 表
 * @param {array} policies
 * @param {object} opts
 *   - title: 表标题行（如 '## 保单清单'）
 *   - columns: [{ header, get(policy, ctx) => string }]
 *   - skipStatuses: 跳过的状态数组，默认 ['deleted','cancelled']
 *   - ctx: 传给 columns.get 的上下文对象（如 { cashMap, thisYear }）
 * @returns {string} markdown 表，无可见行时返回 ''
 */
function buildPolicyTable(policies, opts = {}) {
  const { title = '## 保单清单', columns, skipStatuses = DEFAULT_SKIP, ctx = {} } = opts
  if (!policies || policies.length === 0) return ''
  const cols = columns || AI_LOCATOR_COLUMNS
  const visible = policies.filter(p => !skipStatuses.includes(p.status))
  if (visible.length === 0) return ''
  const lines = [
    title,
    '| ' + cols.map(c => c.header).join(' | ') + ' |',
    '|' + cols.map(() => '------').join('|') + '|'
  ]
  for (const p of visible) {
    lines.push('| ' + cols.map(c => c.get(p, ctx)).join(' | ') + ' |')
  }
  return lines.join('\n')
}

// 预设列：AI 工具调用定位用（conversationAI 场景）
// 保额按"万"显示（与 reportAI 对齐，修复原 conversationAI 显示元值但表头标万的 bug）
const AI_LOCATOR_COLUMNS = [
  { header: 'policyId', get: p => p.id || p._id },
  { header: '产品', get: p => fmtOr(p.product_name) },
  { header: '险种', get: p => fmtOr(p.insurance_category) },
  { header: '保额(万)', get: p => Number(yuanToWan(p.sum_assured || 0).toFixed(1)) },
  { header: '年缴(元)', get: p => p.annual_premium || 0 },
  { header: '被保人', get: p => fmtOr(p.insured_name) },
  { header: '状态', get: fmtStatus },
  { header: '生效日', get: p => fmtOr(p.effective_date) }
]

module.exports = { buildPolicyTable, AI_LOCATOR_COLUMNS, STATUS_TXT, fmtStatus, fmtOr }
