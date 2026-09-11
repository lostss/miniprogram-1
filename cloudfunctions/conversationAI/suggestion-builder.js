/**
 * suggestion-builder — 工具结果 → 确认卡片建议（纯函数）
 *
 * 接口契约：
 *   buildSuggestions(toolResults) → { suggestions: string[], pending_confirms: object[] }
 *   buildWriteConfirms(confirmTools) → { suggestions: string[], pending_confirms: object[] }   （单通道 v10）
 *
 * 规则：
 *   1) addFact 返回 factId 且 confidence<0.6 → 生成 CONFIRM 卡片（升级置信度）
 *   2) upsertMember 返回 needsConfirm → 生成 CONFIRM/KEEP 卡片对（覆盖 vs 保留原值）
 *   3) 任意工具返回 needsConfirm + confirmType='delete' → 生成 CONFIRM/KEEP 卡片对
 *   4) 单通道 v10：写入类工具（upsertMember/updateFinances/addPolicy/updatePolicy/createFamily）
 *      在 function calling 阶段直接构造 write_confirm 确认卡（不 dispatch），确认后由 confirm-handler 执行
 */

// 工具名 → 参数中文摘要（确认卡展示用；只挑人可读的关键字段）
const ARG_SUMMARIZERS = {
  upsertMember: (a) => {
    const d = a.data || {}
    const parts = []
    if (a.memberName || d.name) parts.push('成员:' + (a.memberName || d.name))
    if (d.role) parts.push('角色:' + d.role)
    if (d.age != null) parts.push('年龄:' + d.age + '岁')
    if (d.occupation) parts.push('职业:' + d.occupation)
    if (d.health) parts.push('健康:' + d.health)
    if (d.income != null) parts.push('年收入:' + d.income + '万')
    if (d.birth_date) parts.push('出生:' + d.birth_date)
    return parts.join('，') || '更新成员信息'
  },
  updateFinances: (a) => {
    const parts = []
    if (a.annual_income != null) parts.push('年收入:' + Number(a.annual_income).toLocaleString() + '元')
    if (a.total_debt != null) parts.push('总负债:' + Number(a.total_debt).toLocaleString() + '元')
    if (a.fixed_annual_expense != null) parts.push('年固定支出:' + Number(a.fixed_annual_expense).toLocaleString() + '元')
    if (a.debt_type) parts.push('负债类型:' + a.debt_type)
    return parts.join('，') || '更新家庭财务'
  },
  addPolicy: (a) => {
    const parts = []
    if (a.product_name) parts.push('产品:' + a.product_name)
    if (a.insurance_category) parts.push('险种:' + a.insurance_category)
    if (a.sum_assured != null) parts.push('保额:' + Number(a.sum_assured).toLocaleString() + '元')
    if (a.annual_premium != null) parts.push('年缴:' + Number(a.annual_premium).toLocaleString() + '元')
    if (a.insured_name) parts.push('被保人:' + a.insured_name)
    if (a.effective_date) parts.push('生效:' + a.effective_date)
    return parts.join('，') || '新增保单'
  },
  updatePolicy: (a) => {
    const d = a.data || {}
    const parts = []
    if (a.product_name) parts.push('保单:' + a.product_name)
    else if (a.policyId) parts.push('保单ID:' + a.policyId)
    const fMap = { sum_assured: '保额', annual_premium: '年缴', insurer: '公司', effective_date: '生效日', status: '状态', insurance_period: '保障期间', payment_period: '缴费期限' }
    for (const k of Object.keys(fMap)) {
      if (d[k] != null && d[k] !== '') parts.push(fMap[k] + '→' + d[k])
    }
    return parts.join('，') || '修改保单'
  },
  createFamily: (a) => {
    const parts = []
    if (a.family_name) parts.push('家庭:' + a.family_name)
    if (Array.isArray(a.members) && a.members.length) parts.push('成员:' + a.members.map(m => m.name + (m.role ? '(' + m.role + ')' : '')).join('、'))
    return parts.join('，') || '新建家庭档案'
  }
}

function _summarizeArgs(toolName, args) {
  const fn = ARG_SUMMARIZERS[toolName]
  return (fn && fn(args || {})) || '写入操作'
}

// 确认卡目标文案（如「成员 张三」/「保单 康宁」）
function _confirmTarget(toolName, args) {
  if (toolName === 'upsertMember') return '成员 ' + ((args && (args.memberName || (args.data && args.data.name))) || '')
  if (toolName === 'updateFinances') return '家庭财务'
  if (toolName === 'addPolicy') return '保单 ' + ((args && args.product_name) || '')
  if (toolName === 'updatePolicy') return '保单 ' + ((args && args.product_name) || (args && args.policyId) || '')
  if (toolName === 'createFamily') return '新家庭档案'
  return '写入操作'
}

/**
 * 单通道 v10：写入类工具确认卡构造（纯函数，不执行工具）
 * @param {Array} confirmTools 待确认工具调用 [{toolName, args}]
 * @returns {{suggestions: string[], pending_confirms: object[]}}
 */
function buildWriteConfirms(confirmTools) {
  const suggestions = []
  const pending_confirms = []

  for (const ct of (confirmTools || [])) {
    const toolName = ct.toolName
    const args = (ct.args && typeof ct.args === 'object') ? ct.args : {}
    const summary = _summarizeArgs(toolName, args)
    const target = _confirmTarget(toolName, args)
    const pendingId = 'write_' + toolName + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)

    pending_confirms.push({
      pendingId, action: 'CONFIRM', type: 'write_confirm',
      toolName, payload: args, summary, target
    })
    // 确认/取消建议文案（前端确认卡按钮之外，sug-bar 也可触达）
    suggestions.push('确认写入' + (target ? ' ' + target : '') + '：' + summary.substring(0, 40))
    suggestions.push('取消')
    // KEEP 卡必须与 sug-bar 下标一一对应（index.js 按 suggestions 下标取 pending_confirms，缺位会错位）
    pending_confirms.push({
      pendingId, action: 'KEEP', type: 'write_confirm',
      toolName, target, summary
    })
  }

  return { suggestions, pending_confirms }
}

/**
 * @param {Array} toolResults 工具调用结果数组，每项形如：
 *   { toolName, toolCallId, success, result, args, error? }
 * @returns {{suggestions: string[], pending_confirms: object[]}}
 */
function buildSuggestions(toolResults) {
  const suggestions = []
  const pending_confirms = []

  for (const tr of (toolResults || [])) {
    // ② 2026-08-30：addFact 低置信度确认卡分支移除——addFact 已归入"默认执行+撤销"
    // （undo 兜底可回滚），低置信度不再弹确认卡，保持单一路径。

    // 2) 成员信息矛盾 → sug 确认选项（低置信度冲突路径；单通道写入确认走 buildWriteConfirms）
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

module.exports = { buildSuggestions, buildWriteConfirms }
