/**
 * prompt-cache.js — systemPrompt 缓存（5 分钟 TTL）
 *
 * 解决问题：chat-panel/index.js 的 _cachedPrompt 实例字段 + _getSystemPrompt 方法
 * 混在组件中，无法独立测试 TTL 命中/失效。架构审计 C。
 *
 * 设计：工厂函数 + 闭包状态，不绑定组件实例
 *   - 调用方 createPromptCache() 获得独立缓存实例
 *   - get(familyId) → Promise<string>  // 命中返回缓存；未命中调 API + 写入缓存
 *   - invalidate()                     // familyId 切换时调用
 */
const api = require('./apiClient')

const TTL_MS = 5 * 60 * 1000
const DEFAULT_PROMPT = '你是保小秘，一个专业的保险顾问AI助手。请用中文回复，简洁专业。'

function createPromptCache() {
  let cached = null // { familyId, text, fetchedAt }

  async function get(familyId) {
    const now = Date.now()
    if (cached && cached.familyId === familyId && (now - cached.fetchedAt) < TTL_MS) {
      return cached.text
    }
    try {
      const pr = await api('conversationAI', { familyId, mode: 'getPrompt' })
      if (pr.result && pr.result.code === 200) {
        const d = pr.result.data
        let text = d.systemPrompt || ''
        if (d.context) text += '\n\n## 当前客户信息\n' + d.context
        cached = { familyId, text, fetchedAt: now }
        return text
      }
    } catch (e) {
      console.error('[prompt-cache] getPrompt 失败:', e.message || e)
    }
    return DEFAULT_PROMPT
  }

  function invalidate() { cached = null }

  return { get, invalidate }
}

module.exports = { createPromptCache }
