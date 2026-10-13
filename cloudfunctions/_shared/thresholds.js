/**
 * thresholds.js — 保额阈值单一事实源（单位：万元）
 *
 * 前端矩阵(_coverageStatus/buildGaps) / AI prompt(REPORT_PROMPT 计算依据) /
 * 附录文案(引用说明) 三处共用，杜绝口径分裂。
 * 寿险/意外险以成员个人年收入为基（双收入家庭不再高估）。
 * 同步脚本会把它复制到各云函数 _shared/ 与 miniprogram/utils/。
 */

const THRESHOLDS = {
  '重疾险': { reference: 50, statusFn: (n) => n >= 50, basis: '治疗费(30-50万)+收入损失' },
  // 2026-09-11：reference 200 → 100（业务定义：医疗险缺口 = 100 万）。
  // 原 200 与「及格线 100」并存 → 前端缺口卡片按 200 算金额、矩阵依据却写"建议百万医疗"，两处口径打架。
  '医疗险': { reference: 100, statusFn: (n) => n >= 100, basis: '百万医疗起步（100万及格线）' },
  '寿险':   { reference: (debt, income) => debt + income * 5, statusFn: (n, debt, income) => n >= debt + income * 5, basis: '总负债+5年收入(需求分析法)' },
  '意外险': { reference: (debt, income) => Math.max(income * 5, debt), statusFn: (n, debt, income) => n >= Math.max(income * 5, debt), basis: '5倍年收入或总负债(取高)' },
  '年金':     { reference: 10, statusFn: (n) => n >= 10, basis: '长期储蓄起步' },
  '增额终身寿': { reference: 10, statusFn: (n) => n >= 10, basis: '长期储蓄起步' },
  '终身寿险':   { reference: 10, statusFn: (n) => n >= 10, basis: '长期储蓄起步' }
}
const DEFAULT_THRESHOLD = { reference: 100, statusFn: (n) => n >= 100, basis: '通用起步保额' }

// 险种归一化：数据 insurance_category 含裸词（意外/医疗/重疾），
// 而 THRESHOLDS 键与缺口矩阵用规范词（意外险/医疗险/重疾险）。
// 读取侧统一经此函数，避免矩阵/缺口出现重复分类、existing 映射对不上。
const CANON_CAT = {
  '重疾': '重疾险', '医疗': '医疗险', '意外': '意外险',
  '寿险': '寿险', '年金': '年金',
  // 2026-09-22：补反向拼写。规范词定为 '年金'（见上方 THRESHOLDS 键），
  // 但历史数据/其它写入路径可能存 '年金险' → 不归一就会在画像覆盖矩阵里漏掉。
  '年金险': '年金'
}
function canonCat(raw) {
  const c = (raw || '').trim()
  if (!c) return '其他'
  return CANON_CAT[c] || c
}

/**
 * 格式化参考保额描述（单一事实源派生）：
 * - 数字型 reference → "参考保额N万（basis）"，basis 解释为何取该值
 * - 函数型 reference（寿险/意外险）→ basis 文本本身即公式描述，直接返回
 */
module.exports = { THRESHOLDS, DEFAULT_THRESHOLD, CANON_CAT, canonCat }
