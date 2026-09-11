/**
 * report-analysis.js — 报告页"深度分析"关切控制器（重构审计：从 report/index.js 一次一个关切抽出）
 *
 * 职责：深度分析弹层状态机（busy/aborted/tick/60s 超时），调 generateReport 完成后回调页面刷新。
 * 边界：不碰页面其他 data；通过注入的 getFamilyId/setData/onDone 与页面解耦，可脱离 wxml 单测。
 * 页面 onUnload 必须调 destroy()（清 interval + 置位 disposed，防卸载后 setData 告警）。
 */
const api = require('../utils/apiClient')

function createReportAnalysis(deps) {
  const getFamilyId = deps.getFamilyId
  const setData = deps.setData
  const onDone = deps.onDone // (cid) => void，成功路径回调（页面负责 _refreshReportSequence）
  const onBlocked = deps.onBlocked // (readiness) => void，422 门禁明细回调（页面负责渲染补全清单）
  let _busy = false
  let _aborted = false
  let _tick = null
  let _disposed = false
  let _reqSeq = 0

  function _clearTick() {
    if (_tick) { clearInterval(_tick); _tick = null }
  }

  function start() {
    if (_busy || _disposed) return
    const cid = getFamilyId()
    if (!cid) return
    _busy = true
    _aborted = false
    const myReq = ++_reqSeq
    const t0 = Date.now()
    // UI 审计 状态 S3：自定义弹层替代 showLoading（60s 长任务可取消，不锁死用户）；R-M1 阶段反馈由 analysisSec 承担
    setData({ analysisShow: true, analysisSec: 0 })
    _tick = setInterval(() => {
      if (_disposed) { _clearTick(); return }
      setData({ analysisSec: Math.round((Date.now() - t0) / 1000) })
    }, 1000)
    // R3v2 审计 #7：原 action 'reportAI' 未在 apiClient DIRECT_FN 注册（只有 generateReport）→ 功能永远失败
    // 改走 generateReport + 显式 60s 超时（reportAI 函数 timeout=60s，默认 30s 会先断+重试双份计费）
    api('generateReport', { familyId: cid }, { timeout: 60000, retries: 0     }).then(q => {
      // 审计 P2-4：_disposed 检查必须最先——页面卸载后 setData 会告警（destroy 已 clear interval，此处重复 clear 无害）
      // P1-2 修复：myReq !== _reqSeq 表示本请求已被更新的 start 取代（cancel→restart），结果作废且不复位 _busy
      if (_disposed || myReq !== _reqSeq) return
      _clearTick()
      setData({ analysisShow: false })
      _busy = false
      // 用户已取消：云函数仍会完成，但结果标记忽略
      if (_aborted) return
      if (q && q.throttled) {
        // P2-6 修复：节流判定先于 ok——服务端节流返回 code=200+throttled:true，原顺序被 q.ok 误报"分析完成"
        // 2026-09-09：节流命中 = 服务端已有最新分析（或 auto 流程正占用 CAS 锁），
        // 原实现只 toast 不刷新 → 用户点了按钮看不到任何变化（报告其实已生成/正在生成）；
        // 补 onDone 刷新，让刚生成的结果能显示出来
        wx.showToast({ title: '已是最新分析', icon: 'none' })
        if (onDone) onDone(cid)
      } else if (q && q.ok) {
        // 合规审计其他4：WARN 放行后的降质披露——成功但数据不完整时提示缺口仅供参考
        const warned = q.data && Array.isArray(q.data.readiness_warnings) && q.data.readiness_warnings.length > 0
        wx.showToast({ title: warned ? '分析完成，部分数据未填写，缺口仅供参考' : '分析完成', icon: warned ? 'none' : 'success' })
        if (onDone) onDone(cid)
      } else if (q && q.code === 422) {
        // readiness 门禁（2026-08）：必填项缺失，上抛明细由页面渲染补全清单（不得当失败 toast）
        if (onBlocked) onBlocked(q.data || {})
      } else {
        wx.showToast({ title: (q && q.msg) || '分析失败，请重试', icon: 'none' })
      }
    }).catch(() => {
      if (_disposed || myReq !== _reqSeq) return
      _clearTick()
      setData({ analysisShow: false })
      _busy = false
      wx.showToast({ title: '分析失败，请重试', icon: 'none' })
    })
  }

  function cancel() {
    // UI 审计 状态 S3：取消深度分析（UI 立即释放；请求结果回来时由 _aborted 忽略）
    _aborted = true
    _busy = false
    _clearTick()
    setData({ analysisShow: false })
    wx.showToast({ title: '已取消分析', icon: 'none' })
  }

  function destroy() {
    _disposed = true
    _clearTick()
  }

  return { start: start, cancel: cancel, destroy: destroy }
}

module.exports = { createReportAnalysis }
