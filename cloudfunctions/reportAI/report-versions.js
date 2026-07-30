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
  const hasPrev = prevFamily.last_portrait || prevFamily.last_review || prevFamily.last_plan
  if (!hasPrev) return

  try {
    await db.collection('reports').add({
      data: Object.assign(toReadReport(prevFamily), {
        family_id: familyId,
        _openid: openid,
        version_at: prevFamily.last_analysis_at || prevFamily.updated_at || now,
        completeness_score: prevFamily.completeness_score || 0,
        saved_at: now
      })
    })

    // 清理超出保留数的旧版本：按 version_at 倒序，跳过前 keepVersions 条，删除其余
    const stale = await db.collection('reports')
      .where({ family_id: familyId, _openid: openid })
      .orderBy('version_at', 'desc')
      .skip(keepVersions)
      .limit(50)
      .get()
    if (stale.data && stale.data.length > 0) {
      await Promise.all(stale.data.map(v =>
        db.collection('reports').doc(v._id).remove().catch(() => 0)
      ))
    }
  } catch (e) {
    console.error('[report-versions] 版本归档失败:', e.message)
  }
}

module.exports = { archivePrevious }
