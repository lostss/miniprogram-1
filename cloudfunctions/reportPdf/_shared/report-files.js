/**
 * report-files — 报告 PDF 导出文件的登记与 TTL 回收（单一实现）。
 *
 * 为什么必须登记（2026-09-20 流程审计遗留项「reportPdf 孤儿文件」）：
 *   wx-server-sdk **没有列举云存储的 API** —— 已核对其类型定义，只有 uploadFile /
 *   getTempFileURL / deleteFile，而后两者都必须**先知道 fileID**。而
 *   `reports/<openid>/<familyId>_<ts>.pdf` 每次导出都是一个新文件 → 不额外记一笔，
 *   文件就永远找不回来：孤儿无限堆积，且没有任何清理路径。
 *
 * 两个能力：
 *   ① recordReportFile —— 导出成功即登记（reportPdf 调用）
 *   ② pruneReportFiles —— 定时任务按保留期回收：**先删文件、成功才删记录**（cleanup 调用）
 *
 * 不变量：
 *   - 记录必须含 _openid：云函数端写入**不会**自动注入（只有客户端调用才会）
 *   - 删文件成功才删记录；删文件失败的记录保留，下轮重试
 *   - **不要**在 deleteFamily 级联里删本集合的记录 —— 记录一消失，对应文件就成为永久孤儿
 *     （与"先删文件"是同一条约束的两面）。家庭删除后其 PDF 由 TTL 回收兜底。
 */
const COLLECTION = 'report_files'
const BATCH_LIMIT = 50  // 云存储 deleteFile 单次上限
const SCAN_LIMIT = 100  // 集合单次读取/删除上限
const MAX_ROUNDS = 10   // 单次执行最多扫 1000 条，防击穿函数 60s 时限

/**
 * 登记一份导出文件（回收索引）。
 * @returns {Promise<{ok:boolean, reason?:string, ensured?:boolean}>} 失败不抛错——登记只是回收索引，
 *          不应让"导出成功但登记失败"变成用户可见的失败。
 */
async function recordReportFile(db, { openid, familyId, fileID, filePath }) {
  if (!openid || !fileID) return { ok: false, reason: 'missing-args' }
  const data = {
    _openid: openid,
    family_id: familyId || '',
    file_id: fileID,
    file_path: filePath || '',
    created_at: new Date()
  }
  const add = () => db.collection(COLLECTION).add({ data })
  try {
    await add()
    return { ok: true }
  } catch (e) {
    const msg = (e && e.message) || String(e)
    // 集合不存在 → 建一次再重试。沿用 report-versions 的线上教训：集合缺失 + 异常被吞
    // = 「功能自上线起从未可用」且长期无人发现。
    if (!/not exist|ResourceNotFound|COLLECTION_NOT_EXIST/i.test(msg) || typeof db.createCollection !== 'function') {
      console.error('[report-files] 登记失败（回收索引缺失，该文件将成孤儿）:', msg)
      return { ok: false, reason: 'error' }
    }
    try {
      await db.createCollection(COLLECTION)
      await add()
      return { ok: true, ensured: true }
    } catch (e2) {
      console.error('[report-files] 建集合后登记仍失败:', (e2 && e2.message) || e2)
      return { ok: false, reason: 'error' }
    }
  }
}

/**
 * 单个文件的删除结果判定：status=0 成功；文件本就不存在也算成功（目标状态已达成）
 *
 * ⚠️ 2026-09-28 更正（注释曾与代码相反，实测已证）：原注释称「status 缺失视为成功 … 避免记录永远
 * 删不掉」，把 `item.status === undefined` 当成"响应里没有这一项"的兜底。但上一行的 `if (!item)`
 * 已经把"整项缺失"拦成 false —— 走到这里的 item **一定存在**，`status === undefined` 只可能是
 * "deleteFile 返回了该文件但没带 status"（实测：空响应 → filesFailed=1 → 记录保留、下轮重试）。
 * 即**真实行为是"不确定就不删记录"**（保守：文件若还在，下轮还会再试），这与注释宣称的相反。
 * 保留该保守行为（宁可多试一轮，也不要留下永久孤儿文件+已清记录），仅把注释改成与代码一致。
 */
