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
  updateMember:           ['dataWrite', { action: 'updateMember' }],
  createFamily:           ['dataWrite', { action: 'createFamily' }],
  deleteFamily:           ['dataWrite', { action: 'deleteFamily' }],
  writeMessage:           ['dataWrite', { action: 'writeMessage' }],
  writeOpLog:             ['dataWrite', { action: 'writeOpLog' }],

  // reportAI
  generateReport:         ['reportAI', null],

  // ocrService
  ocrSingle:              ['ocrService', { action: 'ocrSingle' }],
  ocrOnly:                ['ocrService', { action: 'ocrOnly' }],
  aiExtract:              ['ocrService', { action: 'aiExtract' }],
  aiExtractBatch:         ['ocrService', { action: 'aiExtractBatch' }],
  aiExtractParallel:      ['ocrService', { action: 'aiExtractParallel' }],
  ocrExtractParallel:     ['ocrService', { action: 'ocrExtractParallel' }],

  // conversationAI
  conversationAI:         ['conversationAI', null],
}

async function apiCall(action, params = {}) {
  const df = DIRECT_FN[action]
  if (df) {
    const [name, base] = df
    const data = base ? { ...base, ...params } : params
    return callCloud(name, data)
  }
  console.warn('[apiClient] 未知 action:', action)
  throw new Error('未知 API: ' + action)
}

module.exports = apiCall
