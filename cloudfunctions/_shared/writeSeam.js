/**
 * writeSeam — 数据写入的单一接缝
 *
 * 集中三个写入不变量：
 *   1. _openid 注入（防越权，所有 where-based 写入必须经过此处）
 *   2. updated_at 审计字段（自动附加）
 *   3. markFamilyMutated + advanceStage 后置钩子（可选，按需附加）
 *
 * 所有 handler 必须经过此模块写入，禁止裸调 db.collection().update()/add()/remove()。
 * 这样绕过安全不变量 = 编译错误（无该 API），而非靠开发者自律。
 *
 * 用法：
 *   const ws = writeSeam(db, openid, familyId)             // 自动触发 markMutated + advanceStage
 *   await ws.updateWhere('families', { _id: familyId }, { family_name: 'new' })
 *
 *   const wsSilent = writeSeam(db, openid)                  // 不带钩子（messages/opLogs）
 *   await wsSilent.silentAdd('messages', doc)
 *
 *   // 多写入手动触发（级联删除等中间步骤用 silent 变体）
 *   await ws.silentUpdateDoc('policies', pid, { status: 'deleted' })
 *   await ws.silentUpdateWhere('facts', { subject_id: pid }, { status: 'superseded' })
 *   await ws.triggerHooks()                                  // 最后统一触发一次
 */
const { evaluateStage } = require('./domain/stageMachine')

/** 家庭数据变更脏标记：insight_stale=true + updated_at（内联自原 family-mutation.js，第 7 轮审计删除伪共享） */
function _mutationMarker(now = new Date()) {
  return { insight_stale: true, updated_at: now }
}

async function markFamilyMutated(db, familyId, openid) {
  if (!openid) { console.warn('[writeSeam] markFamilyMutated 缺少 openid，跳过（防越权）'); return }
  try {
    await db.collection('families').where({ _id: familyId, _openid: openid }).update({ data: _mutationMarker() })
  } catch (e) { console.warn('[writeSeam] markFamilyMutated 失败:', e && e.message) }
}

/**
 * 安全 add — 自动注入 _openid
 */
async function safeAdd(db, collection, data, openid) {
  if (!openid) throw new Error('[writeSeam] safeAdd 缺少 openid')
  return db.collection(collection).add({ data: { ...data, _openid: openid } })
}

/**
 * 安全 updateWhere — 自动注入 _openid 到 where，updated_at 到 data
 * @returns {number} updated count
 */
async function safeUpdateWhere(db, collection, where, data, openid) {
  if (!openid) throw new Error('[writeSeam] safeUpdateWhere 缺少 openid')
  const finalWhere = { ...where, _openid: openid }
  const finalData = { ...data, updated_at: new Date() }
  const res = await db.collection(collection).where(finalWhere).update({ data: finalData })
  return (res.stats && res.stats.updated) || 0
}

/**
 * 安全 updateDoc — 需先校验 _openid 归属
 * 用于"先查后改"场景：调用方已通过 safeQuery 拿到记录，此处只更新
 * 注：doc(id).update() 无法注入 where，调用方必须确保 docId 来自 safeQuery 结果
 */
async function safeUpdateDoc(db, collection, docId, data, openid) {
  if (!openid) throw new Error('[writeSeam] safeUpdateDoc 缺少 openid')
  // S-2 修复：doc(id).update() 无法注入 where，先校验 _openid 归属再更新
  const owner = await db.collection(collection).where({ _id: docId, _openid: openid }).get()
  if (!owner.data || !owner.data.length) throw new Error('[writeSeam] safeUpdateDoc 文档不存在或无权操作')
  const finalData = { ...data, updated_at: new Date() }
  return db.collection(collection).doc(docId).update({ data: finalData })
}

/**
 * 安全 removeWhere — 自动注入 _openid
 */
async function safeRemoveWhere(db, collection, where, openid) {
  if (!openid) throw new Error('[writeSeam] safeRemoveWhere 缺少 openid')
  return db.collection(collection).where({ ...where, _openid: openid }).remove()
}

/**
 * 安全 removeDoc — 需先校验 _openid 归属（同 safeUpdateDoc 约定）
 */
async function safeRemoveDoc(db, collection, docId, openid) {
  if (!openid) throw new Error('[writeSeam] safeRemoveDoc 缺少 openid')
  // S-2 修复：先校验 _openid 归属再删除
  const owner = await db.collection(collection).where({ _id: docId, _openid: openid }).get()
  if (!owner.data || !owner.data.length) throw new Error('[writeSeam] safeRemoveDoc 文档不存在或无权操作')
  return db.collection(collection).doc(docId).remove()
}

/**
 * engagement_stage 推进 — 集中实现，替代 handlers.js 散落的 _advanceStage
 * 读取当前家庭 + 保单数 → evaluateStage → 若变化则更新
 * fire-and-forget 语义：失败只记日志，不阻断主流程
 *
 * 内联读取 family（避免依赖 db-helpers 形成循环依赖），更新经 safeUpdateWhere。
 */
async function advanceStage(db, familyId, openid) {
  if (!familyId || !openid) return
  try {
    const fRes = await db.collection('families').where({ _id: familyId, _openid: openid }).limit(1).get().catch(() => ({ data: [] }))
    const f = (fRes.data && fRes.data[0]) || null
    if (!f) return
    const polCount = await db.collection('policies').where({ family_id: familyId, _openid: openid }).count()
    const next = evaluateStage(f, polCount.total)
    if (next !== f.engagement_stage) {
      await safeUpdateWhere(db, 'families', { _id: familyId }, { engagement_stage: next }, openid)
    }
  } catch (e) { console.error('[writeSeam] advanceStage 失败:', e.message) }
}

