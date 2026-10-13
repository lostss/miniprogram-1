/**
 * policy-status.js — 保单状态自动计算
 *
 * 设计原则：
 * - 纯函数，无副作用，可单元测试
 * - 入库/聚合/报告均可复用
 * - 存量保单无 status 字段时降级推断（不写回 DB）
 *
 * parseExpiry 由 parse-expiry.js 提供（前后端共用权威源），此处 re-export 保持向后兼容。
 */
const { parseExpiry } = require('./parse-expiry')

// 保单生命周期状态。
// `MANUAL_STATUSES` 是本文件的**导出契约**：dataWrite/policy-write.js 的 `POLICY_STATUS_CHANGEABLE`
// 由它派生（`['active', ...MANUAL_STATUSES]`，+'active' 表示"手动恢复有效"）。
// 【2026-09-22 口径自查】此前两处各手写一份清单（本文件 4 个态 vs policy-write 5 个态），
// 只靠注释声明"保持同构" → 一方新增必漂移。现在只改本文件即可，勿在 policy-write 再写清单。
const STATUS_LABELS = {
  active: '有效',
  lapsed: '失效',
  surrendered: '退保',
  claim_terminated: '理赔终止',
  expired: '到期终止',
  cancelled: '退保',
  suspicious: '数据异常',
  deleted: '已删除',
  unknown: '未知'
}

// 手动终止状态：用户/业务员显式设置，系统自动判断不得覆盖
const MANUAL_STATUSES = ['lapsed', 'surrendered', 'claim_terminated', 'cancelled']

// 系统自动判断的终止状态
const AUTO_STATUSES = ['expired']

// 所有已知状态（含 active/expired/手动态）。ensureStatus 尊重全部显式状态，不做重算
const KNOWN_STATUSES = ['active', 'expired', 'suspicious', 'deleted', ...MANUAL_STATUSES]


function _fmtDate(d) {
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + '到期'
}

// 一年期判定：起止日相差约 1 年（345~385 天，容忍闰年/起止边界偏移）
function _isOneYearSpan(effStr, expiryDate) {
  if (!expiryDate || !effStr) return false
  const eff = new Date(effStr)
  if (isNaN(eff.getTime())) return false
  const diffDays = (expiryDate.getTime() - eff.getTime()) / 86400000
  return diffDays >= 345 && diffDays <= 385
}

/**
 * 计算保单状态
 * @param {object} policy - 保单对象 { effective_date, insurance_period, payment_period, insured_age }
 * @returns {{ status: string, expiry_date: string|null }}
 */
function calcStatus(policy) {
  const now = new Date()
  const thisYear = now.getFullYear()
  const eff = policy.contract_effective_date || policy.effective_date || ''
  const age = policy.insured_age || 0
  const period = policy.insurance_period || ''

  // 先检查异常数据
  if ((!policy.sum_assured || policy.sum_assured === 0) && policy.annual_premium > 0) {
    return { status: 'suspicious', expiryInfo: '保额=0但保费>0', expiry_year: null }
  }

  // 用户决策：自动到期判断只对一年期以上产品生效，排除一年期产品
  //（一年期通常为灵活续保/保证续保，不因生效满一年自动判 expired；有明确到期日时由 OCR/表单 coverage_term 承载）
  // 文本形态：'1年' / '1年期' / '一年' / '壹年'；日期区间形态（如"自2024年01月15日...至2025年01月14日"）由下方
  // _isOneYearSpan 语义判定兜底（parseExpiry 会先解析出精确到期日，须在 expired 判断前拦截）
  if (/^(1|一|壹)\s*年/.test(period)) {
    return { status: 'active', expiryInfo: '一年期', expiry_year: null }
  }

  const expiry = parseExpiry(period, eff, age)

  // 判断是否过期
  if (expiry.year !== null) {
    // 日期区间形态的一年期（如 2024-01-15 至 2025-01-14）：保证续保场景，不因到期日已过自动判 expired
    if (expiry.date && _isOneYearSpan(eff, expiry.date)) {
      return { status: 'active', expiryInfo: '一年期', expiry_year: expiry.year }
    }
    // 有精确到期日则按日期比较。
    // 2026-09-20（复核批次 A）：分界从"到期日当天 00:00"后移到"到期日**次日** 00:00"。
    // 原实现 expiry.date 是当天 00:00（parse-expiry 用 new Date(y,m,d)），与含时分秒的 now 直接比较
    // → 到期日 00:00:01 即判 expired，比条款口径早了一天。条款原文形如
    // 「2025年03月20日零时起至2026年03月19日二十四时止」（parse-expiry L47 注释引），
    // 即到期日当天仍在保障期内 → 用次日零点作排他上界。
    // 注：仅年份的形态（parseExpiry 返回 new Date(yr,11,31)）同样顺延一天，口径一致。
    if (expiry.date) {
      const endExclusive = new Date(expiry.date.getTime())
      endExclusive.setDate(endExclusive.getDate() + 1)
      if (endExclusive <= now) {
        return { status: 'expired', expiryInfo: _fmtDate(expiry.date), expiry_year: expiry.year }
      }
    }
    // 仅有年份信息时降级为年份比较
    if (!expiry.date && expiry.year < thisYear) {
      return { status: 'expired', expiryInfo: expiry.year + '年到期', expiry_year: expiry.year }
    }
    // 一年期产品通常为保证续保，不因生效满一年自动判定到期；
    // 若 OCR/表单有明确到期日，会走上面的精确日期判断。
    return { status: 'active', expiryInfo: expiry.label, expiry_year: expiry.year }
  }

  // 无法判断的标记为 unknown
  if (period && expiry.year === null) {
    return { status: 'unknown', expiryInfo: period, expiry_year: null }
  }

  return { status: 'active', expiryInfo: '--', expiry_year: null }
}


