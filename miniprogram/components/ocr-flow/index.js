/**
 * ocr-flow 组件 — OCR 全链路流程（首页/报告页共用）
 * 属性：skipMatch(报告页跳过匹配) / familyId(报告页当前家庭)
 * 事件：saved{familyId,savedPolicies,savedCash} / discarded
 * 方法：chooseAndStart() / startWithPaths(paths) / checkResume()
 */
const flow = require('../../utils/ocr-flow')
const session = require('../../utils/session-store')
const api = require('../../utils/apiClient')
const errorHandler = require('../../utils/errorHandler')
// 角色推断纯规则（候选 2 下沉，可单测：utils/role-infer.js）
const roleInfer = require('../../utils/role-infer')
// 领域写薄层（候选 5）：成员字段写收敛 field/value 语义
const { saveMemberField } = require('../../utils/domain-writes')
const { yuanToWan } = require('../../utils/amount')
// 置信度阈值契约（2026-09-24 口径自查：原为内联 0.95；下方 0.8 是 UI 三档底色的私有分界，不在契约内）
const { OCR_RELIABLE_THRESHOLD } = require('../../utils/ocr-confidence')

// UI 审计 A-S1/A-S2/A-S3：OCR 编辑/手动录入共用的数值字段清单（弹数字键盘 + 校验）。
// 注意：payment_period 是文本（"20年/交至60岁/月交"），不能用数字键盘
const SHEET_NUMERIC_KEYS = ['sum_assured', 'annual_premium']

