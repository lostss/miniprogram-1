/**
 * completeness-sync — 家庭完整度重算（单一实现）。
 *
 * 为什么存在（流程审计 2026-09-18 UX3）：
 *   `completeness_score` 原先只在 `updateFamily`（成员/财务）与 reportAI 两处重算，
 *   **写保单的路径完全不重算** → OCR 存完一批保单，首页完整度圆环仍是旧值（用户以为没生效），
 *   要等打开报告或编辑一次才更新。而 `calcCompletenessScore` 本就依赖 policies
 *   （`policies.length > 0` 直接加 20 分）——保单写入恰恰是最该触发重算的动作之一。
 *   原实现是 family-write 的私有函数；现抽到本模块，供成员/财务/保单三条写路径共用。
 *
 * 成本：一次 loadFamilyView（3 集合并行）+ 一次 policies 查询 + 一次 update。
 *      **按批次调用**（OCR 一次调用覆盖整批），不要放进逐条循环。
 */

const { writeSeam } = require('./_shared/writeSeam')
const { calcCompletenessScore } = require('./_shared/completeness')
const { loadFamilyView } = require('./_shared/familyView')

/** 重算并落库 completeness_score（失败只记日志，不阻断主流程） */
async function syncCompleteness(db, familyId, openid) {
  try {
    const family = await loadFamilyView(db, openid, familyId)
    if (!family) return
    const hasMembers = (family.members || []).length > 0
    // 2026-09-22 全面审计 P1（数据写入侧）：查询必须排除软删保单。
    // `deletePolicy` 只把保单置 status:'deleted'（不物理删），而 calcCompletenessScore 仅判
    // `policies.length > 0` 就给 +20 分 → 删掉最后一张保单后完整度仍停在 60（圆环不掉档），
    // 与 policy-write.js「删掉最后一张保单后完整度会掉档，同样需要重算」的既定意图直接矛盾。
    const polRes = await db.collection('policies')
      .where({ family_id: familyId, _openid: openid, status: db.command.neq('deleted') })
      .limit(100).get()
    const policies = polRes.data || []
    const score = calcCompletenessScore(family, policies)
    const stateUpdate = { completeness_score: score }
    if (family.profile_state === 'not_ready' && hasMembers && policies.length > 0) stateUpdate.profile_state = 'ready'
    const ws = writeSeam(db, openid, familyId)
    await ws.updateWhere('families', { _id: familyId }, stateUpdate)
  } catch (e) { console.error('[completeness-sync] 重算失败:', e.message) }
}

module.exports = { syncCompleteness }
