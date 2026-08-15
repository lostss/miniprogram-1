/**
 * tool-summaries.js — 工具结果 UI 文案契约（单一事实源）
 *
 * 架构审计第 15 轮候选 #1：从 conversationAI/index.js TOOL_DISPATCHERS 拆出。
 * 原策略表混合三类关注点（exec / summary / needsConfirm+pending），
 * 本文件仅保留 summary 函数表（UI 文案契约），让编排文件聚焦"调谁"。
 *
 * 接口契约：
 *   TOOL_SUMMARIES[toolName](tr) → string | null
 *     - tr: { toolName, result, args, success, error? }
 *     - 返回自然语言摘要供前端聊天卡片展示；返回 null 表示不展示
 *
 * 设计要点：
 *   - 纯函数，不依赖 db/cloud/任何外部状态
 *   - 新增工具的 UI 文案只改本文件，不触碰 index.js 编排流程
 *   - _ok 辅助判定内聚于此（原 index.js _ok 函数）
 */
const { fmtYuan } = require('./_shared/amount')

function _ok(tr) {
  return !!(tr && tr.result && tr.result.code === 200)
}

const TOOL_SUMMARIES = {
  upsertMember: (tr) => {
    if (!_ok(tr)) return null
    const name = (tr.args && (tr.args.memberName || (tr.args.data && tr.args.data.name))) || '成员'
    return '✅ 已更新成员「' + name + '」信息'
  },
  updateFinances: (tr) => _ok(tr) ? '✅ 已更新家庭财务信息' : null,
  addPolicy: (tr) => {
    if (!_ok(tr)) return null
    const a = tr.args || {}
    const name = a.product_name || '保单'
    const premium = a.annual_premium ? ('年缴' + fmtYuan(a.annual_premium)) : ''
    const sum = a.sum_assured ? ('保额' + fmtYuan(a.sum_assured)) : ''
    return '✅ 已记录' + name + (premium || sum ? '（' + [premium, sum].filter(Boolean).join('，') + '）' : '')
  },
  addFact: (tr) => {
    if (!_ok(tr)) return null
    const pred = (tr.args && tr.args.predicate) || '事实'
    const val = (tr.args && tr.args.objectValue) || ''
    return '✅ 已记录' + pred + (val ? '：' + val.substring(0, 30) : '')
  },
  updateFactConfidence: () => null,
  triggerAnalysis: (tr) => _ok(tr) ? '🔄 正在生成分析报告，完成后可刷新查看' : null,
  writeMessage: () => null,
  queryPolicies: (tr) => (_ok(tr) && tr.result.data && tr.result.data.policies) ? ('📋 共 ' + tr.result.data.policies.length + ' 张保单') : null,
  queryMembers: (tr) => (_ok(tr) && tr.result.data && tr.result.data.members) ? ('👥 共 ' + tr.result.data.members.length + ' 位成员') : null,
  queryFacts: (tr) => (_ok(tr) && tr.result.data && tr.result.data.facts) ? ('📝 共 ' + tr.result.data.facts.length + ' 条事实') : null,
  createFamily: (tr) => {
    if (!_ok(tr)) return null
    const name = (tr.args && tr.args.family_name) || ''
    return '✅ 已创建家庭档案' + (name ? '「' + name + '」' : '')
  },
  updatePolicy: (tr) => {
    if (!_ok(tr)) return null
    const name = (tr.args && tr.args.product_name) || '保单'
    return '✅ 已更新' + name
  },
  // 删除类工具：未 confirmed 时返回 409 待确认卡片，confirmed 路径经 _handleConfirm；
  // 正常工具链不应到达 summary，返回 null 保持沉默
  deleteMember: () => null,
  deletePolicy: () => null,
  deleteFact: () => null
}

module.exports = { TOOL_SUMMARIES }
