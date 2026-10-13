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
// 2026-09-22（产品决策：一年期默认续保 + 文中提醒）：已过期但仍 active 的保单判据，与 calcStatus 同源
const { listExpiredButActive, isLifetimeTerm } = require('./_shared/policy-status')
// 现价/回本计算唯一事实源（与 PDF、前端时间轴共用，勿再内联公式）
const { coverScale, cashAtYear, breakEvenYear, policyYearAt } = require('./_shared/cash-value-math')

// 已缴年口径（2026-09-22 全面审计 · 报告链路 P1）：原三处直接
//   `Math.max(0, ctx.thisYear - new Date(p.effective_date).getFullYear())`
// 有两个缺陷：
//   ① 缺 `contract_effective_date` 兜底——项目里其余所有消费点（本文件 L42 保障到期、
//      policy-status.js、familyPortrait、reportPdf L492/L677）都是
//      `p.contract_effective_date || p.effective_date`，只有这三处例外；
//   ② 没校验日期是否可解析：`effective_date` 是 OCR 文本，库里真实存在 '2020年5月' 这类脏值
//      （见 tests/writePoliciesBatch.test.js 的夹具）→ getFullYear() 为 NaN →
//      Math.max(0, NaN) = NaN → 表里写出字面量 **NaN**（已实测：「已缴年 = NaN、累计保费 = NaN」）。
//      这段 markdown 直接进 AI 上下文，而 prompt 又要求"直接引用系统预计算值" → 模型会把 NaN
//      抄进结论/规划，客户在报告里看到"已缴年 NaN"。
// 抽成一个函数返回 年数 或 null（null = 判不出，调用方渲染 '-'，不猜）。
//
// 2026-09-27 修（dsh 审计 ①：现价取行前后端相差 1 年）：上面那版仍用「当前年 − 生效年」——
// 即**未满周年也按整年算**，且与前端 `chapter-builder._currentCashValue`（`当前年 − 生效年 + 1`）
// **相差 1 年**：实测同一保单同一时刻，后端取 y=6（现价 6240）、报告页取 y=7（现价 7960）
// → 同一份保单在 **AI 上下文**与**客户手机**上的现价不是一个数。
// 真实口径：现价表 `y` = **保单年度**（`ocrService/prompts.js` 明文"保单年度自 1 起连续递增"），
// 而保单年度按**生效日周年**计算（不满周年不进下一年度）—— 两个年差公式都不看月日，都不对。
// 现收敛到契约 `cash-value-math.policyYearAt(生效日, now)`（前后端同一实现）。
// ⚠️ 上面两条既有保护必须保留：① `contract_effective_date || effective_date` 兜底
// ② 判不出返回 null（渲染 '-'，不猜）。差别：未生效保单原先被 `Math.max(0, ·)` 压成 `0`
// （现价列会取到首行、累计保费显示 0），现返回 null → 三列统一显示 '-'（不猜）。
function _paidYears(p, now) {
  return policyYearAt(p.contract_effective_date || p.effective_date || '', now)
}