Component({
  properties: {
    skipMatch: { type: Boolean, value: false },
    familyId: { type: String, value: '' }
  },
  data: {
    ocrMask: flow.defaultState(),
    // 2026-10-13：原 `ocrSheet`（弹窗内编辑态：mode='view' 查看起步 → 编辑 → 保存）随
    // 「识别结果弹窗只留取消/保存」一并移除 —— 编辑一律后移到「报告 → 保单列表」，
    // 此处不再挂 edit-sheet（组件已从 usingComponents 摘除）。
  },
  lifetimes: {
    detached() {
      // S1-3 修复：若已进入 saved phase，立即同步触发 saved 事件，避免定时器被清除后父页面不知道保存成功
      // 导致首页不跳转报告页、报告页不刷新。detached 后 setData 无效，仅 triggerEvent
      if (this.data.ocrMask && this.data.ocrMask.phase === 'saved' && !this._savedEmitted) {
        this._savedEmitted = true
        this.triggerEvent('saved', {
          familyId: this.data.ocrMask._familyId || this.properties.familyId || '',
          savedPolicies: this.data.ocrMask.savedPolicies || 0,
          savedCash: this.data.ocrMask.savedCash || 0,
          manual: true
        })
      }
      this._ocrBusy = false; this._disposed = true
      clearTimeout(this._navTimer); clearTimeout(this._savedTick); clearInterval(this._ocrTick)
      if (this._roleResolve) { this._roleResolve(null); this._roleResolve = null }
      if (this._matchResolve) { this._matchResolve(null); this._matchResolve = null }
      // 返回键防护兜底：组件销毁时撤销 enableAlertBeforeUnload，防残留拦截正常返回
      try { if (typeof wx.disableAlertBeforeUnload === 'function') wx.disableAlertBeforeUnload() } catch (e) {}
    }
  },
  methods: {
    // ============ 手势拦截 ============
    // 阻断 mask/sheet 触摸拖动穿透到页面（无拦截时在识别结果卡片上下拉会触发 report 页下拉刷新重载报告）。
    // 内部 scroll-view 为原生滚动，不受父级 catchtouchmove 影响。
    onMaskTouchMove() {},
    // ============ 公开入口 ============
    chooseAndStart() {
      // 机会式过期清理：上传前清掉保留超 7 天的失败文件
      flow.cleanupExpiredTemp()
      const MAX_SIZE = 10 * 1024 * 1024
      wx.chooseMedia({
        sourceType: ['album', 'camera'], count: 9, mediaType: ['image'], sizeType: ['compressed'],
        success: (r) => {
          const valid = r.tempFiles.filter(f => f.size <= MAX_SIZE)
          if (valid.length < r.tempFiles.length) wx.showToast({ title: (r.tempFiles.length - valid.length) + '张超过10MB已跳过', icon: 'none' })
          if (valid.length === 0) return
          this._startOCR(valid.map(f => f.tempFilePath))
        },
        // 2026-09-22 全面审计 P1-2（前端）：原实现只有 success，漏了 fail。
        // chooseMedia 自 2023-09 起属**必须声明隐私协议**的接口：用户拒绝相册/相机权限，
        // 或小程序后台未在「用户隐私保护指引」声明「选中的照片或视频信息」时，API 直接走 fail
        // → 点「上传保单」毫无反应（主入口死按钮），既不提示也不引导，用户只会以为小程序坏了。
        fail: (err) => {
          const msg = String((err && err.errMsg) || '')
          if (/cancel/i.test(msg)) return // 用户主动取消选择：不打扰
          if (/auth\s*deny|authorize|permission/i.test(msg)) {
            wx.showModal({
              title: '需要相册/相机权限',
              content: '识别保单需要读取你选择的照片。请在设置中允许使用相册/相机后重试。',
              confirmText: '去设置', cancelText: '取消',
              // openSetting 必须由用户点击触发；modal 的 confirm 属用户手势，合规
              success: (m) => { if (m.confirm) wx.openSetting({}) }
            })
          } else {
            // 其余失败（如基础库过低、系统异常）也要有反馈，不再静默
            wx.showToast({ title: '打开相册失败，请重试', icon: 'none' })
          }
        }
      })
    },
    startWithPaths(paths) { if (paths && paths.length) this._startOCR(paths) },
    checkResume() {
      var self = this
      if (this._ocrBusy || this.data.ocrMask.visible) return
      var batch = null
      try { batch = wx.getStorageSync('ocrBatch') } catch (e) {}
      if (!batch || !batch.policies || !batch.policies.length) return
      // 存储审计 P0：恢复前校验保存时间（PII 明文整批落本地，超 12h 丢弃+清理，不再永久残留）
      var savedTs = batch.savedAt ? new Date(batch.savedAt).getTime() : 0
      if (!savedTs || Date.now() - savedTs > 12 * 3600 * 1000) {
        try { wx.removeStorageSync('ocrBatch') } catch (e) {}
        return
      }
      wx.showModal({
        title: '检测到未完成的保单处理',
        content: _timeAgo(savedTs) + '识别了 ' + batch.policies.length + ' 份保单，等待家庭匹配。是否继续？',
        confirmText: '继续处理', cancelText: '放弃',
        success: function(r) {
          if (self._disposed) return
          if (r.confirm) {
            // UI 审计 F-S4：恢复确认后立即占位 _ocrBusy，300ms 窗口内新 OCR 被拦，不再被旧恢复数据覆盖
            self._ocrBusy = true
            self._procPolicies = batch.policies || []
            self._procCash = batch.cashValues || []
            self._procErrors = (batch.errors || []).map(function(e) { return { fileId: e.fileId, thumb: e.thumb || '', error: e.error || '识别失败', retrying: false } })
            self._procFamilyId = self.properties.familyId || ''
            // 延迟渲染：等 showModal 关闭动画结束再显示确认卡，避免视觉上"弹窗未关闭，需再点一次"
            // 恢复渲染兜底：_procRefresh 异常时清 batch + 释放 _ocrBusy，避免"继续处理后悬空"（_ocrBusy 卡死拦后续 OCR）
            setTimeout(function() {
              if (self._disposed) return
              try { self._procRefresh() } catch (e) { console.error('[ocr-flow] resume render:', e); self._clearBatch() }
              self._ocrBusy = false
            }, 300)
          } else self._clearBatch()
        }
      })
    },
    _persistBatch() {
      try { wx.setStorageSync('ocrBatch', { policies: this._procPolicies || [], cashValues: this._procCash || [], errors: (this._procErrors || []).map(function(e) { return { fileId: e.fileId, thumb: e.thumb || '', error: e.error || '识别失败' } }), savedAt: Date.now() }) } catch (e) { console.error('[ocr-flow] persistBatch:', e) }
    },
    _clearBatch() { try { wx.removeStorageSync('ocrBatch') } catch (e) {} },
    // 返回键防护（替代已失效的宿主 onBackPress 死代码）：OCR 遮罩展开时启用系统返回询问，
    // 防误按返回退页丢进度；关闭时撤销。enableAlertBeforeUnload 为页面级、离开页面自动失效，
    // 此处按遮罩显隐同步开关 + detached 兜底撤销，避免残留拦截正常返回。
    _applyBackGuard() {
      try {
        const busy = !!(this.data.ocrMask && this.data.ocrMask.visible)
        if (busy && typeof wx.enableAlertBeforeUnload === 'function') {
          wx.enableAlertBeforeUnload({ message: '识别尚未完成，确定退出吗？' })
        } else if (typeof wx.disableAlertBeforeUnload === 'function') {
          wx.disableAlertBeforeUnload()
        }
      } catch (e) { /* 基础库过低无此 API 时静默降级 */ }
    },
    _emitBusy() { this.triggerEvent('busychange', { busy: !!this.data.ocrMask.visible }); this._applyBackGuard() },

    // ============ 主流程 ============
    async _startOCR(tempFiles) {
      // UI 审计 F-S4：确认卡/结果卡打开（visible=true）时禁止新 OCR，防覆盖当前处理中的批
      if (this._ocrBusy || this.data.ocrMask.visible) return
      this._ocrBusy = true
      // Bug-A 修复（2026-09-09）：_savedEmitted 不随新批次重置——上一批保存触发跳转后，
      // 本批 saved 弹窗的自动倒计时与「进入报告」被永久拦截（只有不检查它的「返回首页」可点）。
      // 每个新 OCR 会话必须复位。
      this._savedEmitted = false
      // UI 审计 交互 S1/状态 S1：进行中取消标志（返回键/放弃时置位，await 后检查点提前退出）
      this._ocrCancelled = false
      var tStart = Date.now(), total = tempFiles.length, setData = this.setData.bind(this), allFileIds = []
      console.log('[OCR] ====== 开始, ' + total + ' 张 ======')
      try {
        var allPolicies = [], cashValues = [], errors = [], self = this
        var familyId = this.properties.familyId || ''
        this.setData(flow.start(total))
        this._emitBusy()
        // 上传阶段即展示所选图（pending 槽位），识别阶段 setStreamingSlots 再覆盖
        this.setData({ 'ocrMask.streamSlots': tempFiles.map(function(t) { return { kind: 'pending', thumb: t } }) })
        var upProgress = function(patch) {
          var u = patch && patch['ocrMask.uploaded']
          if (typeof u === 'number' && !self._disposed) self.setData({ 'ocrMask.uploaded': u, 'ocrMask.phaseText': '正在上传 ' + u + '/' + total })
        }
        // R3v2 审计 #4：上传路径按 openid 分区（temp/<openid>/），配合 ocrService 归属校验防 IDOR
        // 存储审计 P1：冷启动 openid 未填充时 await 登录 promise，避免前缀 temp/anon → 归属校验 403
        // typeof 防御：jest 组件测试无全局 getApp
        var _app = typeof getApp === 'function' ? getApp() : null
        var _g = _app && _app.globalData
        if (_g && typeof _g.openidPromise === 'object' && _g.openidPromise && typeof _g.openidPromise.then === 'function') {
          try { await _g.openidPromise } catch (e) { /* 登录失败沿用空 openid（归属校验会 403，可重试） */ }
        }
        var _ownerPrefix = 'temp/' + ((_g && _g.openid) || 'anon')
        var upResult = await flow.compressAndUpload(tempFiles, upProgress, _ownerPrefix)
        // 2026-09-22 修（全面审计 · 前端 P2）：上传是整条链路里最慢的一步（弱网下数十秒），
        // 而用户在等待期间最自然的动作就是点「取消并清理」。原实现**只在下游两处检查取消标志**
        // （L204/L210），上传完成后的检查点缺失 → 取消后仍会走进 flow.batchOCR，
        // **照常产生 OCR（约 0.5 元/张）与 AI 提取的真实计费**，拿回结果再被丢弃、临时文件也被清理。
        // 这里补上第一个检查点：已取消/已销毁则立即收尾，不发起计费调用。
        if (this._disposed || this._ocrCancelled) return
        var validThumbs = []
        for (var i = 0; i < upResult.fileIds.length; i++) {
          if (upResult.fileIds[i]) { allFileIds.push(upResult.fileIds[i]); validThumbs.push(upResult.localPaths[i] || tempFiles[i]) }
        }
        var validIds = allFileIds.filter(function(id) { return !!id })
        var uploadFailed = (upResult && upResult.failures) || 0
        // 审计修复：上传失败不再落入"识别完成 0 份"的空卡（原 failures 返回后从未被读取，全失败无任何反馈）
        if (validIds.length === 0) {
          this.setData(flow.hide())
          this._emitBusy()
          wx.showToast({ title: uploadFailed > 0 ? ('有 ' + uploadFailed + ' 张图片上传失败') : '没有可识别的图片', icon: 'none', duration: 2500 })
          return
        }
        if (uploadFailed > 0) wx.showToast({ title: uploadFailed + ' 张图片上传失败，已跳过', icon: 'none', duration: 2000 })
        if (validIds.length > 0) {
          var t0 = Date.now()
          clearInterval(this._ocrTick)
          this._ocrTick = setInterval(function() { self.setData({ 'ocrMask.elapsed': Math.round((Date.now() - t0) / 1000) }) }, 1000)
          try {
            var ocrRes = await flow.batchOCR(validIds, setData, { familyId: familyId, thumbs: validThumbs })
            if (this._ocrCancelled) return
            allPolicies = ocrRes.policies || []; cashValues = ocrRes.cashValues || []; errors = ocrRes.errors || []
          } catch (e2) { errors.push({ error: (e2 && e2.message) || 'OCR异常', error_code: 'ocr_exception' }) }
          clearInterval(this._ocrTick)
        }
        console.log('[OCR] 全批次收齐, 耗时:' + (Date.now() - tStart) + 'ms, 产品:' + allPolicies.length + ', 失败:' + errors.length)
        if (this._disposed || this._ocrCancelled) return
        // 纯现价表分支：无保单且无失败项时直接入库。有失败项时必须停列表等人工处理（错误项也要展示，否则静默丢失）
        if (allPolicies.length === 0 && cashValues.length > 0 && errors.length === 0) {
          var activeFid = this.properties.familyId || session.getActiveFamily()
          if (!activeFid) {
            wx.showModal({ title: '需要先创建家庭', content: '现价表需关联到家庭，请先上传保单或创建家庭后再试。', showCancel: false, confirmText: '知道了' })
            // 2026-09-17 审计 P1-7：原实现直接 return，未关遮罩 → "正在处理"永久停留
            // （有取消按钮可手动退出，非硬卡死，但体验为卡住）。与其他 early-return 分支同款收尾。
            this.setData(flow.hide())
            this._emitBusy()
            return
          }
          var cr = await flow.saveCashValuesWithRetry(activeFid, cashValues, setData)
          if (cr.ok) {
            wx.showToast({ title: cr.matched ? '现价表已关联保单' : '现价表已保存，可手动关联保单', icon: cr.matched ? 'success' : 'none', duration: cr.matched ? 1500 : 2500 })
            // 存储审计 P1：纯现价表保存也 emit saved（原 return 前无 triggerEvent，首页/报告页无感知入库）
            this.triggerEvent('saved', { familyId: activeFid, matched: !!cr.matched })
          }
          // 2026-09-22 全面审计 P1-1（前端）：本分支是本函数**唯一**漏发 busychange 的收尾路径。
          // saveCashValuesWithRetry 内部已 setData(hide()) 把遮罩关掉（成功/失败都关），但组件没
          // 通知父页——pages/index 的 ocrBusy 停在 true → 首页「上传保单」框（index.wxml:10）
          // 整个 wx:if 隐藏、FAB 也拿不到 fab--show（index.wxss:34 scale(0) 无命中区）→
          // 两个上传入口同时消失且不可点，只能杀进程重进。
          // 注：不能改到外层 finally 里统一发——_renderProc 路径要在遮罩**可见**时发 busy=true，
          // finally 再发一次会把它覆盖成 false。故在本分支显式收尾。
          this._emitBusy()
          return
        }
        // 方案 B：全部失败（含 not_policy）不再弹 modal 拦截，统一进识别列表——错误卡含具体信息 + 手动录入/预览/重试出口。
        // 原 showModal 路径有卡死 bug：not_policy 时只有"知道了"，success 回调两个分支均不命中 → 遮罩停在处理中无出口。
        // 统一走 _renderProc：错误组正常渲染 + 批次持久化（checkResume 可恢复）
        var thumbMap = {}
        for (var t = 0; t < validIds.length; t++) { thumbMap[validIds[t]] = validThumbs[t] || '' }
        this._renderProc(allPolicies, cashValues, familyId, errors, thumbMap)
      } catch (e) {
        console.error('OCR失败:', e)
        // 2026-09-22 修复（全面审计 · 前端 P1）：原实现
        //   wx.showModal({ showCancel:false, confirmText:'重试', success: () => this._startOCR(tempFiles) })
        // 有两个缺陷：
        //   ① 「重试」是**空操作**：_startOCR 开头 `if (this._ocrBusy || this.data.ocrMask.visible) return`，
        //      而本路径从不收起遮罩 → 重入必然被挡回。用户看到的是"点了重试没反应"，遮罩停在
        //      「正在处理 N 张图片 / 已等待 X 秒」的永动进度上（elapsed 还在涨），像是卡死。
        //   ② `showCancel:false` 只给一个按钮，用户没有"先不处理"的出口（要退只能先关掉这个弹窗，
        //      再去点遮罩里的「取消并清理」——两步且不直观）。
        // 现：先收起遮罩并清空本批渲染数据（恢复可重入），再让用户在「重试 / 先不处理」之间明确选择。
        // 放弃分支与 onFailedBack 同口径（_clearBatch + triggerEvent('discarded')），
        // 否则 checkResume 会在下次进入页面时把用户已放弃的批次又弹回来。
        this._procPolicies = []; this._procCash = []; this._procErrors = []
        this.setData(Object.assign(flow.hide(), { 'ocrMask._policies': [], 'ocrMask._cashValues': [], 'ocrMask._familyId': '' }))
        this._emitBusy()
        wx.showModal({
          title: '识别失败',
          content: '遇到点问题，请重试',
          showCancel: true,
          cancelText: '先不处理',
          confirmText: '重试',
          success: function(res) {
            if (this._disposed) return
            if (res && res.confirm) { this._startOCR(tempFiles); return }
            this._clearBatch()
            this.triggerEvent('discarded')
          }.bind(this)
        })
      } finally {
        clearInterval(this._ocrTick)
        // 保留失败项的云端 fileId（供重试/跨会话恢复直 OCR），仅清理成功项
      var failIds = {}
      ;(errors || []).forEach(function(e) { if (e.fileId) failIds[e.fileId] = true })
      flow.cleanupTempFiles(allFileIds.filter(function(id) { return !failIds[id] }))
      // 失败文件保留台账（供 7 天过期清理，避免云端残留）
      flow.rememberFailedFiles(Object.keys(failIds))
        this._ocrBusy = false
      }
    },

    // ============ 三组分组 ============
    _renderProc(allPolicies, cashValues, familyId, errors, thumbMap) {
      this._procPolicies = allPolicies || []
      this._procCash = cashValues || []
      // 分流分组收编：classifyBatchResults 纯函数（决策在 ocr-flow.js，组件只做 adapter）
      const cls = flow.classifyBatchResults(this._procPolicies, this._procCash, errors, thumbMap)
      this._procErrors = cls.error
      this._procFamilyId = familyId || this.properties.familyId || ''
      this.setData(flow.setDone(this._procPolicies, this._procCash, {
        'ocrMask._familyId': this._procFamilyId,
        'ocrMask.procSuccess': cls.success, 'ocrMask.procReview': cls.review, 'ocrMask.procError': cls.error
      }))
      this._emitBusy()
      this._persistBatch()
    },

    // 重渲染当前处理结果（checkResume 恢复 / 重试 / 编辑后刷新）
    // R2 收编 classifyBatchResults 时逻辑迁至纯函数，本方法定义缺失导致 7 处调用抛 TypeError，
    // 表现：恢复弹窗点击"继续处理"后无任何界面指引
    _procRefresh() {
      var thumbMap = {}
      ;(this._procErrors || []).forEach(function(e) { if (e.fileId) thumbMap[e.fileId] = e.thumb || '' })
      this._renderProc(this._procPolicies, this._procCash, this._procFamilyId, this._procErrors, thumbMap)
    },

    // ============ 重试 / 录入 / 预览 ============
    // 2026-10-13 产品决策（识别结果弹窗只留「取消 / 保存」）：以下四项交互全部移除——
    //   onProcRetryOne / onProcRetryAll（失败项重试，含复用内存 ocrText 的省钱路径）
    //   onProcManualAdd（失败项手动录入）、onProcPreview（点缩略图看大图）
    // 失败项改为保存时跳过（保存前弹窗已显式告知张数）。对应私有实现 `_ocrRetryOne`
    // 暂时保留但**已无调用方**（重试能力本身仍是完整的，留待需要时接回或按 YAGNI 删除）。
    // UI 审计 交互 S1：宿主页 onBackPress 委托入口（report/index 两页共用）
    // 返回键行为：saving 阶段不可中断 → 其余阶段确认放弃
    // （2026-10-13：原「先关编辑 sheet」分支随弹窗内编辑能力移除）
    onBackPressed() {
      const mask = this.data.ocrMask
      if (!mask.visible) return false
      if (mask.phase === 'saving') { wx.showToast({ title: '正在保存保单信息，请稍候', icon: 'none' }); return true }
      this.onProcDiscardAll()
      return true
    },
    onProcDiscardAll() {
      var self = this
      if (this.data.ocrMask.confirming || this.data.ocrMask.procBusy) return
      wx.showModal({
        title: '全部放弃',
        content: '将丢弃本次识别的所有结果，不保存任何内容。确定吗？',
        confirmText: '放弃', confirmColor: '#B85450',
        success: function(r) {
          if (!r.confirm || self._disposed) return
          // UI 审计 状态 S1：进行中取消置位，_startOCR 的 await 检查点提前退出并清理已上传文件
          self._ocrCancelled = true
          self._procPolicies = []; self._procCash = []; self._procErrors = []
          // P0 修复（dsh UI 审计）：放弃时 resolve 挂起的匹配/角色阶段 promise，
          // 否则 _doSave 的 await 永不返回，_saving 永久卡死（后续保存静默失效）
          if (self._roleResolve) { var rr = self._roleResolve; self._roleResolve = null; rr(null) }
          if (self._matchResolve) { var mr = self._matchResolve; self._matchResolve = null; mr(null) }
          self.setData(Object.assign(flow.hide(), { 'ocrMask._policies': [], 'ocrMask._cashValues': [], 'ocrMask._familyId': '' }))
          self._clearBatch()
          self._emitBusy()
          wx.showToast({ title: '已放弃本次结果', icon: 'none' })
          self.triggerEvent('discarded')
        }
      })
    },

    // ============ 单张移除 ============
    // 2026-10-13 移除（同「只留取消/保存」决策）：失败项不再支持单张移除，
    // 保存时统一跳过；若三组全空则保存路径自身会兜底关卡片（见 _doSave 的空批分支）。

    // ============ 全部确认 → 保存链 ============
    onProcConfirm() {
      var mask = this.data.ocrMask
      if (mask.confirming || mask.procBusy) return
      var errCount = (this._procErrors || []).length, reviewCount = (mask.procReview || []).length, self = this
      if (errCount > 0 || reviewCount > 0) {
        wx.showModal({
          title: '还有保单未处理',
          content: '识别异常 ' + errCount + ' 份，待核对 ' + reviewCount + ' 份。确认后将跳过异常，待核对项按当前结果保存。',
          confirmText: '下一步', cancelText: '返回处理',
          success: function(r) { if (r.confirm && !self._disposed) self._doSave() }
        })
        return
      }
      this._doSave()
    },
    async _doSave() {
      // 错误提示审计 #8：保存防重入（onFailedRetry 连点不再触发多次写库）
      if (this._saving) return
      this._saving = true
      try {
      var policies = this._procPolicies || [], cashValues = this._procCash || []
      if (!policies.length && !cashValues.length) {
        // 审计修复：空批确认原为静默关卡（无 toast、无 _clearBatch）→ 用户误以为已保存，且残留 batch 下次 onShow 又弹恢复提示
        this._clearBatch()
        this.setData(flow.hide())
        this._emitBusy()
        wx.showToast({ title: '没有可保存的保单', icon: 'none' })
        return
      }
      var pick = null
      if (this.properties.skipMatch && this.properties.familyId) {
        pick = this.properties.familyId
        // 2026-10-13：跳过匹配 ≠ 跳过角色确认。家庭页上传是本项目**唯一**上传入口，
        // 若此处不建 ctx，角色卡恒不弹 → 成员 role 永远为空（readiness/gap 的支柱判定随之失效）。
        this._buildStageCtx(policies)
      } else {
        pick = await this._runMatchStage(policies)
        if (this._disposed) return
        if (!pick) { this._openDone(); return }
      }
      var roleOut = null
      while (true) {
        roleOut = await this._runRoleStage(pick, policies)
        if (this._disposed) return
        if (!roleOut) {
          // skipMatch（报告页内上传）：角色卡"上一步"无返回路径，直接关遮罩，避免蒙层卡死
          // 组件审计 P1-2：必须 _emitBusy()——撤销 enableAlertBeforeUnload（否则返回键残留拦截）+ 上抛 busychange
          if (this.properties.skipMatch) { this.setData(flow.hide()); this._emitBusy(); return }
          pick = await this._rerunMatch()
          if (this._disposed) return
          if (!pick) { this._openDone(); return }
          continue
        }
        break
      }
      var familyId = roleOut.familyId
      var newRoles = roleOut.newRoles || []
      this.setData(flow.setConfirming(true))
      var ok = await flow.confirmWritePolicies(familyId, policies, cashValues, this.setData.bind(this))
      if (this._disposed) return
      if (!ok || !ok.ok) {
        // 错误提示审计 #4：写失败进 failed 相（已有重试/放弃出口）+ 静默上报云端
        const errText = (ok && ok.error) || '写入失败，请检查网络后重试'
        errorHandler.handle({ msg: errText }, { silent: true, context: 'ocrSave' })
        this.setData(flow.setFailed(errText)); return
      }
      // Bug-B 对账（2026-09-09）：后端校验失败项仍返回 200；written=0 时不得再显示"保存成功"
      var writtenN = (ok && typeof ok.written === 'number') ? ok.written : policies.length
      var totalN = (ok && typeof ok.total === 'number') ? ok.total : policies.length
      if (totalN > 0 && writtenN === 0) {
        var failedN = totalN - (ok.dedupSkipped || 0)
        errorHandler.handle({ msg: '保单未能落库' }, { silent: true, context: 'ocrSave' })
        this.setData(flow.setFailed('保单未能保存：' + failedN + ' 份未通过校验，请检查后重试'))
        return
      }
      // 2026-09-19 修（流程审计 P1-5）：**部分失败**同样不得当成功。
      // 后端逐条写、失败项只记 logOperation，整体仍返回 200 + written<total（writePoliciesBatch 契约）。
      // 原实现只拦 written===0，`2/3` 会顺流走进 _showSaved → 批次被 _clearBatch 清空、
      // 失败项既无提示也无补救入口（数据静默丢失）。
      // 改为与 written=0 同一条出路（failed 相）：批次保留 → 「重试」可再提交（已落库的由后端
      // dedupSkipped 去重，不会双写），或显式「放弃全部」。
      var skippedN = (ok && typeof ok.dedupSkipped === 'number') ? ok.dedupSkipped : 0
      if (totalN > 0 && writtenN + skippedN < totalN) {
        var missN = totalN - writtenN - skippedN
        errorHandler.handle({ msg: '部分保单未落库' }, { silent: true, context: 'ocrSave' })
        this.setData(flow.setFailed('已保存 ' + writtenN + '/' + totalN + ' 份，' + missN + ' 份未通过校验。可重试（已保存的不会重复）或放弃。'))
        return
      }
      // 写入成功后回写 familyId（_procRefresh 时匹配未定，_familyId 仍为空；
      // saved 事件依赖它跳转报告页，缺失会导致"缺少客户信息"）
      this._procFamilyId = familyId
      this.setData({ 'ocrMask._familyId': familyId })
      // 新成员角色补写：后端已在写入时创建成员，按姓名查 member_id 更新角色
      if (newRoles.length) {
        var fam = await apiGetFamily(familyId)
        if (this._disposed) return
        if (fam) {
          var missingMembers = []
          await Promise.all(newRoles.map(function(rp) {
            var m = (fam.members || []).find(function(x) { return x.name === rp.name })
            if (m && m.member_id) return saveMemberField({ familyId: familyId, memberId: m.member_id, field: 'role', value: rp.role }).catch(function() {})
            missingMembers.push(rp.name)
          }))
          // 2026-09-19 修（流程审计 P1-2）：回查不到成员**必须告知**，不得静默跳过。
          // 原实现在这里没有 else —— 用户确认过的角色被默默丢弃，界面却显示"保存成功"
          // （根因在后端建档范围只含 insured_name，已同批修复；此处是前端侧的兜底可见性）。
          if (missingMembers.length) {
            errorHandler.handle({ msg: '新成员未建档：' + missingMembers.join('、') }, { silent: true, context: 'ocrRoleWrite' })
            wx.showToast({ title: '保单已保存；' + missingMembers.join('、') + ' 的角色待补', icon: 'none' })
          }
        } else {
          // UI 审计 F-S3：角色补写失败不再静默吞错（保单已写入，提示用户稍后可手动调整角色）
          errorHandler.handle({ msg: '成员角色同步失败（apiGetFamily 返回空）' }, { silent: true, context: 'ocrRoleWrite' })
          wx.showToast({ title: '保单已保存，角色信息待同步', icon: 'none' })
        }
      }
      // Bug-B：savedCount 用后端真实 written（含库中命中重复），不再用前端数组长度
      var savedCount = writtenN, cashCount = (cashValues || []).length, self = this
      wx.nextTick(function() { if (!self._disposed) self._showSaved(savedCount, cashCount) })
      // 悬空修复：保存链任何环节抛错（匹配/角色/写入）→ 进 failed 相（有放弃/重试出口），不再无反馈悬空
      } catch (e) {
        if (this._disposed) return
        console.error('[ocr-flow] save chain:', e)
        errorHandler.handle({ msg: (e && e.message) || '保存异常' }, { silent: true, context: 'ocrSave' })
        this.setData(flow.setFailed('保存遇到问题，请重试'))
      } finally {
        this._saving = false
      }
    },

    // ============ 匹配弹窗 ============
    /**
     * 从本批保单推出"角色卡要用的人"：primaryHolder（票数最高的投保人）+ bloodNames（全部真人）。
     *
     * 2026-10-13 抽成独立方法：原实现只在 `_runMatchStage` 内部构建 `_stageCtx`，而家庭页上传走
     * `skipMatch` 会跳过 `_runMatchStage` → ctx 恒为空 → `_runRoleStage` 的 roleList 为空 →
     * **角色卡不弹、成员角色永远不写**（后端 matchPoliciesToMembers 只写 name/birth_date，从不写 role）。
     * 首页上传入口取消后，`_runMatchStage` 更是无调用方 —— 角色卡随之彻底不可达。
     * 现两条路径都调本方法：匹配弹窗仍可跳过，但角色确认照常。
     */
    _buildStageCtx(allPolicies) {
      var holderCount = {}
      allPolicies.forEach(function(p) { const n = p.policyholder_name || p.insured_name; if (n) holderCount[n] = (holderCount[n] || 0) + 1 })
      var sorted = Object.keys(holderCount).sort(function(a, b) { return holderCount[b] - holderCount[a] })
      var primaryHolder = sorted[0] || '新客户'
      var bloodNames = [primaryHolder], seen = { [primaryHolder]: true }
      function _add(name) { if (name && !seen[name]) { seen[name] = true; bloodNames.push(name) } }
      allPolicies.forEach(function(p) {
        // 2026-09-19 修（流程审计 P1-2）：原实现只把"票数最高的投保人"（primaryHolder）列进角色卡，
        // 次要投保人不会出现；而后端建档范围以"投保人/被保人/受益人"为准 → 会出现"后端建了档、
        // 角色卡却没问过"的不对称。这里补齐全部投保人，使角色卡展示的人与后端会创建的人一致。
        _add(p.policyholder_name)
        _add(p.insured_name)
        if (p.beneficiary_name && !/法定|法定继承人|未指定/.test(p.beneficiary_name)) _add(p.beneficiary_name)
      })
      this._stageCtx = { primaryHolder: primaryHolder, bloodNames: bloodNames }
      return this._stageCtx
    },

    async _runMatchStage(allPolicies) {
      var ctx0 = this._buildStageCtx(allPolicies)
      var primaryHolder = ctx0.primaryHolder
      var candidates = []
      var cachedId = session.getMatchCache(primaryHolder)
      var self = this
      if (cachedId) {
        var cached = await apiGetFamily(cachedId)
        if (this._disposed) return null
        if (cached) candidates.push(cached)
      } else {
        // 悬空修复：searchFamilies 网络失败降级为空候选（默认"新建家庭"），不再抛错冒泡至 _doSave 悬空
        //
        // 2026-09-19 修（流程审计 P1-1）：候选不再按"家庭名精确相等"过滤。
        // 后端 searchFamilies 本就是**正则子串**双路匹配（家庭名 family_name **或**成员 name，
        // family-list.js L45-46），返回项已含两类命中；前端再 `c.name === primaryHolder` 一刀切，
        // 把「成员名命中」与「子串命中」全部丢弃 → 用户只能"新建家庭"，同一家庭被拆成多份档案。
        // 典型场景：① 给已有客户上传配偶投保的保单（家庭名是本人名，投保人只在成员表里）
        //          ② 客户档案叫「李姐-转介绍」（家庭名包含关键词但不等）
        // 另：关键词从"仅投保人"扩为"投保人 + 各被保人"——父母为孩子投保时，投保人既不是家庭名
        // 也不是成员，只有被保人姓名能命中（原实现此场景必然找不到）。
        var keywords = [primaryHolder]
        allPolicies.forEach(function(p) {
          var n = (p.insured_name || '').trim()
          if (n && keywords.indexOf(n) === -1) keywords.push(n)
        })
        var searchResults = await Promise.all(keywords.map(function(kw) {
          return api('searchFamilies', { keyword: kw }).catch(function() { return null })
        }))
        if (this._disposed) return null
        var seenIds = {}, rawCands = []
        searchResults.forEach(function(res, ri) {
          if (!res || !res.ok) return
          ;(res.data.families || []).forEach(function(c) {
            if (!c || !c._id || seenIds[c._id]) return
            seenIds[c._id] = true
            rawCands.push({ c: c, kw: keywords[ri] })
          })
        })
        if (rawCands.length > 0) {
          var details = await Promise.all(rawCands.map(function(rc) {
            return apiGetFamily(rc.c._id).then(function(f) { return { f: f, kw: rc.kw } }).catch(function() { return { f: null, kw: rc.kw } })
          }))
          if (this._disposed) return null
          details.forEach(function(item) {
            if (!item.f) return
            // 命中依据 + 强度排序（供用户核对；强命中靠前，默认预选取首位）
            var fn2 = item.f.name || '', kw = item.kw, rank = 3, basis = '名称近似'
            if (fn2 === kw) { rank = 0; basis = '家庭名相同' } else if (fn2.indexOf(kw) !== -1) { rank = 2; basis = '家庭名包含「' + kw + '」' } else {
              var hit = (item.f.members || []).find(function(x) { return x.name === kw })
              if (hit) { rank = 1; basis = '成员「' + kw + '」所在家庭' } else {
                var fz = (item.f.members || []).find(function(x) { return x.name && x.name.indexOf(kw) !== -1 })
                if (fz) { rank = 1; basis = '成员「' + fz.name + '」所在家庭' }
              }
            }
            item.f._basis = basis
            item.f._rank = rank
            candidates.push(item.f)
          })
          candidates.sort(function(a, b) { return (a._rank || 9) - (b._rank || 9) })
        }
      }
      // 2026-09-09 回滚：恢复默认预选（产品要求）。缓存命中优先，否则预选第一候选；
      // 用户可直接"下一步"，也可改选——不再强制空选
      var cachedValid = !!(cachedId && candidates.some(function(c) { return c._id === cachedId }))
      var defaultPick = cachedValid ? cachedId : (candidates.length > 0 ? candidates[0]._id : 'new')
      var candsUI = candidates.map(function(c) {
        return { _id: c._id, name: c.name, basis: c._basis || '', membersText: (c.members || []).map(function(m) { return m.name + (m.role ? '(' + m.role + ')' : '') }).join('、') }
      })
      this.setData({
        'ocrMask.visible': true, 'ocrMask.phase': 'match',
        'ocrMask.matchCandidates': candsUI, 'ocrMask.matchPick': defaultPick,
        'ocrMask.matchSummary': primaryHolder + ' · ' + allPolicies.length + ' 份保单'
      })
      return await new Promise(function(resolve) { self._matchResolve = resolve })
    },
    onMatchPick(e) { this.setData({ 'ocrMask.matchPick': e.currentTarget.dataset.pick }) },
    onMatchNext() {
      var pick = this.data.ocrMask.matchPick
      if (!pick) { wx.showToast({ title: '请选择归属家庭', icon: 'none' }); return }
      if (this._matchResolve) { var r = this._matchResolve; this._matchResolve = null; r(pick) }
    },
    onMatchPrev() {
      if (this._matchResolve) { var r = this._matchResolve; this._matchResolve = null; r(null) }
    },
    _openDone() { this._procRefresh() },
    _rerunMatch() {
      this.setData({ 'ocrMask.visible': true, 'ocrMask.phase': 'match' })
      var self = this
      return new Promise(function(resolve) { self._matchResolve = resolve })
    },

    // ============ 角色卡 ============
    async _runRoleStage(pick, allPolicies) {
      var ctx = this._stageCtx || { primaryHolder: '', bloodNames: [] }
      var self = this, isNew = pick === 'new'
      var familyId = isNew ? '' : pick, family = null
      if (isNew) {
        var createMembers = [{ role: '本人', name: ctx.primaryHolder }]
        ctx.bloodNames.forEach(function(n) { if (n !== ctx.primaryHolder) createMembers.push({ role: '', name: n }) })
        var cr = await api('createFamily', { family_name: ctx.primaryHolder, members: createMembers })
        if (this._disposed) return null
        if (!cr.ok) { wx.showToast({ title: '创建家庭失败，请重试', icon: 'none' }); return null }
        familyId = cr.data._id
        session.cacheMatch(ctx.primaryHolder, familyId)
        family = await apiGetFamily(familyId)
        if (this._disposed) return null
      } else {
        family = await apiGetFamily(pick)
        if (this._disposed) return null
        if (!family) { wx.showToast({ title: '读取家庭失败，请重试', icon: 'none' }); return null }
      }
      var birthMap = roleInfer.buildBirthMap(allPolicies)
      var selfAge = roleInfer.ageFromBirth(birthMap[ctx.primaryHolder])
      // 家庭既有角色占用（本人/配偶 全局唯一），携带 memberId 供替换清除
      var occupied = roleInfer.occupiedRoles(family.members)
      var roleList = []
      var memberByName = {}
      ;(family.members || []).forEach(function(m) { memberByName[m.name] = m })
      if (isNew) {
        ;(family.members || []).forEach(function(m) { roleList.push({ name: m.name, memberId: m.member_id, role: m.role === '本人' ? '本人' : roleInfer.inferRelation(m.name, selfAge, birthMap, occupied), isNew: false }) })
      } else {
        // 2026-09-09 产品调整：本批保单涉及的人（primaryHolder + 被保人 + 非身故受益人）每次入库都显示角色确认，
        // 已配角色作为默认值展示、可调整——不再只问"无角色/新成员"，杜绝角色静默错误
        ctx.bloodNames.forEach(function(n) {
          if (!n) return
          var m = memberByName[n]
          if (m) {
            roleList.push({ name: n, memberId: m.member_id, role: m.role || roleInfer.inferRelation(n, selfAge, birthMap, occupied), isNew: false })
          } else {
            var role = roleInfer.inferRelation(n, selfAge, birthMap, occupied)
            // 默认规则：投保人 → 本人（本人未被占用时）
            if (n === ctx.primaryHolder && !occupied['本人']) role = '本人'
            roleList.push({ name: n, memberId: 'new_' + roleList.length, role: role, isNew: true })
          }
        })
      }
      if (!roleList.length) return { familyId: familyId }
      this._roleOccupied = occupied
      this.setData({ 'ocrMask.visible': true, 'ocrMask.phase': 'roles', 'ocrMask.roleFamilyName': family.name || (isNew ? '新建家庭' : ''), 'ocrMask.roleList': this._applyRoleState(roleList) })
      var confirmed = await new Promise(function(resolve) { self._roleResolve = resolve })
      if (this._disposed) return null
      if (!confirmed) return null
      // 互斥写回：先清被替换成员的角色（含列表内清空与家庭既有占用者），再写新角色（避免瞬态双占）
      var clearIds = confirmed.filter(function(r) { return !r.isNew && r.memberId && (r.role === '' || r.replaced) }).map(function(rr) { return rr.memberId })
      confirmed.forEach(function(r) { if (r.clearMemberId) clearIds.push(r.clearMemberId) })
      var uniqIds = clearIds.filter(function(v, i, a) { return a.indexOf(v) === i })
      await Promise.all(uniqIds.map(function(mid) {
        return saveMemberField({ familyId: familyId, memberId: mid, field: 'role', value: '' }).catch(function() {})
      }))
      var updates = confirmed.filter(function(r) { return r.role && !r.isNew && r.memberId }).map(function(rr) {
        return saveMemberField({ familyId: familyId, memberId: rr.memberId, field: 'role', value: rr.role }).catch(function() {})
      })
      await Promise.all(updates)
      if (this._disposed) return null
      // 新成员角色：真实 member_id 由后端 matchPoliciesToMembers 在写入时创建，
      // 此处带回 name+role，由 _doSave 在写入成功后按姓名补角色
      var newRoles = confirmed.filter(function(r) { return r.isNew && r.role }).map(function(rr) { return { name: rr.name, role: rr.role } })
      return { familyId: familyId, newRoles: newRoles }
    },
    // 实时互斥：家庭占用 + 列表内已选 → 每项 conflict { 角色: 占用者姓名 }（规则在 utils/role-infer.js，候选 2 下沉）
    _applyRoleState(list) {
      return roleInfer.applyRoleConflicts(list, this._roleOccupied || {})
    },
    onRolePick(e) {
      var idx = e.currentTarget.dataset.idx, role = e.currentTarget.dataset.role
      var list = (this.data.ocrMask.roleList || []).slice()
      if (!list[idx]) return
      var holder = (list[idx].conflict || {})[role]
      if (holder) {
        var self = this
        wx.showModal({
          title: '角色被占用',
          content: '该角色已被' + holder + '占用，确认替换？',
          confirmText: '替换',
          confirmColor: '#B85450',
          cancelText: '取消',
          success: function(r) {
            if (!r.confirm) return
            var holderInList = list.some(function(x) { return x.name === holder })
            list = list.map(function(x) {
              return x.name === holder ? Object.assign({}, x, { role: '', replaced: true }) : x
            })
            // 占用者不在列表（家庭既有成员）→ 记录其 memberId 待后端清空
            var occTarget = (self._roleOccupied || {})[role]
            var clearMid = !holderInList && occTarget ? occTarget.memberId : ''
            list[idx] = Object.assign({}, list[idx], { role: role, clearMemberId: clearMid })
            self.setData({ 'ocrMask.roleList': self._applyRoleState(list) })
          }
        })
        return
      }
      list[idx] = Object.assign({}, list[idx], { role: role })
      this.setData({ 'ocrMask.roleList': this._applyRoleState(list) })
    },
    onRoleConfirm() {
      if (this._roleResolve) { this._roleResolve((this.data.ocrMask.roleList || []).slice()); this._roleResolve = null }
    },
    onRolePrev() {
      if (this._roleResolve) { var r = this._roleResolve; this._roleResolve = null; r(null) }
    },

    // ============ 编辑 sheet（已移除）============
    // 2026-10-13 产品决策：识别结果弹窗只留「取消 / 保存」，不做点击修改。
    // 原 onEditCard（点卡片看/改）、onEditSheetSave（保存编辑结果 + 手动录入新增）、
    // onEditSheetClose 全部移除 → 编辑一律到「报告 → 保单列表」做（那边复用同一 edit-sheet）。
    // 随之不再需要的私有实现 `_buildSheetFields` / `_fieldLabels` / `_fieldTone` /
    // `_manualFileId` 暂时保留但已无调用方（YAGNI 清理留待下一轮，避免本轮 diff 过大）。

    // ============ 保存态 ============
    onFailedRetry() { if (!this._disposed) this._doSave() },
    onFailedBack() {
      if (this._disposed) return
      // 2026-09-19 修（流程审计 P2-4）：失败态「放弃全部」必须同时清掉本地批次快照。
      // 否则 checkResume 在下次进入首页/报告页时再次弹"检测到未完成的保单处理…是否继续？"——
      // 用户刚明确放弃的批次又复活了。对照 done 放弃（L332-341）与移除最后一项（L363-367）：
      // 两处都 _clearBatch() + triggerEvent('discarded')，本路径此前两样都缺。
      this._clearBatch()
      this._procPolicies = []; this._procCash = []; this._procErrors = []
      this.setData(Object.assign(flow.hide(), { 'ocrMask._policies': [], 'ocrMask._cashValues': [], 'ocrMask._familyId': '' }))
      this._emitBusy()
      this.triggerEvent('discarded')
    },
    onSavedHome() {
      if (this._disposed) return
      clearTimeout(this._savedTick)
      this._savedEmitted = true // 防 detached 兜底再发 saved 导致误跳报告页
      this.setData(flow.hide())
      this._clearBatch()
      this._emitBusy()
      // 手动返回首页：通知父页面刷新列表（不跳报告页；页面未离开故 onShow 不会触发）
      this.triggerEvent('savedhome', {
        familyId: this.data.ocrMask._familyId || this.properties.familyId || '',
        savedPolicies: this.data.ocrMask.savedPolicies || 0,
        savedCash: this.data.ocrMask.savedCash || 0
      })
    },
    onSavedEnter() { this._finishSaved(true) },
    _showSaved(savedPolicies, savedCash) {
      var self = this
      clearTimeout(this._savedTick)
      this._clearBatch()
      this.setData({ 'ocrMask.visible': true, 'ocrMask.phase': 'saved', 'ocrMask.confirming': false, 'ocrMask.savedPolicies': savedPolicies || 0, 'ocrMask.savedCash': savedCash || 0 })
      this._emitBusy()
      // 2026-09-09 UX：2s → 3s（原文案"已保存 N 份"常来不及读完就被跳走）
      this._savedTick = setTimeout(function() { self._finishSaved(false) }, self.properties.skipMatch ? 1000 : 3000)
    },
    _finishSaved(manual) {
      if (this._disposed || this._savedEmitted) return
      this._savedEmitted = true
      clearTimeout(this._savedTick)
      this.setData(flow.hide())
      this._emitBusy()
      this.triggerEvent('saved', {
        familyId: this.data.ocrMask._familyId || this.properties.familyId || '',
        savedPolicies: this.data.ocrMask.savedPolicies || 0,
        savedCash: this.data.ocrMask.savedCash || 0,
        manual: !!manual
      })
    },

    // ============ 辅助 ============
    _fieldLabels() {
      return {
        product_name: '产品名称', insurance_category: '险种', policy_number: '保单号', insurer: '保险公司',
        effective_date: '生效日期', insured_name: '被保险人', policyholder_name: '投保人', beneficiary_name: '受益人',
        sum_assured: '保额(万)', payment_method: '缴费方式', payment_period: '缴费年限', annual_premium: '年缴保费(元)',
        insurance_period: '保障期限'
      }
    },
    // 置信度三档 → 底色 tone（设计稿：高白/中淡黄/低淡橙/已修改浅蓝）
    _fieldTone(conf) {
      if (conf < 0.8) return 'low'
      if (conf < OCR_RELIABLE_THRESHOLD) return 'mid'
      return 'high'
    },
    _buildSheetFields(p) {
      var p2 = p || {}
      var fc = p2.field_confidence || {}
      var tone = {}
      Object.keys(fc).forEach(function(f) { tone[f] = this._fieldTone(fc[f]) }, this)
      // 无逐字段置信度时，按整体 confidence 兜底标关键字段
      var hasTone = Object.keys(tone).length > 0
      if (!hasTone && (p2.confidence || 0) < 0.8) {
        var lowAll = ['product_name', 'policy_number', 'insured_name', 'sum_assured', 'annual_premium', 'effective_date']
        lowAll.forEach(function(f) { tone[f] = 'low' })
      } else if (!hasTone && (p2.confidence || 0) < OCR_RELIABLE_THRESHOLD) {
        var midAll = ['product_name', 'policy_number', 'insured_name', 'sum_assured', 'annual_premium', 'effective_date']
        midAll.forEach(function(f) { tone[f] = 'mid' })
      }
      var FL = this._fieldLabels()
      var GROUPS = [
        { title: '基础信息', keys: ['product_name', 'insurance_category', 'policy_number', 'insurer', 'effective_date'] },
        { title: '人员信息', keys: ['insured_name', 'policyholder_name', 'beneficiary_name'] },
        { title: '缴费信息', keys: ['payment_method', 'payment_period', 'annual_premium'] },
        { title: '保障信息', keys: ['sum_assured', 'insurance_period'] }
      ]
      // 保单基本必填：产品名称/被保人/保额/保障期限(effective_date)/年缴保费/缴费年期
      var REQUIRED_KEYS = ['product_name', 'insured_name', 'sum_assured', 'effective_date', 'annual_premium', 'payment_period']
      var result = []
      GROUPS.forEach(function(g) {
        var fields = g.keys.filter(function(k) { return FL[k] !== undefined }).map(function(k) {
          // 高置信度 → ''（空串，与 report 侧 toneOf 语义对齐）：edit-sheet 仅 tone 非空才渲染 ⚠️，
          // 原 'high' 非空导致所有字段都带 ⚠️（曾全线误显）
          var t = tone[k] || ''
          // UI 审计 A-S1：数值字段补 type:'digit'（原弹文本键盘，保额/保费/年限手动切数字）
          // UI 审计 交互 M2/M1：必填星号；effective_date 走原生 date picker（与 edit-sheet 一致）
          // 数值字段补 pattern：兼容"80万/2亿/800,000"等单位与分隔写法，仅拦截纯非数字（原 _validateSheet 能力）
          var isNum = SHEET_NUMERIC_KEYS.indexOf(k) !== -1
          // 审计 #3：保额以「万」呈现（与 edit-form 契约一致），保存时转回元。
          // 原展示元数字而 label 裸「保额」+ digit 键盘 → 用户按"万"心智填 80，落库 80 元（差 1e4）
          var dispVal = p2[k] || ''
          if (k === 'sum_assured' && p2.sum_assured != null && p2.sum_assured !== '') {
            var saS = String(p2.sum_assured).replace(/[,，\s]/g, '')
            if (/万$/.test(saS)) dispVal = saS.slice(0, -1)                        // OCR 原始值已是「万」
            else if (/^\d+(\.\d+)?$/.test(saS)) dispVal = String(yuanToWan(saS))   // 元 → 万
            else dispVal = saS                                                      // 亿/元等保留原值
          }
          var f = { key: k, label: FL[k], value: dispVal, tone: t, confidence: t === 'low' ? 0.4 : (t === 'mid' ? 0.7 : 1), modified: false, required: REQUIRED_KEYS.indexOf(k) !== -1, type: k === 'effective_date' ? 'date' : (isNum ? 'digit' : 'text') }
          if (isNum) { f.pattern = '^[0-9万亿,，.\\s]+$'; f.patternMsg = '「' + FL[k] + '」需为数字' }
          return f
        })
        if (fields.length > 0) {
          result.push({ isGroup: true, label: g.title })
          fields.forEach(function(f) { result.push(f) })
        }
      })
      return result
    },
    async _ocrRetryOne(fileId, localPath) {
      var newFileId = fileId || ''
      try {
        var mask = this.data.ocrMask
        var opts = { familyId: mask._familyId || this.properties.familyId || '', thumbs: [localPath] }
        var ocrRes = null
        if (newFileId) {
          // S3-2：优先用云端 fileId 直 OCR（跨会话仍有效，不重传）
          // 2026-09-09：优先复用已缓存的 OCR 文本 → 只重跑 AI，省一次 OCR 计费（约 0.5 元/张）
          // 无缓存（跨会话恢复/新上传）时回退完整链路 batchOCR
          var cached = flow.getCachedOcrText(newFileId)
          if (cached) {
            ocrRes = await flow.retryAiOnly([{ fileId: newFileId, ocrText: cached.ocrText, ocrConfInfo: cached.ocrConfInfo }], opts)
          } else {
            ocrRes = await flow.batchOCR([newFileId], null, opts)
          }
          var firstErr = (ocrRes.errors || [])[0]
          var fileGone = !!(ocrRes.errors && ocrRes.errors.length && firstErr && firstErr.error_code && /file|not_found|no_such/.test(firstErr.error_code))
          if (fileGone) newFileId = ''
        }
        if (!newFileId) {
          // fileId 失效 → 回退本地重传
          if (!localPath) return { policies: [], cashValues: [], error: '缺少图片，无法重试' }
          // R3v2 审计 #4：重传同样走 openid 分区路径，保持 ocrService 归属校验通过
          var _app2 = typeof getApp === 'function' ? getApp() : null
          var _ownerPrefix2 = 'temp/' + ((_app2 && _app2.globalData && _app2.globalData.openid) || 'anon')
          var upRes = await flow.compressAndUpload([localPath], null, _ownerPrefix2)
          newFileId = upRes.fileIds[0]
          if (!newFileId) return { policies: [], cashValues: [], error: '上传失败' }
          ocrRes = await flow.batchOCR([newFileId], null, opts)
        }
        var newPolicies = ocrRes.policies || []
        var newCash = ocrRes.cashValues || []
        if (this._disposed) return { policies: [], cashValues: [], error: '已取消' }
        return { policies: newPolicies, cashValues: newCash, newFileId: newFileId, error: newPolicies.length ? '' : '识别失败' }
      } catch (e) {
        return { policies: [], cashValues: [], error: (e && e.message) || '重试失败', newFileId: newFileId }
      }
    }
  }
})
// 相对时间文案（恢复弹窗：让用户知道"这批"是什么时候的）
function _timeAgo(ts) {
  var mins = Math.max(1, Math.round((Date.now() - (ts || 0)) / 60000))
  if (mins < 60) return mins + ' 分钟前'
  var hours = Math.round(mins / 60)
  if (hours < 24) return hours + ' 小时前'
  return Math.round(hours / 24) + ' 天前'
}
function apiGetFamily(familyId) {
  return api('getFamily', { familyId: familyId }).then(function(r) { return r.ok ? r.data : null }).catch(function() { return null })
}
