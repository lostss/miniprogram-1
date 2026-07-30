// app.js
const CLOUD_ENV = 'cloud1-3gan2ae3d3b400f1'
const errorHandler = require('./utils/errorHandler.js')
const api = require('./utils/apiClient.js')

// 前端错误上报（fire-and-forget，走统一 callCloud 入口，便于后续归一化/超时控制）
function _uploadError(type, info) {
  try {
    const openid = wx.getStorageSync('openid') || ''
    api('writeOpLog', {
      openid,
      logAction: 'frontend_error',
      result: {
        status: 'error',
        summary: '[' + type + '] ' + (info.message || '').substring(0, 200),
        error: (info.stack || info.message || '').substring(0, 500)
      }
    }).catch(e => console.error('[app] 错误上报失败:', (e && e.message) || e))
  } catch (e) { console.error('[app] _uploadError 异常:', (e && e.message) || e) }
}

App({
  onLaunch: function () {
    this.globalData = {
      env: CLOUD_ENV,
      openid: ''
    };
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: CLOUD_ENV,
        traceUser: true,
      });
    }

    // 静默获取 openid（不弹窗）
    this._silentLogin()
  },

  onError: function (err) {
    console.error('[App] 全局错误:', err)
    errorHandler.handle(err, { context: 'global', silent: true })
    _uploadError('global', { message: typeof err === 'string' ? err : (err.message || String(err)) })
  },

  onUnhandledRejection: function (res) {
    console.error('[App] 未捕获的 Promise 拒绝:', res.reason || res)
    errorHandler.handle(res.reason, { context: 'unhandled_rejection', silent: true })
    _uploadError('unhandled_rejection', { message: res.reason?.message || String(res.reason || '') })
  },

  onPageNotFound: function (res) {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  _uploadError: _uploadError,

  _silentLogin: function () {
    try {
      var devMode = typeof __wxConfig !== 'undefined' && __wxConfig.envVersion === 'develop'
      api('login', { devMode: devMode }).then(res => {
        if (res.result && res.result.code === 200 && res.result.data && res.result.data.openid) {
          this.globalData.openid = res.result.data.openid
          wx.setStorageSync('openid', res.result.data.openid)
        }
      }).catch(e => console.error('[app] 静默登录失败:', (e && e.message) || e))
    } catch (e) { /* 初始化阶段失败不阻塞 */ }
  }
});
