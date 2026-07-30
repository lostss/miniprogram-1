/**
 * 成员维度映射 — dataWrite 单一数据源
 *
 * 架构审计第 13 轮候选 #6：从 _shared 迁至 dataWrite/。
 * 仅 dataWrite 内部调用（member-write / message-write / free-text-extractor），伪共享清理后
 * 避免被 sync-shared 同步到不需要的云函数。
 */
const MEMBER_DIMENSIONS = ['age', 'gender', 'role', 'health', 'occupation', 'education', 'marital_status']
const FAMILY_DIMENSIONS = ['income', 'annual_premium_budget', 'debt', 'fixed_expense']

/** 中文标签 → 英文字段 */
const ZH_TO_EN = { '年龄': 'age', '性别': 'gender', '角色': 'role', '健康': 'health', '职业': 'occupation', '教育程度': 'education', '婚姻状况': 'marital_status' }

/** 英文字段 → 中文标签 */
const EN_TO_ZH = { age: '年龄', gender: '性别', role: '角色', health: '健康', occupation: '职业', education: '教育程度', marital_status: '婚姻状况' }

/** 中文家庭级维度集合（用于区分家庭级 vs 成员级） */
const FAMILY_DIMENSIONS_ZH = new Set(['收入', '负债', '固定支出', '年保费预算'])

/** 中文成员级维度集合 */
const MEMBER_DIMENSIONS_ZH = new Set(['年龄', '性别', '角色', '健康', '职业', '教育程度', '婚姻状况', '偏好'])

/** AI 工具调用允许的中文维度白名单（家庭级 ∪ 成员级） */
const ALLOWED_DIMENSIONS = new Set([...FAMILY_DIMENSIONS_ZH, ...MEMBER_DIMENSIONS_ZH])

module.exports = { MEMBER_DIMENSIONS, FAMILY_DIMENSIONS, ZH_TO_EN, EN_TO_ZH, FAMILY_DIMENSIONS_ZH, MEMBER_DIMENSIONS_ZH, ALLOWED_DIMENSIONS }
