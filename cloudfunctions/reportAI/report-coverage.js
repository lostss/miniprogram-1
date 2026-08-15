/**
 * report-coverage.js — 结构化保单清单 + 数据一致性提示构建
 *
 * 设计动机：_buildStructuredCoverage 原内联在 reportAI/index.js 底部。
 * 抽出后 index.js 更聚焦于编排，本函数也可被 dataQuery 报告预览等场景复用
 * （架构审查 #7-④；第 13 轮：进一步拆出 buildCoverageHints 纯函数）。
 *
 * 表生成骨架复用 _shared/policy-table.js（与 conversationAI._policyTable 同源），
 * 本文件聚焦于报告专属列（现金价值/已缴年/回本）+ facts 一致性提示。
 *
 * 接口契约：
 *   buildStructuredCoverage(policies, facts, cashValues) → { structuredMd, hintsMd }
 *     - structuredMd: 结构化保单清单 Markdown 表（OCR 入库 · 覆盖现状以本表为准）
 *     - hintsMd: 数据一致性提示（facts 决策优先于保单库），无提示时为空串
 *
 *   buildCoverageHints(policies, facts) → string  （纯函数，无提示时返回 ''）
 *     - 独立导出，便于单测覆盖两分支（删除标记/孤儿拥有保障）
 */
const { parseExpiry } = require('./_shared/parse-expiry')
const { buildPolicyTable, fmtStatus, fmtOr } = require('./_shared/policy-table')
const { yuanToWan } = require('./_shared/amount')

// 报告专属列：含现金价值/已缴年/累计保费/回本点
// 通过 ctx 接收 cashMap 和 thisYear
const REPORT_COLUMNS = [
  { header: '产品', get: p => fmtOr(p.product_name) },
  { header: '险种', get: p => fmtOr(p.insurance_category) },
  { header: '保额(万)', get: p => Number(yuanToWan(p.sum_assured || 0).toFixed(1)) },
  { header: '被保人', get: p => fmtOr(p.insured_name) },
  { header: '状态', get: fmtStatus },
  { header: '生效日', get: p => fmtOr(p.effective_date) },
  {
    header: '保障到期',
    get: (p, ctx) => {
      // 双字段兼容：OCR 文本（insurance_period）优先，兜底对话数字（coverage_term，0=终身）
      const periodText = p.insurance_period || (p.coverage_term === 0 || p.coverage_term === '0' ? '终身' : (p.coverage_term ? String(p.coverage_term) + '年' : ''))
      if (!periodText) return '-'
      const r = parseExpiry(periodText, p.effective_date, 0)
      if (!r.year) return '-'
      return r.label === '长期' ? '终身' : String(r.year)
    }
  },
  {
    header: '已缴年',
    get: (p, ctx) => p.effective_date ? Math.max(0, ctx.thisYear - new Date(p.effective_date).getFullYear()) : '-'
  },
  {
    header: '累计保费',
    get: (p, ctx) => {
      if (!p.effective_date || !p.annual_premium) return '-'
      const years = Math.max(0, ctx.thisYear - new Date(p.effective_date).getFullYear())
      return String(years * p.annual_premium)
    }
  },
  {
    header: '现价',
    get: (p, ctx) => {
      const cash = ctx.cashMap.get(p.id)
      if (!cash) return '-'
      // 数值审计 #5：按已缴年数取当前对应行（原 latest_value 是末行=满期现价，误导"当前现价"）
      // 兼容旧数据：无 cash_values 表但仅有 latest_value（满期值）时兜底展示
      if (!cash.cash_values || !cash.cash_values.length) {
        return cash.latest_value != null ? String(cash.latest_value) : '-'
      }
      const paidYears = p.effective_date ? Math.max(0, ctx.thisYear - new Date(p.effective_date).getFullYear()) : 0
      const row = _cashAtYear(cash.cash_values, paidYears)
      return row ? String(row.v) : '-'
    }
  },
  {
    header: '回本',
    get: (p, ctx) => {
      const cash = ctx.cashMap.get(p.id)
      if (!cash || !p.annual_premium || !cash.cash_values) return '-'
      // 数值审计 #5：现金价值表按每万元保额列示，回本判定需按保额比例换算表值（50万保单表值×50）
      const scale = Math.max(1, Math.round(yuanToWan(p.sum_assured || 0)))
      for (const row of cash.cash_values) {
        if (row.v * scale >= p.annual_premium * row.y) return `第${row.y}年`
      }
      return '-'
    }
  }
]

