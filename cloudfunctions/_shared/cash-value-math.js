/**
 * cash-value-math — 现金价值计算唯一事实源（2026-09-15 架构审查候选 2）
 *
 * 现价表按「每万元保额」列示（DB 存的是每万元对应的表值），因此任何消费方都必须先按保额比例换算：
 *   row.v * scale >= annual_premium * row.y     ← 回本判定
 *
 * 原实现散落三处，逐字同构但各自演化：
 *   - cloudfunctions/reportAI/report-coverage.js（报告「现价/回本」两列）
 *   - cloudfunctions/reportPdf/index.js `_findBreakeven`（PDF 保障节点）
 *   - miniprogram/utils/report/timeline-builder.js `findBreakEvenYear`（前端时间轴；注释自述"对齐后端"）
 * 靠注释维系的同步必然漂移——同一张保单在三处可能给出不同回本年份。
 *
 * 跨树契约文件（sync-shared 同步到 miniprogram/utils/）。
 */
const { yuanToWan } = require('./amount')

/** 保额比例：现价表按每万元保额列示，消费时须乘此系数（保额不足 1 万按 1 计） */
function coverScale(sumAssured) {
  return Math.max(1, Math.round(yuanToWan(sumAssured || 0)))
}

/**
 * 现价表 {y,v}[] 中取 <= paidYears 的最近一行；**没有合格行则 null**（不取首行）
 *
 * 2026-09-27 修（原本"无则取首行"）：那条回落是为了兜住调用方传 `paidYears = 0` 的情况
 * （旧后端用「当前年 − 生效年」，同年生效的保单算出 0 → 没有 `y <= 0` 的行 → 退回首行凑一个值）。
 * 现在保单年度改由 `policyYearAt` 给出（恒 >= 1），该场景不存在；而回落本身有害：
 * **现价表起始年度晚于当前保单年度时（如收益演示/年金领取期表），它会把"未来某年"的值
 * 当作"当前现价"显示** —— 前端 `tests/report-builder.test.js`「表超出当前年度 → 现金价值不展示」
 * 正是钉住这一点。无合格行 = 该年度无现价数据 → 返回 null，由调用方渲染 '-' / 不展示（不猜）。
 *
 * @param {array} rows - [{ y, v }]
 * @param {number} paidYears - 保单年度（1 起）
 */
function cashAtYear(rows, paidYears) {
  if (!Array.isArray(rows) || !rows.length) return null
  let best = null
  for (const row of rows) {
    if (row.y <= paidYears) best = row
    else break
  }
  return best
}

/**
 * 回本年数（保单年度 Y）：现价达到累计已缴保费的那一年；现价表缺失 / 永不回本返回 null
 * @param {array} cashValues - [{ y, v }]（每万元保额表值）
 * @param {number} annualPremium - 年缴保费（元）
 * @param {number} sumAssured - 保额（元）
 */
function breakEvenYear(cashValues, annualPremium, sumAssured) {
  if (!Array.isArray(cashValues) || !cashValues.length) return null
  const premium = Number(annualPremium) || 0
  if (premium <= 0) return null
  const scale = coverScale(sumAssured)
  for (const row of cashValues) {
    if (!row) continue
    if (row.v * scale >= premium * row.y) return row.y
  }
  return null
}

/**
 * 保单年度（自 1 起）：生效日每满一个**周年** +1；未生效 / 日期判不出 → null
 *
 * 为什么必须并入本契约（2026-09-27 修 dsh 审计 ①）：现价表的 `y` 就是**保单年度**
 * （`ocrService/prompts.js` 明文约定："cash_values 中 y=保单年度（整数）"、"保单年度自 1 起连续递增"），
 * 所以"现在该取哪一行"完全由保单年度决定 —— 但两个消费方各写了一份**年差近似**，且相差 1：
 *   - 后端 `report-coverage._paidYears`：`当前年 − 生效年`      （未满周年也算整年，偏小 1）
 *   - 前端 `chapter-builder._currentCashValue`：`当前年 − 生效年 + 1`（周年日未到时偏大 1）
 * 实测（真实家庭，2026-09-27）：`多倍保障青少年重大疾病保险(A1款)` 生效 2020-05-20，实际保单年度 7，
 * 后端取 y=6 → 现价 6240；报告页取 y=7 → 现价 7960 ✗ —— **AI 上下文与客户手机上的同一个数不一样**。
 * 年差公式的共性错误是不看月日：按真实口径，周年日前后应分属不同保单年度。
 *
 * @param {string} effDate - 生效日（YYYY-MM-DD；容忍 '2020年5月' 这类 OCR 脏值 → 返回 null，不猜）
 * @param {Date|string|number} [now] - 便于测试注入，缺省当前时间
 */
function policyYearAt(effDate, now) {
  const s = String(effDate || '').substring(0, 10)
  if (!s) return null
  const e = new Date(s)
  if (isNaN(e.getTime())) return null
  const t = now == null ? new Date() : new Date(now)
  if (isNaN(t.getTime())) return null
  let years = t.getFullYear() - e.getFullYear()
  // 同月同日为上界；2/29 生效时钳到当月最后一天（与 parse-expiry 的对应日规则一致）
  const lastDom = new Date(e.getFullYear() + years, e.getMonth() + 1, 0).getDate()
  const anniversary = new Date(e.getFullYear() + years, e.getMonth(), Math.min(e.getDate(), lastDom))
  if (anniversary > t) years -= 1 // 本年度周年日未到
  const py = years + 1
  return py >= 1 ? py : null // <1 = 未生效
}

module.exports = { coverScale, cashAtYear, breakEvenYear, policyYearAt }
