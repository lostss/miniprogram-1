/**
 * fact-member-sync — 事实 → 成员的反向同步
 *
 * 架构审计第 13 轮：仅保留 _syncFactToMember（高置信度 fact → members 反向同步）。
 * 原 _writeMemberFact 移回 fact-write.js 改名 addMemberFact，消除循环依赖根因，
 * 懒加载 require('./fact-write') 已删除。
 *
 * 依赖关系（单向，无循环）：
 *   - fact-write → fact-member-sync（_syncFactToMember）
 *   - member-write / message-write → fact-write（addMemberFact，不再经本模块）
 */
const { setMemberField } = require('./_shared/memberRepo')

// 高置信度 fact → members 反向同步（与表单直写 members 互为镜像，消除跨源矛盾）
// 负债为家庭级（存 finances），members 无对应字段，故不在此列
const FACT_TO_MEMBER_FIELD = { '健康异常': 'health', '职业': 'occupation', '个人年收入': 'income' }

async function _syncFactToMember(db, familyId, openid, memberId, predicate, value, confidence) {
  if (!memberId || confidence < 0.8) return
  const field = FACT_TO_MEMBER_FIELD[predicate]
  if (!field) return
  let v = String(value)
  if (field === 'income') {
    const m = v.match(/(\d+(?:\.\d+)?)/)
    if (!m) return
    v = m[1]
  }
  if (!v) return
  await setMemberField(db, familyId, openid, memberId, field, v).catch(e => console.error('[dataWrite] setMemberField 失败:', e.message))
}

module.exports = { _syncFactToMember, FACT_TO_MEMBER_FIELD }
