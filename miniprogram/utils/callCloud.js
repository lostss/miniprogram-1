/**
 * callCloud — 云函数调用包装（超时+重试）
 */
function callCloud(name, data = {}, opts = {}) {
  const timeout = opts.timeout || 30000
  const retries = opts.retries === undefined ? 1 : opts.retries

  function doCall(remaining) {
    const call = wx.cloud.callFunction({ name, data })
    let timerId
    const timer = new Promise((_, reject) => {
      // 2026-09-22 全面审计 P2-1：超时错误必须带**机器可读标志**。
      // 原实现只给中文文案（'云函数超时:xxx'），而下方重试判据找的是 'timeout'、
      // errorHandler 也按 'timeout' 分类 → 本地超时既不重试、也被归类成 UNKNOWN
      // （用户看到"操作失败，请重试"而非"操作超时"）。文案保持中文以面向用户，
      // 判定改走 __timeout 标志。
      // ⚠️ 必须由 setTimeout 触发：上面的"补标志"改动一度删掉了 setTimeout 改成同步
      // reject → 每次调用都立即判超时（全部云函数调用失败，且读操作还会多发一次）。
      // tests/callCloud.test.js 已钉死"未到点不得判超时"。
      timerId = setTimeout(() => {
        const e = new Error(`云函数超时:${name}`)
        e.__timeout = true
        reject(e)
      }, timeout)
    })
    return Promise.race([call, timer]).then(
      res => { clearTimeout(timerId); return res },
      err => {
        clearTimeout(timerId)
        const msg = String((err && (err.errMsg || err.message)) || '')
        // __timeout：本地计时器主动放弃（读操作重试一次；写/计费类 action 由 apiClient 强制 retries=0）
        if ((msg.indexOf('fail') !== -1 || msg.indexOf('timeout') !== -1 || (err && err.__timeout === true)) && remaining > 0) {
          return doCall(remaining - 1)
        }
        throw err
      }
    )
  }
  return doCall(retries)
}

module.exports = callCloud
