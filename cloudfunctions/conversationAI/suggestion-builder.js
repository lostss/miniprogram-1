/**
 * suggestion-builder — 工具结果 → 确认卡片建议（纯函数）
 *
 * 接口契约：
 *   buildSuggestions(toolResults) → { suggestions: string[], pending_confirms: object[] }
 *
 * 设计动机（架构审计第 13 轮候选 #2）：
 *   原 tool-orchestration.js 内联 3 类建议生成循环（low-conf fact / member conflict / delete confirm），
 *   与 dispatch/429 退避/summary 拼接纠缠。抽出为纯函数后：
 *   - 单测只需构造 toolResults 数组，无需 mock AI 调用或缓存
 *   - tool-orchestration 聚焦"调度 + 文本组装"，suggestion 生成局部性集中于此
 *
 * 规则：
 *   1) addFact 返回 factId 且 confidence<0.6 → 生成 CONFIRM 卡片（升级置信度）
 *   2) upsertMember 返回 needsConfirm → 生成 CONFIRM/KEEP 卡片对（覆盖 vs 保留原值）
 *   3) 任意工具返回 needsConfirm + confirmType='delete' → 生成 CONFIRM/KEEP 卡片对
 */
/**
 * @param {Array} toolResults 工具调用结果数组，每项形如：
 *   { toolName, toolCallId, success, result, args, error? }
 * @returns {{suggestions: string[], pending_confirms: object[]}}
 */
function buildSuggestions(toolResults) {
  const suggestions = []
  const pending_confirms = []

  for (const tr of (toolResults || [])) {
    // 1) 低置信度事实 → sug 确认选项
    if (tr.toolName === 'addFact' && tr.result && tr.result.data && tr.result.data.factId) {
      const conf = Number(tr.args && tr.args.confidence)
      if (!isNaN(conf) && conf < 0.6) {
        const fid = tr.result.data.factId
        const predicate = tr.args.predicate || '事实'
        const objectValue = tr.args.objectValue || ''
        const pendingId = 'fact_' + fid
        suggestions.push('确认' + predicate + '：' + objectValue.substring(0, 20))
        pending_confirms.push({ pendingId, action: 'CONFIRM', type: 'fact_confirm', factId: fid })
      }
    }

    // 2) 成员信息矛盾 → sug 确认选项
    if (tr.toolName === 'upsertMember' && tr.result && tr.result.needsConfirm) {
      const r = tr.result
      const args = tr.args || {}
      const mId = (r.data && r.data.memberId) || ''
      const pendingId = 'memcfm_' + mId + '_' + Date.now().toString(36)
      const proposed = (r.data && r.data.proposed) || args.data || {}
      const memberName = args.memberName || (args.data && args.data.name) || ''
      suggestions.push('确认覆盖' + (memberName ? '「' + memberName + '」' : ''))
      pending_confirms.push({ pendingId, action: 'CONFIRM', type: 'member_confirm', memberName, memberId: mId, proposed })
      suggestions.push('保留原值')
      pending_confirms.push({ pendingId, action: 'KEEP', type: 'member_confirm', memberName })
    }

    // 3) 删除类工具 → sug 确认选项
    if (tr.result && tr.result.needsConfirm && tr.result.confirmType === 'delete') {
      const d = tr.result
      const pendingId = 'del_' + d.toolName + '_' + Date.now().toString(36)
      suggestions.push('确认删除' + (d.target ? d.target : ''))
      pending_confirms.push({ pendingId, action: 'CONFIRM', type: 'delete_confirm', toolName: d.toolName, payload: d.payload, target: d.target })
      suggestions.push('取消')
      pending_confirms.push({ pendingId, action: 'KEEP', type: 'delete_confirm', toolName: d.toolName })
    }
  }

  return { suggestions, pending_confirms }
}

module.exports = { buildSuggestions }
