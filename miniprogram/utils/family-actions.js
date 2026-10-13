/**
 * family-actions.js — 跨页面共享的家庭动作
 *
 * 设计：纯函数 + 注入 api 回调，不绑定 Page 实例
 *  - 调用方传入 familyId / name / onSuccess
 *  - 内部封装 modal 确认 + loading + toast + 错误处理
 *
 * 2026-10-13：原为 index/index.js 与 clients/index.js 共用（两者 onClientTap/LongPress 逐字符
 * 重复 ~60 行）。两页已合并为一页（pages/index），本模块仍是删除流程的唯一实现方 —— 保留，
 * 因为删除动作本身就是"跨页面共享的领域动作"（报告页也可调用）。
 */
const session = require('./session-store')
const api = require('./apiClient')
// 2026-09-20（复核批次 A）：删除家庭后清聊天历史快照。复用 history-store 的模块级 invalidate
// （与"会话内新消息后作废快照"同一实现），避免在此手写 'chat_history_' 前缀造成魔法字符串漂移。
const { invalidate: invalidateChatCache } = require('./history-store')

// 客户列表缓存键（pages/index 读写与删除清理共用同一常量，防魔法字符串漂移）
// 2026-10-13 合并页：原 CLIENTS_CACHE_KEY('clientsAllList') 与首页键并存 → 收成一个，
// 删除/建档只需清这一处；键值保留 'homeRecentClients'（存量用户本地缓存继续有效，
// 改名会造成一次无谓的全量失效）。
const HOME_CACHE_KEY = 'homeRecentClients'

// 跳转到家庭报告页（设置 activeFamily + navigateTo）
function navigateToFamily(familyId) {
  session.setActiveFamily(familyId)
  // 2026-09-22 全面审计（前端 P3）：补 fail 分支。导航失败（栈超限/URL 异常）此前是**完全静默**的
  // ——点击后什么都没发生，用户只会反复点。同页 ocr-flow 的 chooseMedia、报告页 onExitPreview
  // 都有 fail 兜底，此处对齐。
  wx.navigateTo({
    url: '/pages/report/index?familyId=' + familyId,
    fail: function() { wx.showToast({ title: '打开失败，请重试', icon: 'none' }) }
  })
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
            // 2026-09-09：删除过程无反馈 → 加 loading（级联删除涉及 10+ 集合，可能 1-3 秒）
            wx.showLoading({ title: '正在删除…', mask: true })
            let r2 = await api('deleteFamily', { familyId })
            // 2026-09-09：207 = 部分级联数据清理失败（family 保留、可幂等重试）→ 自动重试一次，
            // 覆盖瞬时单文档删除异常，避免"删不掉但数据已部分清掉"的半删除状态
            if (!r2.ok && r2.code === 207) {
              wx.showLoading({ title: '正在清理数据…', mask: true })
              r2 = await api('deleteFamily', { familyId })
            }
            wx.hideLoading()
            if (r2.ok) {
              wx.showToast({ title: '已删除', icon: 'success' })
              // 存储审计 P1：删除家庭后清理本地残留——last_family_id 指向已删 ID（现价表 404）、
              // match_cache 5min 内把同名新家庭路由到旧 ID（写错家庭）、homeRecentClients 陈旧
              if (session.getActiveFamily() === familyId) session.clear()
              // 2026-09-20（复核批次 A）：补清聊天历史快照。原三键清单漏了它——家庭档案已删，
              // 本地仍留着该家庭的全部对话（小秘回答里含保额/家庭情况等 PII），而快照是
              // 按 familyId 存的独立 key，随家庭数增长（每个约十余条消息），逼近小程序 10MB 上限。
              // 语义与 invalidate 的原用途一致：数据源已变 → 快照作废。
              invalidateChatCache(familyId)
              // 2026-10-13：客户列表与首页已合并为同一页、同一缓存键 → 只清这一个键
              try { wx.removeStorageSync('match_cache'); wx.removeStorageSync(HOME_CACHE_KEY) } catch (e) {}
              if (typeof onSuccess === 'function') onSuccess()
            } else {
              wx.showToast({ title: (r2.code === 207 ? '仍有部分数据未能清理，请稍后重试' : (r2.msg || '删除失败')), icon: 'none' })
            }
          } catch (e) {
            wx.hideLoading()
            wx.showToast({ title: '删除失败', icon: 'none' })
          }
        }
      })
    }
  })
}

module.exports = { navigateToFamily, confirmDeleteFamily, HOME_CACHE_KEY }