// 报告专属列：含现金价值/已缴年/累计保费/回本点
// 通过 ctx 接收 cashMap 和 now（Date；保单年度需按周年判定，不能只给年份）
const REPORT_COLUMNS = [
  { header: '产品', get: p => fmtOr(p.product_name) },
  { header: '险种', get: p => fmtOr(p.insurance_category) },
  { header: '保额(万)', get: p => Number(yuanToWan(p.sum_assured || 0).toFixed(1)) },
  { header: '被保人', get: p => fmtOr(p.insured_name) },
  { header: '状态', get: fmtStatus },
  // 生效日：与全项目同口径（contract_effective_date 优先）——否则本列显示的日期
  // 与「已缴年/保障到期」两列依据的日期可能不是同一个（2026-09-22 审计 P1 连带修）
  { header: '生效日', get: p => fmtOr(p.contract_effective_date || p.effective_date) },
  {
    header: '保障到期',
    get: (p, ctx) => {
      // 双字段兼容：OCR 文本（insurance_period）优先，兜底对话数字（coverage_term，105=终身，兼容旧 0）
      const periodText = p.insurance_period || (isLifetimeTerm(p.coverage_term) ? '终身' : (p.coverage_term ? String(p.coverage_term) + '年' : ''))
      if (!periodText) return '-'
      const r = parseExpiry(periodText, p.effective_date, 0)
      if (!r.year) return '-'
      return r.label === '长期' ? '终身' : String(r.year)
    }
  },
  {
    header: '已缴年',
    get: (p, ctx) => {
      const y = _paidYears(p, ctx.now)
      return y === null ? '-' : y
    }
  },
  {
    header: '累计保费',
    get: (p, ctx) => {
      const years = _paidYears(p, ctx.now)
      if (years === null || !p.annual_premium) return '-'
      return String(years * p.annual_premium)
    }
  },
  {
    header: '现价',
    get: (p, ctx) => {
      const cash = ctx.cashMap.get(p.id || p._id)
      if (!cash) return '-'
      // 数值审计 #5：按已缴年数取当前对应行（原 latest_value 是末行=满期现价，误导"当前现价"）
      // 兼容旧数据：无 cash_values 表但仅有 latest_value（满期值）时兜底展示
      if (!cash.cash_values || !cash.cash_values.length) {
        return cash.latest_value != null ? String(cash.latest_value) : '-'
      }
      const paidYears = _paidYears(p, ctx.now)
      if (paidYears === null) return '-'
      const row = cashAtYear(cash.cash_values, paidYears)
      if (!row) return '-'
      // 数值审计 #6：现价表按每万元保额列示，须与回本列同口径乘保额比例（50 万保单表值×50）
      return String(row.v * coverScale(p.sum_assured))
    }
  },
  {
    header: '回本',
    get: (p, ctx) => {
      const cash = ctx.cashMap.get(p.id || p._id)
      if (!cash || !p.annual_premium || !cash.cash_values) return '-'
      const y = breakEvenYear(cash.cash_values, p.annual_premium, p.sum_assured)
      return y ? `第${y}年` : '-'
    }
  }
]

/**
 * 以结构化保单（policies 集合）为覆盖权威源，生成给 AI 的清单表，
 * 并比对 facts 决策生成「数据一致性提示」（facts 决策优先于保单库）。
 *
 * @param {array} policies - 保单记录数组
 * @param {array} facts - 事实三元组数组
 * @param {array} cashValues - 现金价值记录数组
 * @returns {{ structuredMd: string, hintsMd: string }}
 */
