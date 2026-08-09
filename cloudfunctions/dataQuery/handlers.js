/**
 * dataQuery handlers — 聚合入口（thin re-export）
 *
 * 由 index.js 通过 createHandler(handlers, '查询') 路由调用。
 * 实际处理函数按领域拆分到 4 个模块（架构审计第 10 轮：对齐 dataWrite 第 8 轮拆分模式）：
 *   - family-list.js     家庭列表（listFamilies / searchFamilies）
 *   - family-detail.js   家庭详情（getFamilyDetail）
 *   - message-query.js   消息查询（queryMessages）
 *   - entity-query.js    实体查询（queryPolicies / queryMembers / queryFacts）
 *
 * 函数签名: (db, openid, event) => { code, msg, data? }
 *
 * 注意：getFamilyDetail 在对外 action 名为 getFamily（与前端契约一致）。
 */
const familyList = require('./family-list')
const familyDetail = require('./family-detail')
const messageQuery = require('./message-query')
const entityQuery = require('./entity-query')

module.exports = {
  // family-list
  listFamilies: familyList.listFamilies,
  searchFamilies: familyList.searchFamilies,

  // family-detail
  getFamily: familyDetail.getFamilyDetail,

  // message-query
  queryMessages: messageQuery.queryMessages,

  // entity-query
  queryPolicies: entityQuery.queryPolicies,
  queryMembers: entityQuery.queryMembers,
  queryFacts: entityQuery.queryFacts,
  queryMemberProfile: entityQuery.queryMemberProfile
}
