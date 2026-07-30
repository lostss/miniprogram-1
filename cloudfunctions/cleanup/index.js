const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async () => {
  const cols = ['agent_logs', 'messages', 'operation_logs', 'families', 'policies', 'facts', 'members', 'insights', 'finances', 'reports', 'policy_cash_values']
  const results = []
  for (const c of cols) {
    try {
      const _ = db.command
      const r = await db.collection(c).where({ _id: _.exists(true) }).remove()
      results.push({ collection: c, deleted: r.stats ? r.stats.removed : (r.removed || 0) })
    } catch (e) {
      results.push({ collection: c, error: e.message })
    }
  }
  return { code: 200, results }
}
