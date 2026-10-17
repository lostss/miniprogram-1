/**
 * member-echo — 空态成员回显（2026-10-17）
 *
 * 场景：新建客户时按「人数」建了 N 个**占位成员**（`成员1/成员2…`，命名契约见 member-skeleton），
 * 但一张保单都还没有 → 报告正文全空，用户看不到人数是否生效，会怀疑白填了。
 * 这里只做事实陈述（不评价、不催促），产出可直接渲染的一句话。
 *
 * 为什么单独成模块：报告页 index.js 已经很大，且这条文案是**跨场景复用**的
 * （报告空态 / 将来客户详情空态），放 utils 里才能被单测直接钉住。
 */
const { isSkeletonName } = require('./member-skeleton')

/**
 * @param {Array} members 家庭成员数组（可能含软删 status='deleted'、空名）
 * @returns {{ total:number, skeleton:number, text:string }} text 为空串表示无需回显
 */
function buildMemberEcho(members) {
  const active = (members || []).filter(
    (m) => m && m.status !== 'deleted' && String(m.name == null ? '' : m.name).trim()
  )
  if (!active.length) return { total: 0, skeleton: 0, text: '' }

  const skeleton = active.filter((m) => isSkeletonName(String(m.name).trim())).length
  let text
  if (skeleton === 0) text = '已建 ' + active.length + ' 位家庭成员'
  else if (skeleton === active.length) text = '已建 ' + active.length + ' 位家庭成员，姓名待补'
  else text = '已建 ' + active.length + ' 位家庭成员，其中 ' + skeleton + ' 位姓名待补'
  return { total: active.length, skeleton, text }
}

module.exports = { buildMemberEcho }
