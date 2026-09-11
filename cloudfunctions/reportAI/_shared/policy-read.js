/**
 * policy-read — 保单读取接缝（与 writeSeam 写入接缝对称）
 *
 * 统一读取侧三件套不变量：
 *   1) safeQuery 注入 _openid（防止越权读取）
 *   2) 过滤 status='deleted' 的软删保单（默认）
 *   3) 调用 ensureStatusBatch 推算状态（默认）
 *
 * 接口：
 *   loadActivePolicies(db, familyId, openid, opts?) → Promise<policy[]>
 *     opts.ensureStatus     默认 true，调用 ensureStatusBatch 推算状态
 *     opts.includeDeleted   默认 false，是否保留 status='deleted' 的保单
 *     opts.includeCancelled 默认 true，是否保留 status='cancelled' 的保单
 *     opts.limit            默认 100
 *
 * 架构审计第 16 轮候选 #1：5+ 处散落的 filter+ensureStatus 模式集中到本接缝，
 * 与 writeSeam 形成读/写双接缝。读取不变量集中后，调用方不再自由组合 filter 链。
 */
const { safeQuery } = require('./db-helpers')
const { ensureStatusBatch } = require('./policy-status')

/** 判定"集合不存在"（CloudBase：DATABASE_COLLECTION_NOT_EXIST / ResourceNotFound） */
function _isCollectionMissing(e) {
  const code = String((e && (e.errCode || e.code)) || '')
  const msg = String((e && (e.errMsg || e.message)) || '')
  return code === 'DATABASE_COLLECTION_NOT_EXIST' || /collection.?not.?exist|ResourceNotFound/i.test(msg)
}

async function loadActivePolicies(db, familyId, openid, opts = {}) {
  const {
    ensureStatus = true,
    includeDeleted = false,
    includeCancelled = true,
    limit = 100
  } = opts
  // 2026-09-11 修复：原实现 `.catch(() => ({ data: [] }))` 把查询失败伪装成"该家庭没有保单"——
  // 与"reports 集合不存在 → 归档静默失效"完全同一模式：调用方无从感知，会基于空数据继续生成
  // 报告 / PDF / 对话上下文，产出**缺全部保单却无任何提示**的内容（本文件经 sync 分发到
  // reportAI / conversationAI / dataQuery / reportPdf，影响面覆盖全部 AI 与导出链路）。
  // 保单是核心数据：读取失败必须向上抛出，由调用方决定报错或降级——宁可失败，不要错误内容。
  let res
  try {
    res = await safeQuery(db, 'policies', { family_id: familyId }, openid, { limit })
  } catch (e) {
    // 集合尚未创建（全新环境/新用户）→ 语义上就是"暂无保单"，属合理降级，不阻断主流程
    if (_isCollectionMissing(e)) {
      console.warn('[policy-read] policies 集合不存在，按无保单处理（familyId=' + familyId + '）')
      return []
    }
    // 其余错误（网络/权限/超时）必须上抛：保单是核心数据，宁可失败也不要生成缺数据的报告
    console.error('[policy-read] loadActivePolicies 查询失败（familyId=' + familyId + '）:', (e && e.message) || e)
    throw e
  }
  let policies = res.data || []
  if (!includeDeleted) {
    policies = policies.filter(p => p.status !== 'deleted')
  }
  if (!includeCancelled) {
    policies = policies.filter(p => p.status !== 'cancelled')
  }
  if (ensureStatus) {
    policies = ensureStatusBatch(policies)
  }
  return policies
}

module.exports = { loadActivePolicies }
