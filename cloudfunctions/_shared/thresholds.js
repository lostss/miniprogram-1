/**
 * thresholds.js — 阈值单一事实源（保额单位：万元；保费收入比单位：%）
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

/**
 * 保费收入比参考区间（%，年保费 ÷ 家庭年收入）—— 2026-10-13 报告结构 v2.0 ④ 保费统计
 *
 * 口径来源：`specs/report-v2-20261013/design.md`（"双十原则：7% 红线 / 10% 上限"）。
 * ⚠️ 三点必须遵守，否则会从"参考"滑成"绝对化建议"（撞 guardrail 三不原则第 2 条）：
 *   1. 这是**行业经验值，不是监管标准** → 一切对外文案只写"常见参考区间"，不得写"应当/标准/超标"。
 *   2. **仅在 owner 版显示**。客户版刻意不显示占收入比（家庭财务章对客户隐藏 → 客户无从核对基数），
 *      而"引用不可见数据下结论"在 2026-09-12 已被明确否决（连同"仅供参考"的双重减分写法）。
 *   3. 家庭年收入缺失时**不判定**（ratio 回落 0，不得据此判"偏低"）。
 *
 * ⚠️ 与设计稿自身的一处不一致（据实记录）：v2.0 ① 的风险灯写"保费超收入 15%"，而 ④ 的保费维
 * 写"7% 红线 / 10% 上限"。本处按 **④** 实现（更具体、且是专门讲保费的那一维）；若日后统一为 15%，
 * 只改这里的两个数字 + 对应文案，不要各处散写。
 */
const PREMIUM_RATIO = { comfortable: 7, ceiling: 10 }

/**
 * 保费收入比判定（纯函数，页面与 AI 共用同一口径）
 * @param {number} ratio 年保费占家庭年收入（%）；<=0 表示未填写收入
 * @returns {{ code: 'unknown'|'ok'|'watch'|'heavy', text: string }}
 *   text 为可直接渲染的中文说明；unknown 时 text 为空串（由调用方决定是否显示"未填写"提示）
 */
function premiumRatioVerdict(ratio) {
  const r = Number(ratio) || 0
  if (r <= 0) return { code: 'unknown', text: '' }
  if (r <= PREMIUM_RATIO.comfortable) {
    return { code: 'ok', text: '保费占收入比处于常见参考区间（' + PREMIUM_RATIO.comfortable + '% 以内）' }
  }
  if (r <= PREMIUM_RATIO.ceiling) {
    return { code: 'watch', text: '保费占收入比略高于常见参考区间（' + PREMIUM_RATIO.comfortable + '% 左右），可留意缴费压力' }
  }
  return { code: 'heavy', text: '保费占收入比高于常见参考区间（' + PREMIUM_RATIO.ceiling + '% 以上），可留意缴费压力' }
}

// 险种归一化：数据 insurance_category 含裸词（意外/医疗/重疾），
// 而 THRESHOLDS 键与缺口矩阵用规范词（意外险/医疗险/重疾险）。
// 读取侧统一经此函数，避免矩阵/缺口出现重复分类、existing 映射对不上。
const CANON_CAT = {
  '重疾': '重疾险', '医疗': '医疗险', '意外': '意外险',
  '寿险': '寿险', '年金': '年金',
  // 2026-10-24 修（审计：分险种表丢行）：储蓄型还有三种常见写法，之前不归一 →
  // 矩阵与分险种表都会**直接丢弃这笔保额**（不是"少一行"，是钱不见了）。
  // 统一归到规范词「年金」（本项目的储蓄型主类），展示层仍写"储蓄"。
  '增额终身寿': '年金', '增额终身寿险': '年金', '终身寿险': '年金', '两全': '年金', '两全保险': '年金',
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
module.exports = { THRESHOLDS, DEFAULT_THRESHOLD, CANON_CAT, canonCat, PREMIUM_RATIO, premiumRatioVerdict }
