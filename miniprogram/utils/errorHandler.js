/**
 * errorHandler — 全局错误处理策略
 * 
 * 统一错误码 → 用户提示映射
 * 支持场景：云函数返回错误、网络异常、权限错误、数据校验错误
 * 
 * 用法：
 *   const errorHandler = require('./errorHandler.js')
 *   errorHandler.handle(err)                    // 自动判断类型并提示
 *   errorHandler.handle(err, { silent: true })  // 只记录不提示
 *   errorHandler.getErrorInfo(err)              // 获取错误信息
 */

// ==================== 错误码映射 ====================
const ERROR_MAP = {
  400: { label: '参数错误', tip: '操作有误，请重试', icon: 'warn' },
  401: { label: '未授权', tip: '请重新登录', icon: 'warn' },
  403: { label: '无权限', tip: '没有操作权限', icon: 'warn' },
  404: { label: '未找到', tip: '数据不存在或已被删除', icon: 'warn' },
  500: { label: '服务异常', tip: '服务繁忙，请稍后重试', icon: 'error' },
  NETWORK: { label: '网络异常', tip: '网络连接失败，请检查网络', icon: 'error' },
  TIMEOUT: { label: '请求超时', tip: '操作超时，请重试', icon: 'error' },
  UNKNOWN: { label: '未知错误', tip: '操作失败，请重试', icon: 'error' }
}

// ==================== 核心方法 ====================

/**
 * 从错误对象中提取错误码
 */
function _classifyError(err) {
  if (!err) return 'UNKNOWN'

  // 云函数返回的 result 格式
  if (err.code) {
    if (err.code === 400) return 400
    if (err.code === 401) return 401
    if (err.code === 403) return 403
    if (err.code === 404) return 404
    if (err.code >= 500) return 500
    return err.code
  }

  // 网络错误
  if (err.errMsg) {
    const msg = String(err.errMsg).toLowerCase()
    if (msg.indexOf('timeout') !== -1) return 'TIMEOUT'
    if (msg.indexOf('network') !== -1 || msg.indexOf('fail') !== -1) return 'NETWORK'
  }

  // wx API 错误
  if (err.errno) {
    if (err.errno === 600001) return 'NETWORK'
    if (err.errno === 600002) return 'TIMEOUT'
  }

  return 'UNKNOWN'
}

/**
 * 获取错误信息
 */
function getErrorInfo(err) {
  const code = _classifyError(err)
  const mapped = ERROR_MAP[code] || ERROR_MAP.UNKNOWN
  return {
    code: code,
    label: mapped.label,
    tip: mapped.tip,
    icon: mapped.icon,
    detail: (err && err.msg) || (err && err.message) || (err && err.errMsg) || ''
  }
}

/**
 * 统一错误处理入口
 * @param {Error|Object} err 错误对象
 * @param {Object} options 选项
 * @param {boolean} options.silent 是否静默（不弹提示）
 * @param {string} options.context 错误上下文（用于日志）
 */
function handle(err, options) {
  const opts = options || {}
  const info = getErrorInfo(err)

  // 日志记录
  const logMsg = '[errorHandler] ' + (opts.context || '') + ' | code=' + info.code + ' label=' + info.label + ' detail=' + info.detail
  console.error(logMsg)

  // 云端上报（仅非静默且非网络错误）
  if (!opts.silent && info.code !== 'NETWORK' && info.code !== 'TIMEOUT') {
    try {
      const app = getApp()
      if (app && app._uploadError) app._uploadError(opts.context || 'handler', { message: info.detail })
    } catch (e) { console.error('[errorHandler] 云端上报失败:', (e && e.message) || e) }
  }

  // 用户提示
  if (!opts.silent) {
    wx.showToast({
      title: info.tip,
      icon: info.icon === 'error' ? 'error' : 'none',
      duration: 2500,
      mask: false
    })
  }

  return info
}

module.exports = {
  handle: handle,
  getErrorInfo: getErrorInfo
}