function _isDeleteOk(item) {
  if (!item) return false
  const msg = String(item.errMsg || '')
  if (/not exist|NOT_EXIST|不存在/i.test(msg)) return true
  // status=0 明确成功；status 缺失（有条目但无状态码）按**未确认**处理 → 保留记录、下轮重试。
  // 注意这不是"按已删处理"：那会留下永久孤儿文件（记录没了，文件还在）。
  return item.status === 0
}

/**
 * 按保留期回收导出文件（定时任务调用）。
 * @param {object} db - 已 init 的 database 实例
 * @param {object} cloud - wx-server-sdk cloud 实例（需有 deleteFile）
 * @param {number} retentionDays - 保留期（天）
 * @param {object} [opts] - { maxRounds } 测试用
 * @returns {Promise<object>} 统计对象（供 cleanup 汇总进 results）
 */
async function pruneReportFiles(db, cloud, retentionDays, opts) {
  const _ = db.command
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000)
  const maxRounds = (opts && opts.maxRounds) || MAX_ROUNDS
  const out = { collection: COLLECTION, retentionDays: retentionDays, scanned: 0, filesDeleted: 0, recordsDeleted: 0, filesFailed: 0 }
  for (let round = 0; round < maxRounds; round++) {
    let rows
    try {
      const r = await db.collection(COLLECTION).where({ created_at: _.lt(cutoff) }).limit(SCAN_LIMIT).get()
      rows = r.data || []
    } catch (e) {
      // 集合尚不存在（从未导出过）不是错误，但按现有 pruneLogs 的约定回填 error 便于观测
      out.error = (e && e.message) || String(e)
      return out
    }
    if (!rows.length) return out
    out.scanned += rows.length

    const removableIds = []
    // 登记残缺（无 file_id）的记录：没有文件可删，直接删记录
    rows.filter(x => !x.file_id).forEach(x => removableIds.push(x._id))

    const withFile = rows.filter(x => x.file_id)
    for (let i = 0; i < withFile.length; i += BATCH_LIMIT) {
      const batch = withFile.slice(i, i + BATCH_LIMIT)
      let items = []
      try {
        const res = await cloud.deleteFile({ fileList: batch.map(x => x.file_id) })
        items = (res && res.fileList) || []
      } catch (e) {
        console.error('[report-files] deleteFile 批次失败（记录保留，下轮重试）:', (e && e.message) || e)
        out.filesFailed += batch.length
        continue
      }
      batch.forEach(function (row, idx) {
        // SDK 按入参顺序返回；缺项时按 fileID 兜底查找
        const item = items[idx] || items.filter(function (it) { return it && it.fileID === row.file_id })[0]
        if (_isDeleteOk(item)) {
          out.filesDeleted++
          removableIds.push(row._id)
        } else {
          out.filesFailed++
          console.warn('[report-files] 删除文件失败，保留记录下轮重试:', row.file_id, item && item.errMsg)
        }
      })
    }
    // 整轮无进展（全部删文件失败）→ 下轮会读到同一批，直接收工，不空转
    if (removableIds.length === 0) return out

    for (let i = 0; i < removableIds.length; i += SCAN_LIMIT) {
      const slice = removableIds.slice(i, i + SCAN_LIMIT)
      try {
        await db.collection(COLLECTION).where({ _id: _.in(slice) }).remove()
        out.recordsDeleted += slice.length
      } catch (e) {
        console.error('[report-files] 删记录失败:', (e && e.message) || e)
      }
    }
    if (rows.length < SCAN_LIMIT) return out // 已扫尽
  }
  return out
}

module.exports = { COLLECTION, recordReportFile, pruneReportFiles }
