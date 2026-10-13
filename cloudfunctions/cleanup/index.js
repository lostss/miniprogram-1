const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
// 报告 PDF 导出文件的 TTL 回收（2026-09-20 复核批次 B）
const { pruneReportFiles } = require('./_shared/report-files')

// 报告 PDF 保留期（天）——与日志保留期**刻意解耦**：
// 日志要按天级追溯（默认 90 天），而导出的 PDF 是一次性快照、重生成成本极低，
// 30 天足够（且导出物含完整家庭财务画像，留存越短越好）。可经定时任务入参 reportRetentionDays 覆盖。
const PDF_RETENTION_DAYS = 30

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
    // 2026-09-28 全面审计 P2：这条闸门此前是**完全静默**的 —— 一旦 NODE_ENV 丢失（用
    // cloudbaserc.template.json 部署、控制台重部署、有人改环境变量），每次定时触发都返回一个
    // 没人读的 401，而 agent_logs / operation_logs / undo_logs / 已 supersede 的 facts / 报告 PDF
    // **永远不会被回收**；因为每次都是"成功的 no-op"，从函数自身输出里看不出任何异常。
    // 现留痕 + 把原因放进返回值，定时任务运行报告里可直接看到。
    if (NODE_ENV !== 'production') {
      const reason = '[cleanup] 定时清理被跳过：NODE_ENV=' + JSON.stringify(NODE_ENV) +
        '（需 "production"，由 cloudbaserc.json 的 cleanup.envVariables 注入；丢失则日志/PDF 永不回收）'
      console.error(reason)
      return { code: 401, msg: '仅限生产环境定时任务调用', skipped: true, reason: reason, nodeEnv: NODE_ENV }
    }
    const retentionDays = Math.max(1, Math.min(parseInt(event.retentionDays, 10) || 90, 365))
    // PDF 独立保留期：不传则用 30 天（**不能**跟随日志的 90 天默认值）
    const pdfRetentionDays = Math.max(1, Math.min(parseInt(event.reportRetentionDays, 10) || PDF_RETENTION_DAYS, 365))
    return await pruneLogs(retentionDays, pdfRetentionDays)
  }
  // 已登录用户：prune（全环境日志清理）一律拒绝，只能走下方本人数据全清（且限 development）
  if (mode === 'prune') return { code: 403, msg: 'prune 仅限定时任务调用' }

  // 全清（开发调试）：需 openid + 显式 development
  const IS_DEV = NODE_ENV === 'development'
  if (!IS_DEV) return { code: 403, msg: '全清仅限开发环境（需 NODE_ENV=development）' }

  const cols = ['agent_logs', 'messages', 'operation_logs', 'undo_logs', 'families', 'policies', 'facts', 'members', 'insights', 'finances', 'reports', 'policy_cash_values']
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
async function pruneLogs(retentionDays, pdfRetentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000)
  const _ = db.command
  const results = []
  const TTL_COLS = [
    { name: 'agent_logs', timeField: 'timestamp' },
    { name: 'operation_logs', timeField: 'created_at' },
    // 审计 #7：undo_logs 记录 5min TTL（expires_at），含 before 快照 PII，原无任何清理路径
    { name: 'undo_logs', timeField: 'expires_at' },
    // 2026-09-10 新增：facts 历史版本清理。
    // superseded 是 versioned 策略的产物（每次改保单会重写全部属性 → 每轮约 +10 条），
    // 无清理机制会持续膨胀（实测单家庭已 227 条，其中 109 条历史版本），
    // 并推高"单次 get 超 100 条被平台静默截断"的风险（2026-09-09 报告缺保障事故同类根因）。
    // 只删 status=superseded（active 绝不触碰），且仅删超保留期的，近期版本链保留供审计追溯。
    // 2026-09-11 修复：原用 created_at 做 TTL，但 superseded 是**后期 update 打上的标记**——
    // 3 年前创建、今天才作废的事实会立刻命中 created_at < cutoff 被硬删，与上方"近期版本链
    // 保留供审计追溯"的意图直接矛盾。改用 updated_at（writeSeam.safeUpdateWhere 自动写入），
    // 即"作废时刻"起算保留期才符合语义。老数据缺 updated_at 时不会被 < 选中，属安全失败。
    { name: 'facts', timeField: 'updated_at', extraWhere: { status: 'superseded' } }
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
  // 2026-09-20（复核批次 B）：报告 PDF 的云存储回收。
  // 这里**不能**复用上方 TTL_COLS 的"按集合删记录"循环——云存储文件必须按其 fileID 删除，
  // 而记录一旦先删就再也定位不到文件（永久孤儿）。故单独走"查记录 → deleteFile → 删记录"三步，
  // 且删文件失败时保留记录下轮重试。
  results.push(await pruneReportFiles(db, cloud, pdfRetentionDays || PDF_RETENTION_DAYS))
  return { code: 200, results }
}
