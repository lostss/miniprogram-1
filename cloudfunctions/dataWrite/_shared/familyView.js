/**
 * familyView — 家庭成员视图组装（深模块，候选 3 从 member-store grab-bag 剥离）
 *
 * 唯一对外符号 loadFamilyView：组装 families 文档 + 附加 members /
 * financial_snapshot，形状对齐旧 families.members / families.financial_snapshot，
 * 使前端零改。内部隐藏旧内嵌形状兼容 + 3 集合拼接，调用方只学这一个接口。
 */
const { getFamily } = require('./db-helpers')
const { getMembers, getFinance } = require('./memberRepo')

async function loadFamilyView(db, openid, familyId) {
  // 全并行：getMembers/getFinance 仅依赖 familyId，无需等 family 文档返回
  const [family, members, finance] = await Promise.all([
    getFamily(db, familyId, openid),
    getMembers(db, familyId, openid),
    getFinance(db, familyId, openid)
  ])
  if (!family) return null
  family.members = members
  family.financial_snapshot = finance
  return family
}

module.exports = { loadFamilyView }
