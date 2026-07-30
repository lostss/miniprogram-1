/**
 * dataWrite/constants — 字段白名单 + 嵌套键安全校验 + 角色枚举
 *
 * 作用：
 *   1. ALLOWED_FIELDS — updateFamily(action='set') 单字段更新白名单
 *   2. isSafeKey      — updateData 批量更新时拒绝原型污染键
 *   3. VALID_ROLES    — members.role 字段枚举（submitProfiling/setMemberField 校验）
 *
 * 设计原则（ponytail）：
 *   - 单一来源，避免散落硬编码
 *   - 增删字段改一处即可
 *   - 架构审计 H：合并 _helpers.js 入此文件（消除 1 文件 / 1 引用方 / 2 死代码导出）
 */

// ======================== 角色枚举 ========================
// 来源：members 集合 role 字段（见 CONTEXT.md 数据模型）
const VALID_ROLES = ['本人', '配偶', '丈夫', '妻子', '父母', '子女', '父亲', '母亲', '儿子', '女儿', '爷爷', '奶奶']

// ======================== 字段白名单 ========================
// 来源：families 集合 schema（见 CONTEXT.md 数据模型 + handlers.js 实际写入字段）
// 注意：
//   - _id / _openid / created_at 由系统控制，不在白名单
//   - updated_at 由 handlers.js 自动覆盖
//   - 派生字段（completeness_score / insight_stale / profile_state）由业务逻辑（reportAI / family-mutation / handlers）更新，列入白名单以允许写路径覆盖
const ALLOWED_FIELDS = [
  // 基础信息
  'family_name',
  'family_structure',
  'members',
  'memo',
  'status',

  // 经济状况
  'financial_snapshot',

  // 健康确认
  'confirmed_health',
  'health_confirmed',

  // 完整度 / 阶段
  'completeness_score',
  'engagement_stage',
  'profile_state',
  'has_portrait',

  // 画像 / 摘要
  'quick_profile',
  'last_summary',
  'last_analysis',
  'last_suggestions',
  'last_conclusion',
  'last_disclaimer',
  'last_analysis_at',

  // 提醒 / 标记
  'info_alert',
  'protection_alert',
  'has_new_insight',
  'insight_stale',
  'summary_pending',

  // 软画像（自由文本扩展）
  'soft_profile'
]

// ======================== 嵌套键安全校验 ========================
/**
 * 拒绝原型污染键与跨集合引用键
 * - 拒绝 __proto__ / constructor / prototype（防原型污染）
 * - 拒绝 _id / _openid / _openid 重写（避免越权）
 * - 拒绝空键 / 非字符串键
 *
 * @param {string} key — 形如 'members.0.name' / 'financial_snapshot.debt.amount'
 * @returns {boolean} true=安全可写
 */
function isSafeKey(key) {
  if (!key || typeof key !== 'string') return false
  // 拒绝原型污染：__proto__ / constructor / prototype
  if (/(^|\.|_)(__proto__|constructor|prototype)(\.|$|_)/.test(key)) return false
  // 拒绝重写系统字段（_id/_openid 不能通过 updateData 修改）
  if (/(^|\.)(_id|_openid)(\.|$)/.test(key)) return false
  // 拒绝空段（'..' 或首尾 '.'）
  if (key.indexOf('..') !== -1 || key.charAt(0) === '.' || key.charAt(key.length - 1) === '.') return false
  return true
}

module.exports = { VALID_ROLES, ALLOWED_FIELDS, isSafeKey }
