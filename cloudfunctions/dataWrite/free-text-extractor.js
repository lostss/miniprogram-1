/**
 * free-text-extractor — 自由文本 AI 提取为结构化事实
 *
 * 接口契约：
 *   extractFactsFromFreeText({ db, openid, familyId, freeTexts, memberNameById })
 *     → { freeExtracted: number, aiExtractFailed: boolean }
 *
 * 设计动机（架构审计第 13 轮候选 #5）：
 *   submitProfiling 内联 ~40 行 AI 提取逻辑（prompt 构建 + safeCallChat + JSON 解析 + 写 fact），
 *   与标准字段写入、members 同步、stage 推进纠缠。抽出后 submitProfiling 聚焦编排，
 *   本模块可独立单测（mock safeCallChat 验证 prompt/解析/写入分支）。
 *
 * 依赖关系：
 *   - lazy require ai-gateway / ai-client / fact-write（避免冷启动崩溃）
 *   - 调用 fact-write.addMemberFact 写入提取结果（confidence=0.9）
 */
const { ALLOWED_DIMENSIONS } = require('./member-dimensions')
const { DIM_TO_PREDICATE, addMemberFact } = require('./fact-write')

/**
 * @param {Object} params
 * @param {Object} params.db
 * @param {string} params.openid
 * @param {string} params.familyId
 * @param {Array<{memberId:string,name:string,text:string}>} params.freeTexts
 * @param {Object<string,string>} params.memberNameById  memberId → name 映射
 * @returns {Promise<{freeExtracted:number, aiExtractFailed:boolean}>}
 */
async function extractFactsFromFreeText({ db, openid, familyId, freeTexts, memberNameById }) {
  if (!freeTexts || freeTexts.length === 0) {
    return { freeExtracted: 0, aiExtractFailed: false }
  }

  let freeExtracted = 0
  let aiExtractFailed = false

  try {
    const cloud = require('wx-server-sdk')
    const { safeCallChat } = require('./_shared/ai-gateway')
    const { callChat } = require('./_shared/ai-client')

    const prompt = '从以下自由文本中提取结构化信息。\n' +
      freeTexts.map(ft => '成员[' + ft.name + '](memberId:' + ft.memberId + ')：' + ft.text).join('\n') +
      '\n\n提取维度：收入/职业/健康/负债/固定支出/偏好/教育程度\n' +
      '输出严格JSON：{"members":[{"memberId":"xxx","facts":[{"dimension":"收入","value":"30万"}]}]}'

    const { text: aiText } = await safeCallChat([
      { role: 'system', content: '你是信息提取器。只输出JSON，不输出其他内容。' },
      { role: 'user', content: prompt }
    ], callChat, {
      cloud, db, openid, familyId,
      sessionId: 'profile_' + Date.now().toString(36),
      model: 'hy3-preview', action: 'profile_extract'
    }, { maxTokens: 800, temperature: 0.1 })

    let extracted = null
    try {
      const m = aiText.match(/\{[\s\S]*\}/)
      if (m) extracted = JSON.parse(m[0])
    } catch (_) {}

    if (extracted && extracted.members) {
      const aiFactPromises = []
      for (const em of extracted.members) {
        for (const f of (em.facts || [])) {
          if (!f.dimension || !f.value || !ALLOWED_DIMENSIONS.has(f.dimension)) continue
          const factPredicate = DIM_TO_PREDICATE[f.dimension]
          if (factPredicate) {
            aiFactPromises.push(addMemberFact(db, openid, {
              familyId,
              memberId: em.memberId,
              memberName: memberNameById[em.memberId] || '',
              predicate: factPredicate,
              value: f.value,
              confidence: 0.9
            }))
          }
          freeExtracted++
        }
      }
      await Promise.all(aiFactPromises)
    }
  } catch (e) {
    console.error('[dataWrite] extractFactsFromFreeText 失败:', e.message)
    aiExtractFailed = true
  }

  return { freeExtracted, aiExtractFailed }
}

module.exports = { extractFactsFromFreeText }
