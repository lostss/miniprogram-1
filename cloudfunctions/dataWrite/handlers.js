/**
 * dataWrite handlers — 聚合入口（thin re-export）
 *
 * 由 index.js 通过 createHandler(handlers, '写入') 路由调用。
 * 实际处理函数按领域拆分到 5 个模块：
 *   - family-write.js   家庭 CRUD + 阶段设置
 *   - member-write.js   成员操作（recordField / updateMember / deleteMember）
 *   - fact-write.js     事实写入（addFact / updateFactConfidence / deleteFact）
 *   - policy-write.js   保单操作 + 现价表
 *   - message-write.js  消息 / 日志 / 画像提交
 *
 * 函数签名: (db, openid, event) => { code, msg, data? }
 *
 * 注意：本地 updateFamilyHandler / deleteFamilyHandler 重命名为对外 action 名
 *       updateFamily / deleteFamily，避免与 db-helpers 同名工具冲突。
 */
const family = require('./family-write')
const member = require('./member-write')
const fact = require('./fact-write')
const policy = require('./policy-write')
const message = require('./message-write')
// 对话 agentic 单通道：upsertMember/updateFinances 由前端 tools fn 路由到本网关（原 conversationAI 进程内执行，现统一走 dataWrite）
const memberRepo = require('./_shared/memberRepo')

module.exports = {
  // family-write
  createFamily: family.createFamily,
  updateFamily: family.updateFamilyHandler,
  deleteFamily: family.deleteFamilyHandler,
  setStage: family.setStage,

  // member-write（agentic 对话工具路由）
  upsertMember: (db, openid, event) => memberRepo.upsertMember(db, event.familyId, openid, { ...event, confirmOnConflict: true }),
  updateFinances: (db, openid, event) => memberRepo.upsertFinances(db, event.familyId, openid, event),

  // member-write
  recordField: member.recordField,
  updateMember: member.updateMember,
  deleteMember: member.deleteMember,

  // fact-write
  addFact: fact.addFact,
  updateFactConfidence: fact.updateFactConfidence,
  deleteFact: fact.deleteFact,

  // policy-write
  writePolicy: policy.writePolicy,
  writePoliciesBatch: policy.writePoliciesBatch,
  deletePolicy: policy.deletePolicy,
  updatePolicy: policy.updatePolicy,
  changePolicyStatus: policy.changePolicyStatus,
  writeCashValue: policy.writeCashValue,

  // message-write
  writeMessage: message.writeMessage,
  writeOpLog: message.writeOpLog,
  submitProfiling: message.submitProfiling
}
