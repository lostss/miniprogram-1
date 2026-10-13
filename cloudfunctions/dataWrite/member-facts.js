/**
 * member-facts — 成员被移除时的关联清理（单一实现）。
 *
 * 为什么存在（流程审计 2026-09-18）：
 *   成员有两条移除路径，清理逻辑原先只在其中一条里：
 *     ① `member-write.deleteMember`（对话/单点删除）→ 移除文档 + 正向 facts supersede + 反向关系边 supersede
 *     ② `family-write._syncMembers`（updateFamily.members 整组覆盖的差集）→ **只软删成员文档**
 *   于是报告页"删除成员"（走 ②）留下孤儿事实：被删成员名下的「拥有保障 / 职业 / 健康」等仍 active，
 *   画像与 AI 上下文继续把它当在册成员读出（本文件即为此抽出）。
 *
 * 2026-09-20（复核批次 B）曾在此加第二项清理 `clearPolicyMemberLinks`（把被移除成员的
 * `policies.member_id` 置空）；**2026-09-22 已回退删除**，两条原因都是事后才查清的：
 *   ① 它对声称要修的现象**实际无效**。三个消费点构建的 `memberIdToName` **只由在册成员构成**
 *      （`gap-engine` L75-79 / `data-normalizer` L38-42 / `gap-core` L117-120），已删成员的 id
 *      本来就查不到 → 一直走 `insured_name` 兜底 → 清空前后**代码路径完全相同**。
 *      唯一真实变化是 `report-builder`「保障人数」的去重 key 从 `mem_x` 变成姓名，**个数不变**
 *      （只有既无 `insured_name` 又已被删的极端数据会少算一人——那不是想要的语义）。
 *   ② 它违反书面数据模型规则：`docs/data-model-v2.md` L101「关联的 `policies.member_id`
 *      **保留原值不清空**」。`member_id` 是文档定义的 join key（`policies.member_id` 本身就是
 *      一个索引，§6.2 的 `where({ member_id, status })` 查询范式依赖它）。为一个"没修成"的
 *      问题去破坏一个被依赖的字段，是净损失。
 * 「已删成员的保单」在报告里的口径分歧（保障人数计入 / 缺口矩阵无对应行）**仍然存在**，
 * 但那是消费侧口径问题（产品决策），改数据修不掉。
 *
 * 语义：不抛错——返回失败标签数组，由调用方决定处置（deleteMember 需聚合为 207 partial，
 *      _syncMembers 的软删路径只需记日志）。**不要**在内部吞掉失败再返回空数组，
 *      否则 deleteMember 的"部分删除失败"披露会失效。
 */

/**
 * 将被移除成员的关联事实置为 superseded。
 * @returns {Promise<string[]>} 失败标签（'facts' 正向 / 'facts_reverse' 反向关系边）
 */
async function supersedeMemberFacts(db, ws, familyId, openid, memberId) {
  if (!memberId) return []
  const failed = []
  const _ = db.command
  // 正向：被移除成员作为 subject 的事实
  await ws.silentUpdateWhere('facts',
    { subject_type: 'member', subject_id: memberId, status: 'active' },
    { status: 'superseded' }
  ).catch(e => { console.error('[member-facts] 正向 supersede 失败:', e.message); failed.push('facts') })
  // 反向：其他成员指向被移除成员的关系边（配偶/子女/父母）
  await ws.silentUpdateWhere('facts',
    { family_id: familyId, _openid: openid, predicate: _.in(['配偶', '子女', '父母']), object_id: memberId, status: 'active' },
    { status: 'superseded' }
  ).catch(e => { console.error('[member-facts] 反向关系 supersede 失败:', e.message); failed.push('facts_reverse') })
  return failed
}

module.exports = { supersedeMemberFacts }
