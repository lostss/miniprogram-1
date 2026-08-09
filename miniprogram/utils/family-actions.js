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

// 确认删除家庭（ActionSheet"删除" → Modal 二次确认 → deleteFamily → toast → onSuccess）
function confirmDeleteFamily(opts) {
  const { familyId, name, onSuccess } = opts
  if (!familyId) return
  const displayName = name || '该家庭'
  wx.showActionSheet({
    itemList: ['删除'],
    itemColor: '#B85450',
    success: (r) => {
      if (r.tapIndex !== 0) return
      wx.showModal({
        title: '删除家庭',
        content: '确定删除「' + displayName + '」及其所有数据吗？此操作不可恢复。',
        confirmText: '删除',
        confirmColor: '#B85450',
        success: async (res) => {
          if (!res.confirm) return
          try {
            const r2 = await api('deleteFamily', { familyId })
            if (r2.ok) {
              wx.showToast({ title: '已删除', icon: 'success' })
              // 存储审计 P1：删除家庭后清理本地残留——last_family_id 指向已删 ID（现价表 404）、
              // match_cache 5min 内把同名新家庭路由到旧 ID（写错家庭）、homeRecentClients 陈旧
              if (session.getActiveFamily() === familyId) session.clear()
              try { wx.removeStorageSync('match_cache'); wx.removeStorageSync('homeRecentClients') } catch (e) {}
              if (typeof onSuccess === 'function') onSuccess()
            } else {
              wx.showToast({ title: r2.msg || '删除失败', icon: 'none' })
            }
          } catch (e) {
            wx.showToast({ title: '删除失败', icon: 'none' })
          }
        }
      })
    }
  })
}

module.exports = { navigateToFamily, confirmDeleteFamily }
