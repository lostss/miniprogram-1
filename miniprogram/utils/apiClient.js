/** apiClient.js — 统一 API 路由（纯云函数） */
const callCloud = require('./callCloud.js')

const DIRECT_FN = {
  // login
  login:                  ['login', null],

  // dataQuery
  queryMessages:          ['dataQuery', { action: 'queryMessages' }],
  getFamily:              ['dataQuery', { action: 'getFamily' }],
  shareFamily:            ['dataQuery', { action: 'shareFamily' }],
  getSharedFamily:        ['dataQuery', { action: 'getSharedFamily' }],
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
  // 2026-09-11：孤儿现价表人工关联（未注册则该 action 直接抛"未知 API"，功能永远不可用）
  linkCashValue:          ['dataWrite', { action: 'linkCashValue' }],
  updateFamily:           ['dataWrite', { action: 'updateFamily' }],
  updatePolicy:           ['dataWrite', { action: 'updatePolicy' }],
  changePolicyStatus:     ['dataWrite', { action: 'changePolicyStatus' }],
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

  // reportPdf（正式存档/打印导出）
  generateReportPdf:      ['reportPdf', null],

  // ocrService
  ocrOnly:                ['ocrService', { action: 'ocrOnly' }],
  aiExtractParallel:      ['ocrService', { action: 'aiExtractParallel' }],
  ocrExtract:             ['ocrService', { action: 'ocrExtract' }],

  // conversationAI
  conversationAI:         ['conversationAI', null],
}

// 写操作显式名单：名字不匹配下方前缀正则、但单次调用可能内含写工具的 action。
// conversationAI（v10 单通道）：chat 会默认执行 upsertMember/updateFinances/addFact，
// 若按读操作默认 retries=1，超时重发会导致重复落库。
// shareFamily 同为写入（families.update 落 token）：默认 retries=1 时，首发超时但实际成功
// + 重发再生成一个新 token，两次 update 落库顺序不定 → 前端拿到 A、库里是 B，分享链接直接失效。
const WRITE_ACTIONS = ['conversationAI', 'linkCashValue', 'shareFamily']

// 计费型只读 action（2026-09-22 全面审计 P2-4）：语义上是"读"（名字不匹配写操作前缀正则），
// 但每次调用都真实扣费——OCR 识别约 0.5 元/张 + AI 提取 token。
// callCloud 默认 retries=1，网络层失败（errMsg 含 fail）会**整批重发**：
// ocr-flow 只在应用层用 OCR 文本缓存避免重复识别，拦不住 callCloud 内部的重试
// → 一次弱网即双份 OCR + 双份 AI 计费。故与写操作同列：不自动重试。
const BILLED_ACTIONS = ['ocrExtract', 'ocrOnly', 'aiExtractParallel', 'generateReport', 'generateReportPdf']

// 可观测性审计：模块级记录最近一次 reqId（opts.requestId 或 OCR 会话 _reqId），供前端错误上报串联云端 trace
let _lastReqId = ''

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
  if (data._reqId) _lastReqId = data._reqId
  // 网络审计：写操作强制 retries:0（超时/网络 fail 重发 = 已入库数据双写）。
  // 读操作保持默认重试（弱网可容忍）；调用方显式传 opts.retries 优先。
  if (opts.retries === undefined && (WRITE_ACTIONS.indexOf(action) !== -1 || BILLED_ACTIONS.indexOf(action) !== -1 || /^(create|update|delete|write|record|change|upsert|add)/.test(action))) {
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

// 可观测性审计：暴露最近 reqId（前端错误上报读取）
apiCall.getLastReqId = function () { return _lastReqId }

module.exports = apiCall
