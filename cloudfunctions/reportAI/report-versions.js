/**
 * report-versions.js — 报告版本归档与清理
 *
 * 设计动机：exports.main 中原本混合了"版本归档 + 清理超出保留数的旧版本"
 * 共 27 行副作用代码。抽出为独立模块后，exports.main 只需声明"归档上一版"
 * 这一业务意图，版本仓库的内部实现（写入 reports 集合、按 version_at 倒序保留 N 版）
 * 都内聚于此。
 *
 * 接口契约：
 *   archivePrevious(db, { familyId, openid, prevFamily, keepVersions, now }) → Promise<void>
 *     - 若 prevFamily 无 last_portrait/last_review/last_plan → 跳过（无上一版可归档）
 *     - 否则写入 reports 集合，并清理超出 keepVersions 的旧版本
 *     - 任何异常仅 console.error，不抛出（归档失败不阻塞主流程）
 */

const { toReadReport } = require('./_shared/report-fields')

const REPORTS_COL = 'reports'

/** 判定"集合不存在"错误（CloudBase：DATABASE_COLLECTION_NOT_EXIST / ResourceNotFound） */
function _isCollectionMissing(e) {
  const code = String((e && (e.errCode || e.code)) || '')
  const msg = String((e && (e.errMsg || e.message)) || '')
  return code === 'DATABASE_COLLECTION_NOT_EXIST' || /collection.?not.?exist|ResourceNotFound|集合不存在/i.test(msg)
}

/**
 * 确保集合存在后写入（2026-09-11 修复线上静默失效）：
 * 线上 reports 集合从未被创建 → 每次归档 add 都抛 ResourceNotFound，被调用方 catch 吞掉 →
 * 「报告历史版本」自上线起从未可用，且云函数日志 CLI 不可读 → 长期无人发现。
 * 命中"集合不存在"时自动 createCollection 并重试一次。
 */
async function _addWithCollectionEnsure(db, collection, data) {
  try {
    return await db.collection(collection).add({ data })
  } catch (e) {
    if (!_isCollectionMissing(e) || typeof db.createCollection !== 'function') throw e
    try {
      await db.createCollection(collection)
      console.log('[report-versions] 集合不存在，已自动创建:', collection)
    } catch (ce) {
      // 并发下两个请求同时创建，后者会收到"已存在"错误——忽略即可
      if (!/exist/i.test(String((ce && (ce.errMsg || ce.message)) || ''))) throw ce
    }
    return await db.collection(collection).add({ data })
  }
}

/**
 * 归档上一版报告到 reports 集合，并清理超出保留数的旧版本
 * @param {object} db - cloud.database()
 * @param {object} args
 * @param {string} args.familyId
 * @param {string} args.openid
 * @param {object} args.prevFamily - 上一版完整 family 记录（含 last_* 字段）
 * @param {number} args.keepVersions - 保留的版本数（如 3）
 * @param {Date} args.now - 当前时间戳
 */
async function archivePrevious(db, { familyId, openid, prevFamily, keepVersions, now }) {
  // S3-7 修复：prevFamily 可能为 null（family 被并发删除或 DB 异常时 loadFamilyView 返回 null）
  // 原实现直接读 prevFamily.last_portrait 会抛 TypeError，被外层 catch 捕获后 AI 报告整体丢失
  if (!prevFamily) return
  const hasPrev = prevFamily.last_portrait || prevFamily.last_review || prevFamily.last_plan
  if (!hasPrev) return

  try {
    await _addWithCollectionEnsure(db, REPORTS_COL, Object.assign(toReadReport(prevFamily), {
      family_id: familyId,
      _openid: openid,
      version_at: prevFamily.last_analysis_at || prevFamily.updated_at || now,
      completeness_score: prevFamily.completeness_score || 0,
      saved_at: now
    }))

    // 清理超出保留数的旧版本：按 version_at 倒序，跳过前 keepVersions 条，删除其余
    const stale = await db.collection(REPORTS_COL)
      .where({ family_id: familyId, _openid: openid })
      .orderBy('version_at', 'desc')
      .skip(keepVersions)
      .limit(50)
      .get()
    if (stale.data && stale.data.length > 0) {
      await Promise.all(stale.data.map(v =>
        db.collection(REPORTS_COL).doc(v._id).remove().catch(() => 0)
      ))
    }
  } catch (e) {
    console.error('[report-versions] 版本归档失败:', e.message)
    // 2026-09-11：不再完全静默——本次线上问题的根因正是"仅 console.error 而云函数日志 CLI 不可读"，
    // 归档失效长期无人发现。落 agent_logs 使其可观测（写日志失败不阻断主流程）。
    try {
      await require('./_shared/logSeam').logAI(db, {
        openid, familyId, action: 'report_archive_fail', status: 'fail',
        error: { message: (e && (e.message || e.errMsg)) || '' }
      })
    } catch (_) { /* 日志失败不阻断 */ }
  }
}

module.exports = { archivePrevious }
