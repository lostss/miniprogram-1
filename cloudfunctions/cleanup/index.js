const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// S1-1 修复：cleanup 必须鉴权 + _openid 过滤 + 环境守卫
// 防止任何调用方清空全部用户的全部数据
// 日志审计 #5 + 守卫加固：
//   - mode=clear（默认）：开发环境全清（显式 NODE_ENV=development，修复原 `!== 'production'` 缺失即放行 bug）
//   - mode=prune：生产 TTL 清理（定时任务调用，无 openid，仅限 NODE_ENV=production，按保留期删旧日志）
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext && (wxContext.OPENID || wxContext.openId)
  const NODE_ENV = process.env.NODE_ENV || ''
  const mode = event.mode || 'clear'

  // 无 openid = 仅定时触发器调用（云端定时事件无用户上下文）→ 生产 TTL prune。
  // 越权审计修复：原 `mode==='prune' || !openid` 让任意登录用户传 mode:'prune' 即可删全环境日志，
  // 且 retentionDays 无下限（负数 → cutoff = now + 100 天 → 命中全表）。现严格限定无 openid 定时调用 + 保留期夹 [1,365]。
  if (!openid) {
    if (NODE_ENV !== 'production') return { code: 401, msg: '仅限生产环境定时任务调用' }
    const retentionDays = Math.max(1, Math.min(parseInt(event.retentionDays, 10) || 90, 365))
    return await pruneLogs(retentionDays)
  }
  // 已登录用户：prune（全环境日志清理）一律拒绝，只能走下方本人数据全清（且限 development）
  if (mode === 'prune') return { code: 403, msg: 'prune 仅限定时任务调用' }

  // 全清（开发调试）：需 openid + 显式 development
  const IS_DEV = NODE_ENV === 'development'
  if (!IS_DEV) return { code: 403, msg: '全清仅限开发环境（需 NODE_ENV=development）' }

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

// TTL 清理：按保留期删除 agent_logs（timestamp）/operation_logs（created_at）旧记录
// R3v2 审计 #8：agent_logs 时间字段是 timestamp（logSeam.js），operation_logs 是 created_at，
// 原统一用 created_at 过滤导致 agent_logs 永不匹配 → 永清不掉；现按集合区分时间字段
async function pruneLogs(retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000)
  const _ = db.command
  const results = []
  const TTL_COLS = [
    { name: 'agent_logs', timeField: 'timestamp' },
    { name: 'operation_logs', timeField: 'created_at' },
    // 2026-09-10 新增：facts 历史版本清理。
    // superseded 是 versioned 策略的产物（每次改保单会重写全部属性 → 每轮约 +10 条），
    // 无清理机制会持续膨胀（实测单家庭已 227 条，其中 109 条历史版本），
    // 并推高"单次 get 超 100 条被平台静默截断"的风险（2026-09-09 报告缺保障事故同类根因）。
    // 只删 status=superseded（active 绝不触碰），且仅删超保留期的，近期版本链保留供审计追溯。
    { name: 'facts', timeField: 'created_at', extraWhere: { status: 'superseded' } }
  ]
  for (const { name, timeField, extraWhere } of TTL_COLS) {
    let total = 0
    try {
      // 分批删除（服务端单次上限，循环直到删尽）
      for (let i = 0; i < 100; i++) {
        const where = Object.assign({}, extraWhere || {})
        where[timeField] = _.lt(cutoff)
        const r = await db.collection(name).where(where).remove()
        const n = r.stats ? r.stats.removed : (r.removed || 0)
        total += n
        if (n === 0) break
      }
      results.push({ collection: name, deleted: total })
    } catch (e) {
      results.push({ collection: name, error: e.message })
    }
  }
  return { code: 200, results }
}
