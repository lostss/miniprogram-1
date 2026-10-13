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
 * 状态映射来自契约 policy-status.js（STATUS_LABELS），本文件不再自持一份。
 */
const { yuanToWan } = require('./amount')
// 状态文案单一事实源（契约文件，与前端 chapter-builder / edit-form 共用）：
// 原本地 STATUS_TXT 仅 6 态，缺 lapsed/surrendered/claim_terminated → 靠 `|| '有效'` 回落，
// 致已退保/已失效保单在 AI「结构化保单清单」显示"有效"，与缺口矩阵自相矛盾。
const { STATUS_LABELS } = require('./policy-status')
// 2026-09-22 全面审计（死代码清理）：原 `const STATUS_TXT = STATUS_LABELS` 别名已删除——
// 注释曾称"既有调用方与测试仍按此名引用"，实测全仓（生产代码 + 测试 + 文档）零引用，
// 是一处自我延续的兼容层。需要该映射时直接用 STATUS_LABELS。

const DEFAULT_SKIP = ['deleted', 'cancelled']

// 未知状态显示原文，禁止回落"有效"（回落会把已终止保单伪装成有效）
function fmtStatus(p) { return STATUS_LABELS[p.status] || p.status || '未知' }

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

module.exports = { buildPolicyTable, AI_LOCATOR_COLUMNS, fmtStatus, fmtOr }
