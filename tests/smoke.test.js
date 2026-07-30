/**
 * Smoke test — 每个云函数入口 require 一次，验证模块能加载。
 * ponytail: 抓 ReferenceError / SyntaxError / 缺导出 等冷启动崩溃，不验证业务逻辑。
 */
const path = require('path')

const FUNCTIONS = ['conversationAI', 'dataQuery', 'dataWrite', 'login', 'ocrService', 'reportAI']

test('smoke: 所有云函数入口 require 不抛错', () => {
  const errors = []
  for (const fn of FUNCTIONS) {
    const entry = path.resolve(__dirname, '../cloudfunctions', fn, 'index.js')
    // 清缓存确保每次 fresh require
    Object.keys(require.cache).filter(k => k.includes('/cloudfunctions/' + fn + '/')).forEach(k => delete require.cache[k])
    try {
      const mod = require(entry)
      if (!mod || !mod.main || typeof mod.main !== 'function') {
        errors.push(`${fn}: 导出缺失 main 函数`)
      }
    } catch (e) {
      errors.push(`${fn}: ${e.name}: ${e.message}`)
    }
  }
  if (errors.length > 0) throw new Error('云函数加载失败:\n  - ' + errors.join('\n  - '))
})
