/**
 * wrapError 单测 — 锁住 2026-08-29 契约：完整错误只进日志，用户端 msg 通用化
 * 事故背景：TypeError 被透传成 "处理失败：xxx is not a function"，内部实现细节
 * （函数名/错误类）暴露给用户。现在 msg 恒为 "label + 失败，请稍后重试"，
 * 类名+message 仅进云函数日志（console.error）。
 */
const { wrapError } = require('../cloudfunctions/_shared/errorHandler')

describe('wrapError', () => {
  test('TypeError 不向用户端暴露细节（2026-08-29 线上 500 事故模式）', () => {
    const r = wrapError('处理', new TypeError('buildV2Context is not a function'))
    expect(r.code).toBe(500)
    expect(r.msg).toBe('处理失败，请稍后重试')
  })

  test('普通 Error 同样通用化', () => {
    const r = wrapError('获取', new Error('数据库连接失败'))
    expect(r.msg).toBe('获取失败，请稍后重试')
  })

  test('防御 null / 字符串 / 无 message 对象（均不炸、不泄漏）', () => {
    expect(wrapError('处理', null).msg).toBe('处理失败，请稍后重试')
    expect(wrapError('处理', 'plain string').msg).toBe('处理失败，请稍后重试')
    expect(wrapError('处理', {}).msg).toBe('处理失败，请稍后重试')
  })

  test('日志侧保留完整错误（类名 + message）供控制台诊断', () => {
    const orig = console.error
    const lines = []
    console.error = (...args) => lines.push(args.join(' '))
    try {
      wrapError('处理', new TypeError('boom'))
    } finally {
      console.error = orig
    }
    expect(lines[0]).toContain('[处理] 失败: [TypeError]')
    expect(lines[0]).toContain('boom')
  })
})
