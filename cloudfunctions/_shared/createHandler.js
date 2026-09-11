/**
 * createHandler — 通用云函数入口工厂
 * ponytail: 单一路由 + 错误兜底，避免每个云函数重复 boilerplate
 *
 * 用法：
 *   const handlers = require('./handlers')
 *   exports.main = createHandler(handlers, '查询')
 *
 * handler 签名：async function(db, openid, event) => { code, msg, data }
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

function createHandler(handlers, label) {
  return async function main(event, context) {
    const wxContext = cloud.getWXContext()
    // S-1 修复：wxContext.OPENID 为平台可信源，优先于 event._authOpenid（客户端可控，仅作兜底）
    // 登录链路审计 P2（纵深防御前提）：_authOpenid 兜底仅当 wxContext 无 OPENID 时生效，
    // 合法注入方只有 _shared/cross-fn-call.js（云函数间调用透传上游 openid）。当前所有函数
    // Type: Event（小程序 callFunction 恒带 wxContext.OPENID），兜底不对外暴露。
    // ⚠️ 若未来开通 HTTP 访问或云 API 直调，此兜底可被伪造冒充任意用户——须先加调用方校验。
    const openid = (wxContext && (wxContext.OPENID || wxContext.openId)) || (event && event._authOpenid)
    const db = cloud.database()
    if (!openid) return { code: 401, msg: '未登录' }
    const action = event && event.action
    const handler = handlers[action]
    if (typeof handler !== 'function') {
      return { code: 400, msg: '未知 action: ' + action }
    }
    try {
      return await handler(db, openid, event)
    } catch (e) {
      // 完整错误（message + stack）只进云函数日志；用户端 msg 保持通用文案，
      // 不暴露内部实现细节（2026-08-29 线上 500 诊断教训，与 wrapError 口径一致）
      console.error('[' + label + '] ' + action + ' 失败:', e && e.message, e && e.stack)
      return { code: 500, msg: label + '失败，请稍后重试' }
    }
  }
}

module.exports = createHandler
