/**
 * db-helpers — 读取侧 _openid 注入 + families/agents 专用读写
 *
 * v2：写入原语（safeWrite/safeUpdate/safeUpdateMany）收编进 writeSeam，
 *     本文件仅保留 safeQuery（读路径无 writeSeam 等价）和 families/agents 专用封装。
 *     updateFamily/deleteFamily 改为经 writeSeam 的 silentUpdateWhere/silentRemoveWhere，
 *     保证 _openid 注入 + updated_at 不变量统一由 writeSeam 维护。
 *     不含 agent_logs（已由 conversationAI postProcess 统一记录）
 *
 * 架构审计第 17 轮候选 #1：新增 agents 读取接缝（loadAgentByOpenid/loadAgentByPhone），
 *   消除 login/index.js 裸 db.collection('agents').where().get()，
 *   agents 表无 family_id，_openid 即所有权字段，直接作为 where 条件。
 */
const { writeSeam } = require('./writeSeam')

async function safeQuery(db, collection, where, openid, opts = {}) {
  let q = db.collection(collection).where({ ...where, _openid: openid })
  if (opts.orderBy) q = q.orderBy(opts.orderBy[0], opts.orderBy[1])
  if (opts.limit) q = q.limit(opts.limit)
  return q.get()
}

/**
 * 全量查询（自动分页）— 2026-09-10 新增
 *
 * 背景：CloudBase 服务端单次 get 上限 100 条，超出部分被**静默截断**。
 * 2026-09-09 报告缺保障事故的根因之一就是 v2-context 查 facts 未分页（118 条只读到 100 条）。
 * 凡"期望取全量"的业务查询都应走本函数，而不是写一个更大的 limit（limit 只是把截断点后移）。
 *
 * @param {object} db
 * @param {string} collection
 * @param {object} where
 * @param {string} openid
 * @param {object} [opts] { pageSize=100, maxPages=20, orderBy=[field, 'asc'|'desc'] }
 * @returns {Promise<{data: array, truncated: boolean}>} truncated=true 表示达页数上限仍有数据
 */
async function safeQueryAll(db, collection, where, openid, opts = {}) {
  const pageSize = opts.pageSize || 100
  const maxPages = opts.maxPages || 20
  const all = []
  // 2026-09-22 全面审计（数据读取侧 P2）：原实现把"某页查询失败"与"数据到此为止"混为一谈——
  // catch 返回 {data:[]} → `rows.length < pageSize` 直接判定结束 → 调用方拿到**静默缺行**的数据，
  // 且 truncated:false 谎报"完整"。改为记下失败页：truncated 置 true（语义即"结果不完整"）
  // 并回传 failedPages，供调用方决定降级或报错。
  const failedPages = []
  for (let p = 0; p < maxPages; p++) {
    // 审计 #15：skip 翻页必须带稳定排序，否则页间顺序变化会漏读/重复；默认按 _id 升序（单调）
    const ob = opts.orderBy || ['_id', 'asc']
    const q = db.collection(collection).where({ ...where, _openid: openid }).orderBy(ob[0], ob[1]).skip(p * pageSize).limit(pageSize)
    let pageFailed = false
    const r = await q.get().catch(e => {
      console.error('[db-helpers] safeQueryAll ' + collection + ' 第' + (p + 1) + '页失败:', (e && e.message) || e)
      failedPages.push(p + 1)
      pageFailed = true
      return { data: [] }
    })
    const rows = r.data || []
    all.push(...rows)
    // 失败页的空数组是错误产物，不是数据边界 → 不能据此判定结束
    if (pageFailed) break
    if (rows.length < pageSize) return { data: all, truncated: false, failedPages: [] }
  }
  if (failedPages.length) return { data: all, truncated: true, failedPages }
  console.warn('[db-helpers] safeQueryAll ' + collection + ' 达到 ' + maxPages + ' 页上限，结果可能不完整')
  return { data: all, truncated: true, failedPages: [] }
}

// 候选 4：families 单一读取缝，集中注入 _openid，替代 handlers 散落的
// db.collection('families').where({ _id, _openid }).limit(1).get()
async function getFamily(db, familyId, openid) {
  // 2026-09-10：catch 补日志——原静默吞错让 DB 异常与"记录不存在"返回同一结果（null），
  // 上层据此报 404「客户不存在」，用户会以为档案被删（实际只是查询失败）
  const res = await safeQuery(db, 'families', { _id: familyId }, openid, { limit: 1 })
    .catch(e => { console.error('[db-helpers] getFamily 查询失败:', (e && e.message) || e); return { data: [] } })
  return (res.data && res.data[0]) || null
}

/** families 文档更新（带 _openid 校验 + updated_at，经 writeSeam silent 变体） */
async function updateFamily(db, familyId, openid, data) {
  try {
    // 无 familyId 时不触发钩子（与原语义一致）；带 updated_at 由 writeSeam 自动附加
    const ws = writeSeam(db, openid, null)
    const updated = await ws.silentUpdateWhere('families', { _id: familyId }, data)
    return { code: 200, data: { updated } }
  } catch (e) { console.error('[db-helpers] updateFamily 失败:', e.message); return { code: 500, msg: '更新失败' } }
}

/** families 文档删除（带 _openid 校验，经 writeSeam silent 变体） */
async function deleteFamily(db, familyId, openid) {
  try {
    const ws = writeSeam(db, openid, null)
    await ws.silentRemoveWhere('families', { _id: familyId })
    return { code: 200 }
  } catch (e) { console.error('[db-helpers] deleteFamily 失败:', e.message); return { code: 500, msg: '删除失败' } }
}

// 2026-09-22 全面审计（死代码清理）：原 agents 读取接缝
// `loadAgentByOpenid`（devLogin 用）/ `loadAgentByPhone`（phoneLogin 用）已删除——
// 其唯一调用方随"方案 A（openid 静默登录）"一起下架（见 cloudfunctions/login/index.js 头部：
// 「原 phoneLogin/devLogin 双路径随 devMode 概念一并移除」），全仓（含测试/文档）零引用。
// 它们除是死代码外还各带一处 `.catch(() => ({ data: [] }))` —— 正是本项目已明令禁止的
// 「读失败伪装成空数据」模式；保留等于留一个随时被复用的错误样板。

module.exports = { safeQuery, safeQueryAll, getFamily, updateFamily, deleteFamily }
