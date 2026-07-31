const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// S1-1 修复：cleanup 必须鉴权 + _openid 过滤 + 环境守卫
// 防止任何调用方清空全部用户的全部数据
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext && (wxContext.OPENID || wxContext.openId)
  if (!openid) return { code: 401, msg: '未登录' }

  // S-3 修复：环境守卫改用显式 IS_DEV 标志，避免 envId 关键字匹配失效
  const IS_DEV = process.env.NODE_ENV !== 'production'
  if (!IS_DEV) return { code: 403, msg: '仅限开发环境调用' }

  const cols = ['agent_logs', 'messages', 'operation_logs', 'families', 'policies', 'facts', 'members', 'insights', 'finances', 'reports', 'policy_cash_values']
  const results = []
  for (const c of cols) {
    try {
      const _ = db.command
      // 仅清空当前 openid 的数据，防止越权清空他人数据
      const r = await db.collection(c).where({ _id: _.exists(true), _openid: openid }).remove()
      results.push({ collection: c, deleted: r.stats ? r.stats.removed : (r.removed || 0) })
    } catch (e) {
      results.push({ collection: c, error: e.message })
    }
  }
  return { code: 200, results }
}
