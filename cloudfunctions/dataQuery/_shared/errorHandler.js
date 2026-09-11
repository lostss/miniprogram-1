/**
 * errorHandler — 云函数侧错误处理 seam
 *
 * 解决问题：10+ 处 catch 块重复 `console.error + { code: 500, msg: 'xxx失败：' + e.message }`，
 * 日志风格和错误格式不一致（有的防御 e.message，有的不防御；有的带 label，有的不带）。
 *
 * 接口：
 *   wrapError(label, err) → { code: 500, msg: label + '失败：' + message }
 *     - 统一日志：console.error(`[${label}] 失败:`, message)
 *     - 防御 err 为 null/undefined/无 message
 *
 * 与 createHandler 的关系：createHandler 是入口路由的错误兜底（格式为 e.message 优先），
 * errorHandler 是内部函数的错误格式化（格式为 label+失败+message）。两者职责不重叠。
 */
function wrapError(label, err) {
  // 2026-08-29 线上 500 诊断教训：完整错误（类名+message）只进云函数日志，
  // 用户端 msg 保持通用文案——不向用户暴露内部实现细节（函数名/错误类）。
  // 诊断路径：控制台日志搜 `[label] 失败:` 即得完整原因。
  const name = (err && err.name) ? err.name : 'Unknown'
  const message = (err && err.message) ? err.message : String(err || '未知错误')
  console.error(`[${label}] 失败: [${name}]`, message)
  return { code: 500, msg: label + '失败，请稍后重试' }
}

module.exports = { wrapError }
