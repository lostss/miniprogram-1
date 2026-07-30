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
    const openid = (event && event._authOpenid) || (wxContext && (wxContext.OPENID || wxContext.openId))
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
      console.error('[' + label + '] ' + action + ' 失败:', e && e.message, e && e.stack)
      return { code: 500, msg: (e && e.message) || (label + '失败') }
    }
  }
}

module.exports = createHandler
