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
 *   safeHandler(label, fn) → async function(...args)
 *     - 包装异步函数，catch 后返回 wrapError(label, err)
 *     - 用于内部函数（非入口 handler）的统一错误兜底
 *
 * 与 createHandler 的关系：createHandler 是入口路由的错误兜底（格式为 e.message 优先），
 * errorHandler 是内部函数的错误格式化（格式为 label+失败+message）。两者职责不重叠。
 */
function wrapError(label, err) {
  const message = (err && err.message) ? err.message : String(err || '未知错误')
  console.error(`[${label}] 失败:`, message)
  return { code: 500, msg: label + '失败：' + message }
}

function safeHandler(label, fn) {
  return async function (...args) {
    try {
      return await fn(...args)
    } catch (e) {
      return wrapError(label, e)
    }
  }
}

module.exports = { wrapError, safeHandler }