function buildStructuredCoverage(policies, facts, cashValues, now) {
  // now 可注入（测试用）：保单年度按周年判定，断言结果依赖"今天是哪天" → 必须能钉住时间
  const at = now == null ? new Date() : new Date(now)
  const cashMap = new Map()
  for (const cv of (cashValues || [])) {
    cashMap.set(cv.policy_id, cv)
  }

  const structuredMd = buildPolicyTable(policies, {
    title: '## 结构化保单清单（OCR 入库 · 覆盖现状以本表为准）',
    columns: REPORT_COLUMNS,
    ctx: { cashMap, now: at }
  })

  // 2026-09-22（产品决策：一年期默认续保 + 文中提醒）：把"载明期限已过、状态仍有效"的保单
  // 显式写在表下。没有这段时，表里只是「状态=有效」与「保障到期=2021-05-19」两列并列，
  // 模型不会自己意识到这个组合有问题 —— 实测真实报告正是把这些已过期保单当当前保障算入。
  // **状态不改**（一年期按保证续保默认有效），只给提醒，让模型在结论/建议里说明。
  const alertsMd = _renderExpiryAlerts(listExpiredButActive(policies))

  const hintsMd = buildCoverageHints(policies, facts)
  return { structuredMd: structuredMd + alertsMd, hintsMd }
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
    // 2026-09-14：原实现依赖 predicate 白名单（备注/有特征/未来计划），谓词自由化后这类决策会写更自然的
    // 名称（如"退保决策"）→ 白名单必漏。改为只靠「值含删除词（本行）+ 值含保单名（下方）」双重约束判定，
    // 与谓词无关。
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
  // 2026-09-22（数据质量批次 3）：主键补 `_id` 兜底。
  // 保单的业务主键是 `id`（写库时生成），但历史/异常文档可能只有 DB 的 `_id`
  // → 原先「现价 / 回本」两列查 `cashMap` 恒落空、显示 `-`，而孤儿保障提示也随后漏判
  // （`polIds` 不含它 → 库里明明有这张保单，却被当成"仅存在于对话的保障"）。
  // 同一项目里 reportPdf 早就写成 `p.id || p._id`，此处对齐。
  const polIds = new Set((policies || []).map(p => p.id || p._id).filter(Boolean))
  const polNames = (policies || []).map(p => String(p.product_name || '').replace(/[（(].*$/, '')).filter(Boolean)
  for (const o of (facts || [])) {
    if (o.predicate !== '拥有保障' && o.predicate !== '公司提供保障') continue
    // 2026-09-14：原条件要求 object_id 非空——而对话补充的保障边多为 literal（无 object_id），
    // "保单库里没有的保障"反而被静默跳过（正是最该提示的情况）。改为无 object_id 时按产品名兜底比对。
    const linked = o.object_id
      ? polIds.has(o.object_id)
      : polNames.some(n => String(o.object_value || '').indexOf(n) !== -1)
    if (!linked) {
      hints.push(`- 对话记录「${o.subject_name || ''}」${o.predicate}：${o.object_value || ''}，但保单库无对应记录 → 按待确认处理`)
    }
  }
  return hints.length ? '## 数据一致性提示\n' + hints.join('\n') : ''
}

/**
 * 到期提醒段（2026-09-22 产品决策：一年期产品默认是续保的，但要在文中给出提醒）。
 *
 * 判据与 `reportPdf._expiryNote` 同源（`listExpiredButActive`），但这里输出 Markdown 是给**模型**读的，
 * 所以不只是披露事实，还要**指示模型在结论/建议里提到它** —— 否则模型会照旧把已过期保单当当前保障
 * （实测真实报告正是如此：4 份医疗险 400 万限额 + 1 份意外险 800 万均已过期，仍被计入总保额）。
 */
function _renderExpiryAlerts(alerts) {
  if (!alerts || !alerts.length) return ''
  const fmt = function (a) { return a.product_name + '·' + a.insured_name + '（载明至' + a.expiryText + '）' }
  const oneYear = alerts.filter(function (a) { return a.isOneYear })
  const other = alerts.filter(function (a) { return !a.isOneYear })
  const lines = ['', '### ⚠️ 载明保障期限已过的保单（共 ' + alerts.length + ' 份，状态仍标为"有效"）']
  // 非一年期排在前：它没有"默认续保"可依据，更需要人工核实（与 listExpiredButActive 的排序一致）
  if (other.length) {
    lines.push('- **非一年期产品**' + other.length + ' 份：' + other.map(fmt).join('、'))
    lines.push('  → 此类没有保证续保依据，建议核实是否确已续保或需另投，并按"待确认"表述。')
  }
  if (oneYear.length) {
    // 2026-09-28 全面审计 P2（口径分裂）：原写「按保证续保**默认仍有效**」，而 reportPdf 已于
    // 2026-09-25 因同一理由改掉这句话 —— `isOneYearPolicy` 只认「1 年 / 一年 / 约一年的日期区间」，
    // **判不出是否保证续保**（意外险、部分医疗险并不保证续保），该断言对它们是不成立的承诺；
    // 客户若据此以为仍在保，是实质性误导。此处改为与 PDF 同措辞（一般事实陈述 + 交还条款），
    // D3 决策本意（一年期默认续保 + 文中给提醒）不变，动作仍是"请确认续保"。
    lines.push('- **一年期产品**（载明期限已过，状态不改）' + oneYear.length + ' 份：' + oneYear.map(fmt).join('、'))
    lines.push('  → 请在结论或建议中**提醒用户确认是否已正常续保**（一年期通常按年续保，是否保证续保以条款为准；含保额/费率是否变化），不要直接按"已失效"处理，也不要断言"保证续保"。')
  }
  return lines.join('\n') + '\n'
}

module.exports = { buildStructuredCoverage, _renderExpiryAlerts, _paidYears }