/**
 * 确保保单有 status 字段（存量兼容）
 * 已有 status → 不动；无 status → 推断但不写回 DB
 * @param {object} policy
 * @returns {object} 带 status 的保单
 */
function ensureStatus(policy) {
  // 已有显式状态（含 active/手动态/expired）→ 尊重，不重算。
  // 与写入层设计一致：writePolicy 录入即判定状态、updatePolicy 手动变更是用户明确意图，
  // 读取层不覆盖（否则"手动恢复有效"会被立即重算为 expired——读取层自动纠正与写入层显式落库矛盾）。
  // 仅无 status 或 unknown（存量兼容）时按期限推断。
  if (policy.status && policy.status !== 'unknown' && KNOWN_STATUSES.includes(policy.status)) {
    return policy
  }
  const { status, expiryInfo } = calcStatus(policy)
  policy.status = status
  policy._expiryInfo = expiryInfo
  return policy
}

/**
 * 批量确保状态（轻量，不写 DB）
 * @param {array} policies
 * @returns {array}
 */
function ensureStatusBatch(policies) {
  return (policies || []).map(p => ensureStatus(p))
}

// 架构审计第 16 轮候选 #1：filterActive / getExpired 删除（grep 全代码库 0 调用方，伪共享残留）
// 如需"仅取 active"语义，调用方应在自身业务逻辑中过滤，或未来在 policy-read.js 加 onlyActive 选项

/**
 * 对话录入的**哨兵值**（AI 工具 schema 的明文约定，见 conversationAI/tools.js 对字段的描述）。
 * 两套编码 × 两代写法，**所有消费方都必须走这两个函数**，勿再内联比较：
 *   coverage_term : 105 = 终身；0/'0' 是更早的"未填"哨兵（两代都要认）
 *   premium_term  : 1   = 趸交；0/'0' 同上
 *
 * 【2026-09-22 口径自查】此前 4 处消费方各写一份内联比较，且**已经因此漏过一次**：
 * 2026-09-20 PDF 审计 P1 —— `reportPdf._termYear` 只排除 0/'0'、漏了 105，于是
 * coverage_term=105 的保单在 PDF「保障节点」算出 startY+105 ≈ **2130 年"保障期满"**的荒谬条目，
 * 而同一份数据在前端 `timeline-builder._coverTermYear` 返回 null（无该节点）→ 口径分裂。
 * 修法是给 PDF **就地**加一个本地产常量 ✗ —— 只是把"下一个消费方还会漏"往后推了一次。
 * 现收敛到本文件 + 源码扫描测试（tests/policy-status.test.js）兜住未来新增。
 */
const LIFETIME_TERM = 105
const SINGLE_PAY_TERM = 1

/** coverage_term 是否为"终身"（含更早的 0/'0' 哨兵） */
function isLifetimeTerm(v) {
  return v === LIFETIME_TERM || v === String(LIFETIME_TERM) || v === 0 || v === '0'
}

/** premium_term 是否为"趸交/终身缴费"（含更早的 0/'0' 哨兵） */
function isSinglePayTerm(v) {
  return v === SINGLE_PAY_TERM || v === String(SINGLE_PAY_TERM) || v === 0 || v === '0'
}

/**
 * 是否"一年期"保单（短险）—— 三处消费方共用，避免各自实现口径不一。
 *
 * 【为什么抽出来】2026-09-04 已定过决策「一年期短险单独聚合，防总保额虚高误导」
 * （`report/data-normalizer` + `chapter-builder._isOneYear` 两处各自实现），但两处只认
 * **文本形态** `^(1|一)年` 与 `coverage_term=1` —— 对**日期区间形态**（`2025-03-20 至 2026-03-19`、
 * 或 `至YYYY年MM月DD日` 且起止相差约一年）一份都识别不出。
 * 实测线上唯一真实家庭 13 份保单：`shortTermCoverage` 恒为 **0**（机制从未触发），
 * 而其中至少 6 份（400 万医疗险 ×4 + 800 万意外险 ×1 + 附加险 ×1）都是长年保证续保的一年期产品。
 *
 * 本函数是 `_isOneYearSpan` 的对外封装：文本形态 / 数字编码 / 日期区间形态三者取并集。
 * @param {object} policy
 * @returns {boolean}
 */
