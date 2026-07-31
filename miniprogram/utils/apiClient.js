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
  const raw = await callCloud(name, data, opts)
  const r = raw && raw.result
  return {
    ok: !!(r && r.code === 200),
    code: (r && r.code) || 500,
    msg: (r && r.msg) || '请求失败',
    data: (r && r.data) || null
  }
}

module.exports = apiCall
