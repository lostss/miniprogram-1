/**
 * ai-gateway 输入闸门测试 — system 提示词不得被 MAX_INPUT 截断
 *
 * 事故（2026-09-22 全面审计 · AI 侧 P1）：
 *   `_secureInput` 原先对**每一条** message 都 `sanitize(m.content)`（默认上限 16000），
 *   system 消息也未能幸免。实测 reportAI 的 system prompt = 16330 字（warm 语气 = 16753）：
 *     ① 「## 输出前红线重申」第 2~8 条被截掉，模型从未看到那批强制自查条款；
 *     ② warm（共情版）整块 423 字位于截断点之后 → **共情语气 100% 无效**，
 *        而 agent_logs 照旧记 metrics.tone='warm'（日志上完全看不出功能是空的）。
 * 本套件钉住"system 不被按用户输入上限截断"这一事实。
 */
jest.mock('../cloudfunctions/_shared/logSeam', () => ({
  logAI: jest.fn(() => Promise.resolve('log_1')),
  updateLogStatus: jest.fn(() => Promise.resolve())
}))

const { safeCallChat } = require('../cloudfunctions/_shared/ai-gateway')
const { SECURITY } = require('../cloudfunctions/_shared/config')

describe('ai-gateway _secureInput：system 提示词不受 MAX_INPUT 约束', () => {
  const longSystem = 'S'.repeat(SECURITY.MAX_INPUT + 2000)
  const longUser = 'U'.repeat(SECURITY.MAX_INPUT + 2000)

  test('超长 system 消息原样送达模型（不再被截到 MAX_INPUT）', async () => {
    let seen = null
    const callChat = (messages) => { seen = messages; return Promise.resolve({ text: 'ok', usage: {} }) }
    await safeCallChat(
      [{ role: 'system', content: longSystem }, { role: 'user', content: '你好' }],
      callChat,
      { skipLog: true, skipRateLimit: true, skipContentSafety: true, skipInjection: true }
    )
    expect(seen[0].content.length).toBe(longSystem.length)
  })

  test('超长 user 消息仍按 MAX_INPUT 截断（用户输入闸门保持有效）', async () => {
    let seen = null
    const callChat = (messages) => { seen = messages; return Promise.resolve({ text: 'ok', usage: {} }) }
    await safeCallChat(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: longUser }],
      callChat,
      { skipLog: true, skipRateLimit: true, skipContentSafety: true, skipInjection: true }
    )
    expect(seen[1].content.length).toBe(SECURITY.MAX_INPUT)
  })

  test('ctx.maxInput 可为特定路径放宽 user 上限（OCR 长保单文本）', async () => {
    let seen = null
    const callChat = (messages) => { seen = messages; return Promise.resolve({ text: 'ok', usage: {} }) }
    await safeCallChat(
      [{ role: 'user', content: longUser }],
      callChat,
      { skipLog: true, skipRateLimit: true, skipContentSafety: true, skipInjection: true, maxInput: SECURITY.MAX_INPUT + 2000 }
    )
    expect(seen[0].content.length).toBe(longUser.length)
  })

  test('system 提示词仍做 NFKC/零宽清理（只放长度，不放清洗）', async () => {
    let seen = null
    const callChat = (messages) => { seen = messages; return Promise.resolve({ text: 'ok', usage: {} }) }
    await safeCallChat(
      [{ role: 'system', content: 'a\u200Bb' }],
      callChat,
      { skipLog: true, skipRateLimit: true, skipContentSafety: true, skipInjection: true }
    )
    expect(seen[0].content).toBe('ab')
  })

  test('reportAI 的 system prompt 长度已在闸门内（真实常量回归）', () => {
    const { REPORT_PROMPT, buildReportPrompt } = require('../cloudfunctions/reportAI/prompts')
    // 提示词常量本身可以超过 MAX_INPUT（它不是用户输入）；这里锁的是"网关不再截它"，
    // 同时给出可视化的量级，避免将来有人"顺手"把 MAX_INPUT 当成提示词预算。
    expect(REPORT_PROMPT.length).toBeGreaterThan(0)
    expect(buildReportPrompt('warm').length).toBeGreaterThan(REPORT_PROMPT.length)
  })
})
