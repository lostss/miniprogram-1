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
      timerId = setTimeout(() => reject(new Error('云函数超时:' + name)), timeout)
    })
    return Promise.race([call, timer]).then(
      res => { clearTimeout(timerId); return res },
      err => {
        clearTimeout(timerId)
        const msg = String((err && (err.errMsg || err.message)) || '')
        if ((msg.indexOf('fail') !== -1 || msg.indexOf('timeout') !== -1) && remaining > 0) {
          return doCall(remaining - 1)
        }
        throw err
      }
    )
  }
  return doCall(retries)
}

module.exports = callCloud
