/** apiClient.js — 统一 API 路由（纯云函数） */
const callCloud = require('./callCloud.js')

const DIRECT_FN = {
  // login
  login:                  ['login', null],

  // dataQuery
  queryMessages:          ['dataQuery', { action: 'queryMessages' }],
  getFamily:              ['dataQuery', { action: 'getFamily' }],
  listFamilies:           ['dataQuery', { action: 'listFamilies' }],
  searchFamilies:         ['dataQuery', { action: 'searchFamilies' }],
  // queryLogs 已下线（零调用，见清理审计）
  // agentic 工具：查询（前端 streamText tools fn 路由）
  queryPolicies:          ['dataQuery', { action: 'queryPolicies' }],
  queryMembers:           ['dataQuery', { action: 'queryMembers' }],
  queryFacts:             ['dataQuery', { action: 'queryFacts' }],

  // dataWrite
  recordField:            ['dataWrite', { action: 'recordField' }],
  writePoliciesBatch:     ['dataWrite', { action: 'writePoliciesBatch' }],
  writeCashValue:         ['dataWrite', { action: 'writeCashValue' }],
  updateFamily:           ['dataWrite', { action: 'updateFamily' }],
  updatePolicy:           ['dataWrite', { action: 'updatePolicy' }],
  updateMember:           ['dataWrite', { action: 'updateMember' }],
  createFamily:           ['dataWrite', { action: 'createFamily' }],
  deleteFamily:           ['dataWrite', { action: 'deleteFamily' }],
  writeMessage:           ['dataWrite', { action: 'writeMessage' }],
  writeOpLog:             ['dataWrite', { action: 'writeOpLog' }],
  // agentic 工具：写（前端 streamText tools fn 路由，统一走 dataWrite 网关）
  upsertMember:           ['dataWrite', { action: 'upsertMember' }],
  updateFinances:         ['dataWrite', { action: 'updateFinances' }],
  writePolicy:            ['dataWrite', { action: 'writePolicy' }],
  deletePolicy:           ['dataWrite', { action: 'deletePolicy' }],
  deleteMember:           ['dataWrite', { action: 'deleteMember' }],
  addFact:                ['dataWrite', { action: 'addFact' }],
  deleteFact:             ['dataWrite', { action: 'deleteFact' }],
  updateFactConfidence:   ['dataWrite', { action: 'updateFactConfidence' }],

  // reportAI
  generateReport:         ['reportAI', null],

  // ocrService
  ocrOnly:                ['ocrService', { action: 'ocrOnly' }],
  aiExtractBatch:         ['ocrService', { action: 'aiExtractBatch' }],
  aiExtractParallel:      ['ocrService', { action: 'aiExtractParallel' }],

  // conversationAI
  conversationAI:         ['conversationAI', null],
}

// 归一化返回契约：{ ok, code, msg, data }，消除调用方重复解包 res.result
async function apiCall(action, params = {}, opts = {}) {
  const df = DIRECT_FN[action]
  if (!df) {
    console.warn('[apiClient] 未知 action:', action)
    throw new Error('未知 API: ' + action)
  }
  const [name, base] = df
  const data = base ? { ...base, ...params } : params
  // 日志审计 #1：requestId 透传（OCR 会话等一次性操作的 trace 串联）
  if (opts.requestId) data._reqId = opts.requestId
  // 网络审计：写操作强制 retries:0（超时/网络 fail 重发 = 已入库数据双写）。
  // 读操作保持默认重试（弱网可容忍）；调用方显式传 opts.retries 优先。
  if (opts.retries === undefined && /^(create|update|delete|write|record)/.test(action)) {
    opts.retries = 0
  }
  const raw = await callCloud(name, data, opts)
  const r = raw && raw.result
  // 日志审计 #3：业务失败（服务端返回非 200）fire-and-forget 上报，不阻断主流程
  // 跳过 writeOpLog 自身（防止失败递归上报）
  if (r && r.code && r.code !== 200 && action !== 'writeOpLog') {
    try {
      callCloud('dataWrite', {
        action: 'writeOpLog',
        logAction: 'api_business_error',
        result: { status: 'error', summary: action + ' 失败(' + r.code + ')', error: String(r.msg || '') }
      }, { retries: 0 }).catch(function() {})
    } catch (e) {}
  }
  return {
    ok: !!(r && r.code === 200),
    code: (r && r.code) || 500,
    msg: (r && r.msg) || '请求失败',
    data: (r && r.data) || null,
    // R3v2 审计 #7：透传节流标志（reportAI 节流命中返回顶层 throttled:true，归一化不丢）
    throttled: !!(r && r.throttled),
    // agentic 确认：透传 409 确认卡数据（工具 fn 需据此弹确认）
    needsConfirm: !!(r && r.needsConfirm),
    confirmType: (r && r.confirmType) || '',
    pendingId: (r && r.pendingId) || '',
    target: (r && r.target) || ''
  }
}

module.exports = apiCall
