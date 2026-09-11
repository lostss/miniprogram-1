/** domain-writes.js — 领域写薄层（候选 5）
 * 收敛三种写入参数形状（逐字段 field/value / 嵌套 data / 整家 updateData）到具名语义，
 * 调用方不再散落字符串 action；apiClient 仍只做传输归一化 + requestId/写保护/错误上报横切。
 * writePoliciesBatch 特殊：cashValues → 后端 cash_values，超时/重试语义由调用方 opts 控制。
 */
const api = require('./apiClient')

// 逐字段改成员（后端 dataWrite.updateMember：field/value 白名单单字段写）
function saveMemberField(params) {
  return api('updateMember', params)
}

// 嵌套 data 改保单（dataWrite.updatePolicy：白名单字段 + 事实同步）
function savePolicyData(params) {
  return api('updatePolicy', params)
}

// 整家/复合覆盖（dataWrite.updateFamily.updateData：members 数组 / financial_snapshot / 顶层键）
function saveFamilyPatch(params) {
  return api('updateFamily', params)
}

// 批量写入保单（OCR 确认路径：policies + 现价表数组包；长超时 + 关自动重试防双写）
function writePoliciesBatch({ familyId, policies, cashValues }, opts) {
  return api('writePoliciesBatch', { familyId, policies, cash_values: cashValues }, opts)
}

module.exports = { saveMemberField, savePolicyData, saveFamilyPatch, writePoliciesBatch }
