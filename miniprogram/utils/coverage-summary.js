/**
 * coverage-summary.js — 保额汇总**按险种拆分**（跨树契约）
 *
 * 2026-10-14 用户决策：**不再展示单一"总保额"**，改为按保障类型统计（重疾/医疗/意外/寿险…）。
 * 背景：医疗险 400 万报销年限额 + 重疾 30 万保险金额直接相加没有意义（前者是报销上限、
 * 后者是给付金额），混算出来的"总保额"会让客户把报销额度当成"能拿到手的钱"。
 * （此前靠"一年期短险单列"缓解，见 `docs/data-model-v2.md` 保额口径一节；现进一步拆分。）
 *
 * 为什么必须放在契约里：这个聚合此前**有三份独立实现** ——
 *   - `miniprogram/utils/report/data-normalizer.js`（报告页摘要卡）
 *   - `cloudfunctions/reportPdf/index.js`（纸面保障摘要，自算 `coverageW`）
 *   - `cloudfunctions/reportAI/report-context.js`（AI 上下文"有效保单总保额"行）
 * 三者输入同源、口径靠人工同步。现全部改为引用本文件，`sync-shared` 保证副本一致。
 *
 * ## 口径
 * - **保障型**：重疾险 / 医疗险 / 意外险 / 寿险（发生风险时赔钱的那类）
 * - **储蓄型**：年金 / 增额终身寿 / 终身寿险（挪储与传承，`thresholds` 里 basis 为"长期储蓄起步"）
 * - **未标注**：险种缺失（`canonCat` 兜底为 '其他'）→ **单列第三桶，不并入任何一类**。
 *   并入保障型会在它其实是储蓄型时高估保障厚度（反之亦然）→ 两头都不猜（红线 3）。
 *   它同时是数据质量信号：金额不为 0 就说明有保单缺 `insurance_category`。
 * - 金额单位统一**万元**；只列金额 > 0 的险种
 * - 只统计 `status === 'active'` 的保单（与报告其它口径一致）
 *
 * ⚠️ 本文件**不做**展示文案（页面/纸面/AI 上下文各有自己的排版），只给数据 + 分类判据，
 * 避免把某一端的排版措辞固化成"口径"。
 */
const { canonCat } = require('./thresholds')
const { isOneYearPolicy } = require('./policy-status')

// 储蓄型险种（与 thresholds.THRESHOLDS 的键一致：年金 / 增额终身寿 / 终身寿险）
const SAVINGS_CATS = ['年金', '增额终身寿', '终身寿险']

function isSavingsCat(cat) {
  return SAVINGS_CATS.indexOf(canonCat(cat)) !== -1
}

/**
 * 按险种汇总保额
 *
 * @param {array} policies — 保单（内部只取 status==='active'）
 * @returns {{
 *   byCat: Array<{cat: string, w: number, kind: 'protection'|'savings'}>,
 *   protectionW: number, savingsW: number, totalW: number, shortTermW: number, policyCount: number
 * }}
 *   byCat 按金额降序；totalW 仅供内部核对（**不得**作为"总保额"对外展示）
 */
function summarizeCoverage(policies) {
  const active = (policies || []).filter(function(p) { return p && p.status === 'active' })
  // ⚠️ 按**元**累加，最后统一转万并取整一次。
  // 若每张保单先 yuanToWan（它自身会取到 2 位）再累加、再取到 1 位，就是**二次取整**：
  // 实测 123456 元被算成 12.4 万（正确 12.3 万）。金额类聚合一律"原始单位累加、出口取整一次"。
  const map = {}
  let shortTermYuan = 0
  let totalYuan = 0
  active.forEach(function(p) {
    const cat = canonCat(p.insurance_category || '其他')
    const yuan = Number(p.sum_assured) || 0
    map[cat] = (map[cat] || 0) + yuan
    totalYuan += yuan
    if (isOneYearPolicy(p)) shortTermYuan += yuan
  })
  // 元 → 万（取整到 0.1，**只取一次**）：不走 yuanToWan 的原因见下 ——
  // yuanToWan 自身取到 2 位小数（面向"元级"展示），若再取 1 位就是**二次取整**：
  // 123456 元 → yuanToWan 得 12.35 → 取 1 位得 **12.4**，而单次取整应为 **12.3**（差额来自两次舍入）。
  // 本公式与 amount.js 同因子（1000 = 10000 / 10），只是把舍入放在出口一次完成。
  function toWan(yuan) { return Math.round(Number(yuan) / 1000) / 10 }
  let protectionYuan = 0
  let savingsYuan = 0
  let unknownYuan = 0
  // 报销/意外额度（按**险种**归集，与"是否一年期"无关）：医疗险是报销上限、意外险是意外额度。
  // 其余保障型（寿险 / 重疾 / 护理等）都算给付型 → 两者相加恰好等于 protectionW。
  const QUOTA_CATS = ['医疗险', '意外险']
  let quotaYuan = 0
  const byCat = Object.keys(map).map(function(cat) {
    // 险种未标注（canonCat 的 '其他' 兜底）**单列第三桶**，不计入保障型也不计入储蓄型：
    // 计进保障型会在它其实是储蓄型时**高估**保障厚度，计进储蓄型反之 —— 两头都不该猜（红线 3）。
    const kind = cat === '其他' ? 'unknown' : (isSavingsCat(cat) ? 'savings' : 'protection')
    if (kind === 'savings') savingsYuan += map[cat]
    else if (kind === 'protection') {
      protectionYuan += map[cat]
      if (QUOTA_CATS.indexOf(cat) !== -1) quotaYuan += map[cat]
    } else unknownYuan += map[cat]
    return { cat: cat, w: toWan(map[cat]), kind: kind }
  }).filter(function(x) { return x.w > 0 })
    .sort(function(a, b) { return b.w - a.w || String(a.cat).localeCompare(String(b.cat)) })

  return {
    byCat: byCat,
    protectionW: toWan(protectionYuan),
    savingsW: toWan(savingsYuan),
    // 未标注险种的保额（单列，不并入任何一类）
    unknownW: toWan(unknownYuan),
    totalW: toWan(totalYuan),
    shortTermW: toWan(shortTermYuan),
    // 2026-10-17（报告结构 v2.0 评审遗留项）：取消"保障型保额合计"，拆成两组**按险种**的数：
    //   payoutW   = 给付型（寿险 + 重疾）—— 发生风险时真正赔钱的部分
    //   quotaW    = 报销/意外额度（医疗 + 意外）—— 报销上限，每年需续保
    // ⚠️ 划分口径必须是**险种**，不能是"是否一年期"：第一版用 `protection − shortTermW`，
    //    真机立刻自相矛盾（长期给付 300 万，而险种明细 寿险100+重疾210=310 万，
    //    差额来自一张一年期重疾保单）—— 标签写"寿险/重疾"、算法按"一年期"，两个口径混用。
    // payoutW 用减法兜底（含护理险等少数非医疗/意外险种），保证 payoutW + quotaW === protectionW。
    // ⚠️ 本文件是**契约源**：改这里后必须 `node scripts/sync-shared.js`（同步到 miniprogram/utils/
    //    与各云函数的 _shared/ 副本；直接改副本会被覆盖）。
    payoutW: toWan(Math.max(0, protectionYuan - quotaYuan)),
    quotaW: toWan(quotaYuan),
    policyCount: active.length
  }
}

module.exports = { summarizeCoverage, isSavingsCat, SAVINGS_CATS }
