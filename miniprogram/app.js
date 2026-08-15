// app.js
const CLOUD_ENV = 'cloud1-3gan2ae3d3b400f1'
const errorHandler = require('./utils/errorHandler.js')
const api = require('./utils/apiClient.js')
const { desensitize } = require('./utils/pii-rules')

// 前端错误上报（fire-and-forget，走统一 callCloud 入口，便于后续归一化/超时控制）
function _uploadError(type, info, reqId) {
  try {
    // S1 修复：openid 由 _silentLogin 写入 globalData（内存），此处应读 globalData 而非 Storage
    // （原读 wx.getStorageSync('openid') 永远为空，导致错误上报缺主体）
    const app = getApp()
    const openid = (app && app.globalData && app.globalData.openid) || ''
    // 错误类型归一（TypeError/ReferenceError/…），供 operation_logs 按类型聚合告警
    const errObj = info.error || (typeof info.message === 'object' ? info.message : null)
    const errorType = (errObj && errObj.name) || (typeof info.message === 'string' ? 'string_error' : 'unknown')
    const summary = desensitize('[' + type + '/' + errorType + '] ' + (info.message || '').substring(0, 200))
    const error = desensitize((info.stack || info.message || '').substring(0, 500))
    api('writeOpLog', {
      openid,
      logAction: 'frontend_error',
      result: {
        status: 'error',
        errorType,
        // 可观测性审计：trace_id 串联（reqId 优先，兜底最近一次云端调用 _reqId）
        trace_id: reqId || api.getLastReqId() || '',
        summary,
        error
      }
    }).catch(e => console.error('[app] 错误上报失败:', (e && e.message) || e))
  } catch (e) { console.error('[app] _uploadError 异常:', (e && e.message) || e) }
}

App({
  onLaunch: function () {
    this.globalData = {
      env: CLOUD_ENV,
      openid: '',
      // 存储审计 P1：openidPromise 暴露给组件等待（冷启动竞态：立即上传时 openid 未填充 → 前缀 temp/anon → 云端归属校验 403）
      openidPromise: null
    };
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: CLOUD_ENV,
        traceUser: true,
      });
    }

    // 静默获取 openid（不弹窗）；正式环境首次需手机号登录（needLogin 由首页按钮触发）
    this._silentLogin()
  },

  onError: function (err) {
    console.error('[App] 全局错误:', err)
    errorHandler.handle(err, { context: 'global', silent: true })
    _uploadError('global', { message: typeof err === 'string' ? err : (err.message || String(err)), error: err })
  },

  onUnhandledRejection: function (res) {
    console.error('[App] 未捕获的 Promise 拒绝:', res.reason || res)
    errorHandler.handle(res.reason, { context: 'unhandled_rejection', silent: true })
    _uploadError('unhandled_rejection', { message: res.reason?.message || String(res.reason || ''), error: res.reason })
  },

  onPageNotFound: function (res) {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  _uploadError: _uploadError,

  // 上线审计：正式环境（体验版/正式版）手机号登录引导。
  // dev 环境 → devLogin（无需授权）；非 dev 且未登录过 → needLogin（首页显示手机号按钮）。
  // 已登录标记存 storage（agent_logged_in），避免已建档用户每次授权。
  _silentLogin: function () {
    try {
      var devMode = typeof __wxConfig !== 'undefined' && __wxConfig.envVersion === 'develop'
      var self = this
      if (!devMode) {
        var loggedIn = false
        try { loggedIn = !!wx.getStorageSync('agent_logged_in') } catch (e) {}
        this.globalData.needLogin = !loggedIn
        this.globalData.openidPromise = Promise.resolve('')
        return
      }
      this.globalData.openidPromise = api('login', { devMode: true }).then(res => {
        var oid = (res && res.ok && res.data && res.data.openid) || ''
        self.globalData.openid = oid
        return oid
      }).catch(e => {
        console.error('[app] 静默登录失败:', (e && e.message) || e)
        return ''
      })
    } catch (e) { /* 初始化阶段失败不阻塞 */ }
  },

  // 手机号登录成功回调（首页按钮触发，见 pages/index onPhoneLogin）
  completePhoneLogin: function (res) {
    var oid = (res && res.openid) || ''
    this.globalData.openid = oid
    this.globalData.needLogin = false
    try { wx.setStorageSync('agent_logged_in', 1) } catch (e) {}
  }
});