function isOneYearPolicy(policy) {
  const p = policy || {}
  const period = String(p.insurance_period || '').trim()
  if (/^(1|一|壹)\s*年/.test(period)) return true                    // 文本形态：'1年' / '1年期' / '一年'
  if (p.coverage_term === 1 || p.coverage_term === '1') return true  // 数字编码：1=一年期
  const eff = p.contract_effective_date || p.effective_date || ''
  if (!eff) return false
  const exp = parseExpiry(period, eff, 0)                            // 日期区间形态：起止相差约一年
  return !!(exp.date && _isOneYearSpan(eff, exp.date))
}

function _pad2(n) { return ('0' + n).slice(-2) }
function _fmtYmd(d) { return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate()) }


/**
 * 载明期限已过、状态仍为 active 的保单 —— **不改状态，供报告给提醒**
 *
 * 【2026-09-22 产品决策】一年期产品默认是续保的，但要在报告中给出提醒。
 *
 * 背景（为什么需要这个函数）：`policy-write.writePolicy` 入库时**一律**写
 * `doc.status = 'active'`（注释原文"不做任何自动状态判断"，2026-08-30 决策），
 * 而读取侧 `ensureStatus` 把任何显式 status 当作"用户手动设定"、**永不重算** →
 * 载明到期日早已过去的保单在报告里永远显示"有效"。
 * 实测真实家庭 14 份保单全部 active，其中 6 份载明期限已过（最早 2020-09-27），
 * 含 4 份医疗险（各 400 万限额，一年期保证续保型）与 1 份意外险（800 万，一年期）。
 *
 * 判据与 `calcStatus` **同源同口径**（务必保持）：
 *   - 到期日当天仍有效（条款「…至 YYYY年MM月DD日二十四时止」），次日零点起才算已过
 *   - `isOneYear` 的两种形态：文本「1年/一年/壹年」，或起止跨度 345~385 天
 *   - 判断不出精确到期日则不猜（不进结果）
 *
 * @param {array} policies
 * @param {Date} [now] 便于测试注入
 * @returns {Array<{policy, product_name, insured_name, insurance_category, expiryDate, expiryText, isOneYear}>}
 *          isOneYear=true 表示"默认续保"假设适用；false 表示非一年期也已过期（提醒措辞应更强）
 */
function listExpiredButActive(policies, now) {
  const base = now ? new Date(now) : new Date()
  const today0 = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  const out = []
  for (let i = 0; i < (policies || []).length; i++) {
    const p = policies[i]
    if (!p || p.status !== 'active') continue
    const period = p.insurance_period || ''
    if (!period) continue
    const eff = p.contract_effective_date || p.effective_date || ''
    let exp = parseExpiry(period, eff, 0)
    const textForm = /^(1|一|壹)\s*年/.test(period)
    // 「1年」这类**年数文本**：parseExpiry 按既有惯例落到"该年 12-31"（见其 year 分支注释），
    // 但一年期的真实边界是**生效日 + 1 年** —— 不改用生效日推算的话，提醒会晚约 7 个月才出现
    // （2026-09-22 实测：2024-05-01 生效的「1年」被算成 2025-12-31）。日期区间形态（有精确日）不受影响。
    // 日期钳到月末，与 parse-expiry 的对应日规则一致（2/29 生效 → 次年 2 月末）。
    if (textForm && eff) {
      const d0 = new Date(eff)
      if (!isNaN(d0.getTime())) {
        const y2 = d0.getFullYear() + 1
        const lastDom = new Date(y2, d0.getMonth() + 1, 0).getDate()
        exp = { year: y2, date: new Date(y2, d0.getMonth(), Math.min(d0.getDate(), lastDom)), label: period }
      }
    }
    if (!exp.date) continue
    const endEx = new Date(exp.date.getFullYear(), exp.date.getMonth(), exp.date.getDate() + 1)
    if (endEx > today0) continue
    out.push({
      policy: p,
      product_name: p.product_name || '',
      insured_name: p.insured_name || '',
      insurance_category: p.insurance_category || '',
      expiryDate: exp.date,
      expiryText: _fmtYmd(exp.date),
      isOneYear: isOneYearPolicy(p)   // 统一走对外判据（文本/数字编码/日期区间三形态）
    })
  }
  // 非一年期的排前面（没有"默认续保"可依据，更需要人工核实）；同组按到期日升序（越早越该确认）
  out.sort(function (a, b) {
    if (a.isOneYear !== b.isOneYear) return a.isOneYear ? 1 : -1
    return a.expiryDate - b.expiryDate
  })
  return out
}

module.exports = {
  parseExpiry,
  calcStatus,
  ensureStatus,
  ensureStatusBatch,
  listExpiredButActive,
  isOneYearPolicy,
  LIFETIME_TERM,
  SINGLE_PAY_TERM,
  isLifetimeTerm,
  isSinglePayTerm,
  STATUS_LABELS,
  MANUAL_STATUSES,
  AUTO_STATUSES,
  KNOWN_STATUSES
}
