/**
 * fact-member-sync — 事实 → 成员的反向同步
 *
 * 架构审计第 13 轮：仅保留 _syncFactToMember（高置信度 fact → members 反向同步）。
 * 原 _writeMemberFact 移回 fact-write.js 改名 addMemberFact，消除循环依赖根因，
 * 懒加载 require('./fact-write') 已删除。
 * （2026-09-27 补：addMemberFact 本身经全仓 grep 确认零调用方，已作为死代码删除 ——
 *   member-write / message-write 实际都是直接调 `addFact`。）
 *
 * 依赖关系（单向，无循环）：
 *   - fact-write → fact-member-sync（_syncFactToMember）
 *   - member-write / message-write → fact-write（`addFact`）
 */
const { setMemberField } = require('./_shared/memberRepo')
const { AXIS_MEMBER_FIELD } = require('./_shared/fact-vocab')

// 高置信度 fact → members 反向同步（与表单直写 members 互为镜像，消除跨源矛盾）
// 负债为家庭级（存 finances），members 无对应字段，故不在此列
// 2026-09-14：改为按归一化槽（axis）判定目标字段——predicate 已自由化（如"年薪"），字面量匹配会漏。
const FACT_TO_MEMBER_FIELD = AXIS_MEMBER_FIELD

/**
 * fact 文本 → 万（members.income 的契约单位）。纯函数，暴露给测试。
 *
 * 为什么需要（2026-09-22 数据盘点批次 1）：原实现只抠出第一个数字、完全不管单位——
 * "年收入30万" → 30 ✓ 正确；"年收入300000元" → **300000**（被当成万）✗ 差 10000 倍，
 * 报告里个人年收入会变成 30 亿。prompt 只约束了**工具参数**的单位
 * （conversationAI/prompts.js「upsertMember.data.income=万，勿转元」），
 * 而 facts 的 object_value 是自由文本，没有任何单位约束 → 必须在这里认单位。
 *
 * @returns {number|null} 万；解析不出返回 null（调用方跳过同步——不猜）
 */
function _incomeWan(text) {
  const m = /(\d+(?:\.\d+)?)\s*(万元|万|元)?/.exec(String(text || ''))
  if (!m) return null
  const n = parseFloat(m[1])
  if (!isFinite(n)) return null
  const unit = m[2] || ''
  // 「元」→ 万
  if (unit === '元') return Math.round(n / 100) / 100
  // 无单位但数量级明显是元（没人会说"300000万"）→ 按元处理，防 10000 倍误差
  if (!unit && n >= 10000) return Math.round(n / 100) / 100
  // 「万」「万元」或无单位的小数值 → 已按万
  return n
}

async function _syncFactToMember(db, familyId, openid, memberId, axis, value, confidence) {
  if (!memberId || confidence < 0.8) return
  const field = FACT_TO_MEMBER_FIELD[axis]
  if (!field) return
  let v = String(value)
  if (field === 'income') {
    const wan = _incomeWan(v)
    if (wan === null) return
    v = String(wan)
  }
  if (!v) return
  await setMemberField(db, familyId, openid, memberId, field, v).catch(e => console.error('[dataWrite] setMemberField 失败:', e.message))
}

module.exports = { _syncFactToMember, FACT_TO_MEMBER_FIELD, _incomeWan }