/** 现金价值表 {y,v}[] 中取 <= paidYears 的最近一行（无则取首行） */
function _cashAtYear(rows, paidYears) {
  let best = null
  for (const row of rows) {
    if (row.y <= paidYears) best = row
    else break
  }
  return best || (rows.length ? rows[0] : null)
}

/**
 * 以结构化保单（policies 集合）为覆盖权威源，生成给 AI 的清单表，
 * 并比对 facts 决策生成「数据一致性提示」（facts 决策优先于保单库）。
 *
 * @param {array} policies - 保单记录数组
 * @param {array} facts - 事实三元组数组
 * @param {array} cashValues - 现金价值记录数组
 * @returns {{ structuredMd: string, hintsMd: string }}
 */
function buildStructuredCoverage(policies, facts, cashValues) {
  const now = new Date()
  const thisYear = now.getFullYear()
  const cashMap = new Map()
  for (const cv of (cashValues || [])) {
    cashMap.set(cv.policy_id, cv)
  }

  const structuredMd = buildPolicyTable(policies, {
    title: '## 结构化保单清单（OCR 入库 · 覆盖现状以本表为准）',
    columns: REPORT_COLUMNS,
    ctx: { cashMap, thisYear }
  })

  const hintsMd = buildCoverageHints(policies, facts)
  return { structuredMd, hintsMd }
}

/**
 * 数据一致性提示构建（纯函数）
 *
 * 两类提示：
 *   1) facts 标记删除/作废 → 保单库仍为有效 → 报告按"已删除"处理（以对话决策为准）
 *   2) facts 拥有保障/公司提供保障 → 保单库无对应记录 → 按待确认处理
 *
 * 架构审计第 13 轮：从 buildStructuredCoverage 拆出，便于单测覆盖两分支。
 *
 * @param {array} policies
 * @param {array} facts
 * @returns {string} Markdown 片段；无提示时为空串
 */
function buildCoverageHints(policies, facts) {
  const hints = []
  const DEL_RE = /(删除|作废|退保|取消|不续|停保|失效|不要了)/
  for (const f of (facts || [])) {
    if (!['备注', '有特征', '未来计划'].includes(f.predicate)) continue
    const v = f.object_value || ''
    if (!DEL_RE.test(v)) continue
    const matched = (policies || []).find(p => {
      const base = (p.product_name || '').replace(/[（(].*$/, '')
      return base && (v.includes(p.product_name) || (base.length >= 4 && v.includes(base)))
    })
    if (matched && matched.status !== 'deleted' && matched.status !== 'cancelled') {
      hints.push(`- 保单库显示「${matched.product_name}」为有效，但对话决策标记为已删除/作废 → 报告按「已删除」处理（以对话决策为准）`)
    }
  }
  const polIds = new Set((policies || []).map(p => p.id).filter(Boolean))
  for (const o of (facts || [])) {
    if ((o.predicate === '拥有保障' || o.predicate === '公司提供保障') && o.object_id && !polIds.has(o.object_id)) {
      hints.push(`- 对话记录「${o.subject_name || ''}」${o.predicate}：${o.object_value || ''}，但保单库无对应记录 → 按待确认处理`)
    }
  }
  return hints.length ? '## 数据一致性提示\n' + hints.join('\n') : ''
}

module.exports = { buildStructuredCoverage }
