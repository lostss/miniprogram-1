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

async function loadActivePolicies(db, familyId, openid, opts = {}) {
  const {
    ensureStatus = true,
    includeDeleted = false,
    includeCancelled = true,
    limit = 100
  } = opts
  const res = await safeQuery(db, 'policies', { family_id: familyId }, openid, { limit }).catch(() => ({ data: [] }))
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
