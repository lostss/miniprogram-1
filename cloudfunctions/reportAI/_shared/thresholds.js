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
  '医疗险': { reference: 200, statusFn: (n) => n >= 100, basis: '百万医疗起步（100万及格线，建议200万+）' },
  '寿险':   { reference: (debt, income) => debt + income * 5, statusFn: (n, debt, income) => n >= debt + income * 5, basis: '负债+5年收入(需求分析法)' },
  '意外险': { reference: (debt, income) => Math.max(income * 5, debt), statusFn: (n, debt, income) => n >= Math.max(income * 5, debt), basis: '5倍年收入或负债(取高)' },
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
  '寿险': '寿险', '年金': '年金'
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
function _formatRef(cat) {
  const t = THRESHOLDS[cat]
  if (!t) return ''
  if (typeof t.reference === 'number') return `参考保额${t.reference}万（${t.basis}）`
  return t.basis
}

/** AI prompt 中的计算依据句（与矩阵口径一致），返回带 ¹²³⁴ 上标的文本 */
function formatThresholdPrompt() {
  return [
    `¹ 重疾险 = ${_formatRef('重疾险')} - 已有重疾保额`,
    `² 寿险 = 负债 + 5倍该成员年收入 - 已有寿险保额（${THRESHOLDS['寿险'].basis}）`,
    `³ 意外险 = 5倍该成员年收入 或 负债取高 - 已有意外保额（${THRESHOLDS['意外险'].basis}）`,
    `⁴ 医疗险 = ${_formatRef('医疗险')} - 已有医疗保额`
  ].join('\n')
}

/** 附录「引用说明」中阈值相关条目（1-4），与正文上标角标对应 */
function formatThresholdAppendix() {
  return [
    `1. 重疾险${_formatRef('重疾险')}`,
    `2. 寿险保额 = 家庭负债 + 5倍个人年收入 - 现有寿险保额（${THRESHOLDS['寿险'].basis}）`,
    `3. 意外险保额 = 5倍个人年收入 或 负债（${THRESHOLDS['意外险'].basis}）`,
    `4. 医疗险${_formatRef('医疗险')}`
  ].join('\n')
}

module.exports = { THRESHOLDS, DEFAULT_THRESHOLD, formatThresholdPrompt, formatThresholdAppendix, CANON_CAT, canonCat }