/**
 * 写入接缝工厂
 * @param {object} db - cloud.database()
 * @param {string} openid - 调用方 openid（必传）
 * @param {string} [familyId] - 家庭 ID（传了才触发 markMutated/advanceStage）
 * @param {object} [opts] - { markMutated: bool, advanceStageHook: bool }
 */
function writeSeam(db, openid, familyId, opts = {}) {
  const { markMutated = true, advanceStageHook = true } = opts
  const shouldHook = (markMutated || advanceStageHook) && familyId

  async function _triggerHooks() {
    if (!shouldHook) return
    if (markMutated) await markFamilyMutated(db, familyId, openid)
    // Bug-16 修复：await advanceStage 避免 fire-and-forget 在 serverless 函数返回后被冻结
    // advanceStage 内部已有 try/catch 吞错，await 不会让 _triggerHooks 抛出
    if (advanceStageHook) await advanceStage(db, familyId, openid)
  }

  return {
    // 带钩子的写入（窄化：仅保留实际被调用的 updateWhere/updateDoc/removeDoc；
    // add/removeWhere 无调用方——所有 add/remove 都用 silent 变体 + 显式 triggerHooks）
    updateWhere: async (collection, where, data) => {
      const updated = await safeUpdateWhere(db, collection, where, data, openid)
      await _triggerHooks()
      return updated
    },
    updateDoc: async (collection, docId, data) => {
      const res = await safeUpdateDoc(db, collection, docId, data, openid)
      await _triggerHooks()
      return res
    },
    removeDoc: async (collection, docId) => {
      const res = await safeRemoveDoc(db, collection, docId, openid)
      await _triggerHooks()
      return res
    },
    // 静默变体（不触发钩子，用于多写入场景的中间步骤）
    silentAdd: (collection, data) => safeAdd(db, collection, data, openid),
    silentUpdateWhere: (collection, where, data) => safeUpdateWhere(db, collection, where, data, openid),
    silentUpdateDoc: (collection, docId, data) => safeUpdateDoc(db, collection, docId, data, openid),
    silentRemoveWhere: (collection, where) => safeRemoveWhere(db, collection, where, openid),
    silentRemoveDoc: (collection, docId) => safeRemoveDoc(db, collection, docId, openid),
    // 批量操作（CloudBase 单次 remove/update 有上限，内部循环分批；不触发钩子）
    // 失败时返回 0（与原 .catch(() => 0) 语义一致），让 batchTx 正确区分"删 0 条"vs"步骤异常"
    batchRemove: async (collection, where, batchSize = 100) => {
      try {
        let deleted = 0, hasMore = true
        while (hasMore) {
          const res = await db.collection(collection).where({ ...where, _openid: openid }).limit(batchSize).get()
          if (!res.data || res.data.length === 0) { hasMore = false; break }
          const results = await Promise.all(res.data.map(d =>
            db.collection(collection).doc(d._id).remove()
              .then(() => true)
              .catch(e => { console.error('[writeSeam] batchRemove 单文档失败:', e.message); return false })
          ))
          const actuallyDeleted = results.filter(Boolean).length
          deleted += actuallyDeleted
          // 全批失败：文档未减少，继续循环会查到同样的数据 → 死循环，终止
          if (actuallyDeleted === 0) {
            console.error('[writeSeam] batchRemove 本批全部失败，终止避免死循环:', collection)
            hasMore = false; break
          }
          if (res.data.length < batchSize) hasMore = false
        }
        return deleted
      } catch (e) {
        console.error('[writeSeam] batchRemove 失败:', collection, e.message)
        return 0
      }
    },
    batchSupersede: async (collection, where) => {
      const res = await db.collection(collection).where({ ...where, _openid: openid }).update({ data: { status: 'superseded', updated_at: new Date() } }).catch(e => { console.error('[writeSeam] batchSupersede 失败:', e.message); return { stats: { updated: 0 } } })
      return (res.stats && res.stats.updated) || 0
    },
    /**
     * 批量事务（架构审计第 6 轮候选 5）：并发执行多步写入，累计错误返回 partial 状态
     * 不真正回滚（CloudBase 多集合不支持），但让调用方显式感知部分失败
     * @param {Array<{name: string, exec: () => Promise<any>}>} steps
     * @returns {Promise<{completed: number, failed: number, errors: Array<{step, error}>, results: any[]}>}
     */
    batchTx: async (steps) => {
      const results = await Promise.all(steps.map(async (s) => {
        try {
          const r = await s.exec()
          return { ok: true, result: r }
        } catch (e) {
          return { ok: false, error: e.message || String(e) }
        }
      }))
      const errors = []
      const retResults = []
      let completed = 0, failed = 0
      for (let i = 0; i < steps.length; i++) {
        const r = results[i]
        if (r.ok) { completed++; retResults.push(r.result) }
        else { failed++; errors.push({ step: steps[i].name, error: r.error }); retResults.push(null) }
      }
      return { completed, failed, errors, results: retResults }
    },
    // 手动触发钩子（多写入场景的最后一步）
    triggerHooks: _triggerHooks
  }
}

module.exports = {
  writeSeam,
  advanceStage,
  markFamilyMutated
}
