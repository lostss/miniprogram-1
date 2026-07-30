/**
 * family-actions.js — 跨页面共享的家庭动作
 *
 * 解决问题：index/index.js 和 clients/index.js 的 onClientTap / onClientLongPress
 * 逐字符重复（共 ~60 行），文案改一处需同步改两处，极易漂移。
 *
 * 设计：纯函数 + 注入 api 回调，不绑定 Page 实例
 *  - 调用方传入 familyId / name / api / onSuccess
 *  - 内部封装 modal 确认 + loading + toast + 错误处理
 */
const session = require('./session-store')
const api = require('./apiClient')

// 跳转到家庭报告页（设置 activeFamily + navigateTo）
function navigateToFamily(familyId) {
  session.setActiveFamily(familyId)
  wx.navigateTo({ url: '/pages/report/index?familyId=' + familyId })
}

// 确认删除家庭（弹 modal → loading → 调 deleteFamily → toast → onSuccess 回调）
function confirmDeleteFamily(opts) {
  const { familyId, name, onSuccess } = opts
  if (!familyId) return
  const displayName = name || '该家庭'
  wx.showModal({
    title: '删除家庭',
    content: '确定删除「' + displayName + '」及其所有数据吗？此操作不可恢复。',
    confirmText: '删除',
    confirmColor: '#D35A5A',
    success: async (res) => {
      if (!res.confirm) return
      wx.showLoading({ title: '删除中' })
      try {
        const r = await api('deleteFamily', { familyId })
        if (r.result && r.result.code === 200) {
          wx.showToast({ title: '已删除', icon: 'success' })
          if (typeof onSuccess === 'function') onSuccess()
        } else {
          wx.showToast({ title: (r.result && r.result.msg) || '删除失败', icon: 'none' })
        }
      } catch (e) {
        wx.showToast({ title: '删除失败', icon: 'none' })
      } finally {
        wx.hideLoading()
      }
    }
  })
}

module.exports = { navigateToFamily, confirmDeleteFamily }
