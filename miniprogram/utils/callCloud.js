/**
 * callCloud — 云函数调用包装（超时+重试）
 */
function callCloud(name, data = {}, opts = {}) {
  const timeout = opts.timeout || 30000
  const retries = opts.retries || 0

  const doCall = (remaining) => {
    const call = wx.cloud.callFunction({ name, data })
    const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('云函数超时:' + name)), timeout))
    return Promise.race([call, timer]).catch(err => {
      if (remaining > 0) return doCall(remaining - 1)
      throw err
    })
  }
  return doCall(retries)
}

module.exports = callCloud
