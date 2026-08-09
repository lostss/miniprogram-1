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

// UI 审计 A-S1/A-S2/A-S3：OCR 编辑/手动录入共用的数值字段清单（弹数字键盘 + 校验）
const SHEET_NUMERIC_KEYS = ['sum_assured', 'annual_premium', 'payment_period', 'guaranteed_years']

Component({
  properties: {
    skipMatch: { type: Boolean, value: false },
    familyId: { type: String, value: '' }
  },
  data: {
    ocrMask: flow.defaultState(),
    ocrSheet: { visible: false, policyIndex: -1, fields: [], title: '' }
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
        content: '上次处理进度：已识别 ' + batch.policies.length + ' 份保单，等待家庭匹配。是否继续？',
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
            setTimeout(function() { if (self._disposed) return; self._procRefresh(); self._ocrBusy = false }, 300)
          } else self._clearBatch()
        }
      })
    },
    _persistBatch() {
      try { wx.setStorageSync('ocrBatch', { policies: this._procPolicies || [], cashValues: this._procCash || [], errors: (this._procErrors || []).map(function(e) { return { fileId: e.fileId, thumb: e.thumb || '', error: e.error || '识别失败' } }), savedAt: Date.now() }) } catch (e) { console.error('[ocr-flow] persistBatch:', e) }
    },
    _clearBatch() { try { wx.removeStorageSync('ocrBatch') } catch (e) {} },
    _emitBusy() { this.triggerEvent('busychange', { busy: !!this.data.ocrMask.visible }) },

    // ============ 主流程 ============
    async _startOCR(tempFiles) {
      // UI 审计 F-S4：确认卡/结果卡打开（visible=true）时禁止新 OCR，防覆盖当前处理中的批
      if (this._ocrBusy || this.data.ocrMask.visible) return
      this._ocrBusy = true
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
        var validThumbs = []
        for (var i = 0; i < upResult.fileIds.length; i++) {
          if (upResult.fileIds[i]) { allFileIds.push(upResult.fileIds[i]); validThumbs.push(upResult.localPaths[i] || tempFiles[i]) }
        }
        var validIds = allFileIds.filter(function(id) { return !!id })
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
        if (allPolicies.length === 0 && cashValues.length > 0) {
          var activeFid = this.properties.familyId || session.getActiveFamily()
          if (!activeFid) {
            wx.showModal({ title: '需要先创建家庭', content: '现价表需关联到家庭，请先上传保单或创建家庭后再试。', showCancel: false, confirmText: '知道了' })
            return
          }
          var cr = await flow.saveCashValuesWithRetry(activeFid, cashValues, setData)
          if (cr.ok) {
            wx.showToast({ title: cr.matched ? '现价表已关联保单' : '现价表已保存，可手动关联保单', icon: cr.matched ? 'success' : 'none', duration: cr.matched ? 1500 : 2500 })
            // 存储审计 P1：纯现价表保存也 emit saved（原 return 前无 triggerEvent，首页/报告页无感知入库）
            this.triggerEvent('saved', { familyId: activeFid, matched: !!cr.matched })
          }
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
        wx.showModal({ title: '识别失败', content: '遇到点问题，请重试', showCancel: false, confirmText: '重试', success: function() { if (!this._disposed) this._startOCR(tempFiles) }.bind(this) })
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
    async onProcRetryOne(e) {
      var fileId = e.currentTarget.dataset.fileid
      if (this.data.ocrMask.procBusy) return
      var self = this, err = null
      ;(this._procErrors || []).forEach(function(x) { if (x.fileId === fileId) err = x })
      if (!err || err.retrying) return
      err.retrying = true
      this.setData({ 'ocrMask.procBusy': true })
      this._procRefresh()
      var r = await this._ocrRetryOne(fileId, err.thumb)
      if (this._disposed) return
      if (r.newFileId) { try { flow.cleanupTempFiles([r.newFileId]) } catch (e2) {} }
      this._procErrors = (this._procErrors || []).filter(function(x) { return x.fileId !== fileId })
      if (r.policies && r.policies.length) {
        ;(r.policies).forEach(function(p) { self._procPolicies.push(p) })
        ;(r.cashValues || []).forEach(function(cv) { self._procCash.push(cv) })
      } else {
        this._procErrors.push({ fileId: fileId, thumb: err.thumb, error: r.error || '识别失败', retrying: false })
        wx.showToast({ title: r.error || '重试失败', icon: 'none' })
      }
      this.setData({ 'ocrMask.procBusy': false })
      this._procRefresh(); this._persistBatch()
    },
    async onProcRetryAll() {
      var self = this
      var errs = (this._procErrors || []).filter(function(x) { return !x.retrying })
      if (!errs.length || this.data.ocrMask.procBusy) return
      this.setData({ 'ocrMask.procBusy': true })
      var results = await Promise.allSettled(errs.map(function(x) { return self._ocrRetryOne(x.fileId, x.thumb) }))
      if (this._disposed) return
      var stillFailed = []
      results.forEach(function(rs, i) {
        var r = rs.status === 'fulfilled' ? rs.value : null
        if (r && r.newFileId) { try { flow.cleanupTempFiles([r.newFileId]) } catch (e2) {} }
        if (r && r.policies && r.policies.length) {
          ;(r.policies).forEach(function(p) { self._procPolicies.push(p) })
          ;(r.cashValues || []).forEach(function(cv) { self._procCash.push(cv) })
        } else stillFailed.push({ fileId: errs[i].fileId, thumb: errs[i].thumb, error: (r && r.error) || '识别失败', retrying: false })
      })
      this._procErrors = stillFailed
      this.setData({ 'ocrMask.procBusy': false })
      this._procRefresh(); this._persistBatch()
      if (!stillFailed.length) wx.showToast({ title: '全部重试成功', icon: 'none' })
    },
    onProcManualAdd(e) {
      var fileId = e.currentTarget.dataset.fileid
      if (this.data.ocrMask.procBusy) return
      this._manualFileId = fileId
      this.setData({ 'ocrSheet.visible': true, 'ocrSheet.policyIndex': -1, 'ocrSheet.fields': this._buildSheetFields({}), 'ocrSheet.title': '手动录入保单' })
    },
    onProcPreview(e) {
      var src = e.currentTarget.dataset.src
      if (!src) return
      wx.previewImage({ urls: [src], fail: function() { wx.showToast({ title: '图片已过期', icon: 'none' }) } })
    },
    // UI 审计 交互 S1：宿主页 onBackPress 委托入口（report/index 两页共用）
    // 返回键行为：先关编辑 sheet → saving 阶段不可中断 → 其余阶段确认放弃
    onBackPressed() {
      const mask = this.data.ocrMask
      if (!mask.visible) return false
      if (this.data.ocrSheet.visible) { this.setData({ 'ocrSheet.visible': false }); return true }
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
          self.setData(Object.assign(flow.hide(), { 'ocrMask._policies': [], 'ocrMask._cashValues': [], 'ocrMask._familyId': '' }))
          self._clearBatch()
          self._emitBusy()
          wx.showToast({ title: '已放弃本次结果', icon: 'none' })
          self.triggerEvent('discarded')
        }
      })
    },

    // ============ 全部确认 → 保存链 ============
    onProcConfirm() {
      var mask = this.data.ocrMask
      if (mask.confirming || mask.procBusy) return
      var errCount = (this._procErrors || []).length, reviewCount = (mask.procReview || []).length, self = this
      if (errCount > 0 || reviewCount > 0) {
        wx.showModal({
          title: '还有保单未处理',
          content: '识别异常 ' + errCount + ' 份，待核对 ' + reviewCount + ' 份。确认后异常将被丢弃，待核对项按当前结果保存。',
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
      if (!policies.length && !cashValues.length) { this.setData(flow.hide()); this._emitBusy(); return }
      var pick = null
      if (this.properties.skipMatch && this.properties.familyId) {
        pick = this.properties.familyId
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
          if (this.properties.skipMatch) { this.setData(flow.hide()); return }
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
      // 写入成功后回写 familyId（_procRefresh 时匹配未定，_familyId 仍为空；
      // saved 事件依赖它跳转报告页，缺失会导致"缺少客户信息"）
      this._procFamilyId = familyId
      this.setData({ 'ocrMask._familyId': familyId })
      // 新成员角色补写：后端已在写入时创建成员，按姓名查 member_id 更新角色
      if (newRoles.length) {
        var fam = await apiGetFamily(familyId)
        if (this._disposed) return
        if (fam) {
          await Promise.all(newRoles.map(function(rp) {
            var m = (fam.members || []).find(function(x) { return x.name === rp.name })
            if (m && m.member_id) return api('updateMember', { familyId: familyId, memberId: m.member_id, field: 'role', value: rp.role }).catch(function() {})
          }))
        } else {
          // UI 审计 F-S3：角色补写失败不再静默吞错（保单已写入，提示用户稍后可手动调整角色）
          errorHandler.handle({ msg: '成员角色同步失败（apiGetFamily 返回空）' }, { silent: true, context: 'ocrRoleWrite' })
          wx.showToast({ title: '保单已保存，角色信息待同步', icon: 'none' })
        }
      }
      var savedCount = policies.length, cashCount = (cashValues || []).length, self = this
      wx.nextTick(function() { if (!self._disposed) self._showSaved(savedCount, cashCount) })
      } finally {
        this._saving = false
      }
    },

    // ============ 匹配弹窗 ============
    async _runMatchStage(allPolicies) {
      var holderCount = {}
      allPolicies.forEach(function(p) { const n = p.policyholder_name || p.insured_name; if (n) holderCount[n] = (holderCount[n] || 0) + 1 })
      var sorted = Object.keys(holderCount).sort(function(a, b) { return holderCount[b] - holderCount[a] })
      var primaryHolder = sorted[0] || '新客户'
      var bloodNames = [primaryHolder], seen = { [primaryHolder]: true }
      function _add(name) { if (name && !seen[name]) { seen[name] = true; bloodNames.push(name) } }
      allPolicies.forEach(function(p) {
        _add(p.insured_name)
        if (p.beneficiary_name && !/法定|法定继承人|未指定/.test(p.beneficiary_name)) _add(p.beneficiary_name)
      })
      var candidates = []
      var cachedId = session.getMatchCache(primaryHolder)
      var self = this
      if (cachedId) {
        var cached = await apiGetFamily(cachedId)
        if (this._disposed) return null
        if (cached) candidates.push(cached)
      } else {
        var matchRes = await api('searchFamilies', { keyword: primaryHolder })
        if (this._disposed) return null
        if (matchRes.ok) {
          var cands = (matchRes.data.families || []).filter(function(c) { return c.name === primaryHolder })
          if (cands.length > 0) {
            var details = await Promise.all(cands.map(function(c) { return apiGetFamily(c._id).then(function(f) { return { c: c, f: f } }).catch(function() { return { c: c, f: null } }) }))
            if (this._disposed) return null
            details.forEach(function(item) { if (item.f) candidates.push(item.f) })
          }
        }
      }
      var defaultPick = candidates.length > 0 ? candidates[0]._id : 'new'
      this._stageCtx = { primaryHolder: primaryHolder, bloodNames: bloodNames }
      var candsUI = candidates.map(function(c) {
        return { _id: c._id, name: c.name, membersText: (c.members || []).map(function(m) { return m.name + (m.role ? '(' + m.role + ')' : '') }).join('、') }
      })
      this.setData({ 'ocrMask.visible': true, 'ocrMask.phase': 'match', 'ocrMask.matchCandidates': candsUI, 'ocrMask.matchPick': defaultPick })
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
      var birthMap = {}
      ;(allPolicies || []).forEach(function(p) {
        if (p.policyholder_name && p.policyholder_birth_date) birthMap[p.policyholder_name] = p.policyholder_birth_date
        if (p.insured_name && p.insured_birth_date) birthMap[p.insured_name] = p.insured_birth_date
        if (p.beneficiary_name && p.beneficiary_birth_date) birthMap[p.beneficiary_name] = p.beneficiary_birth_date
      })
      function _age(b) { if (!b) return NaN; var d = new Date(b); if (isNaN(d.getTime())) return NaN; return new Date().getFullYear() - d.getFullYear() }
      function _infer(name, sa) {
        var a = _age(birthMap[name])
        if (isNaN(a) || isNaN(sa)) return null
        var d = sa - a
        if (d > 18) return '子女'
        if (d < -18) return '父母'
        return '配偶'
      }
      var selfAge = _age(birthMap[ctx.primaryHolder])
      // 家庭既有角色占用（本人/配偶 全局唯一），携带 memberId 供替换清除
      var occupied = {}
      ;(family.members || []).forEach(function(m) {
        if (m.role === '本人' || m.role === '配偶') occupied[m.role] = { name: m.name, memberId: m.member_id }
      })
      // 默认推测：跳过已被占用的角色
      function _inferRole(name, sa) {
        var r = _infer(name, sa) || '其他'
        if ((r === '本人' || r === '配偶') && occupied[r]) return '其他'
        return r
      }
      var roleList = [], existingNames = {}
      ;(family.members || []).forEach(function(m) { existingNames[m.name] = true })
      if (isNew) {
        ;(family.members || []).forEach(function(m) { roleList.push({ name: m.name, memberId: m.member_id, role: m.role === '本人' ? '本人' : _inferRole(m.name, selfAge), isNew: false }) })
      } else {
        ;(family.members || []).forEach(function(m) { if (!m.role || m.role === '') roleList.push({ name: m.name, memberId: m.member_id, role: _inferRole(m.name, selfAge), isNew: false }) })
        ctx.bloodNames.forEach(function(n) {
          if (!existingNames[n]) {
            var role = _inferRole(n, selfAge)
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
        return api('updateMember', { familyId: familyId, memberId: mid, field: 'role', value: '' }).catch(function() {})
      }))
      var updates = confirmed.filter(function(r) { return r.role && !r.isNew && r.memberId }).map(function(rr) {
        return api('updateMember', { familyId: familyId, memberId: rr.memberId, field: 'role', value: rr.role }).catch(function() {})
      })
      await Promise.all(updates)
      if (this._disposed) return null
      // 新成员角色：真实 member_id 由后端 matchPoliciesToMembers 在写入时创建，
      // 此处带回 name+role，由 _doSave 在写入成功后按姓名补角色
      var newRoles = confirmed.filter(function(r) { return r.isNew && r.role }).map(function(rr) { return { name: rr.name, role: rr.role } })
      return { familyId: familyId, newRoles: newRoles }
    },
    // 实时互斥：家庭占用 + 列表内已选 → 每项 conflict { 角色: 占用者姓名 }
    _applyRoleState(list) {
      var occ = {}
      var occupied = this._roleOccupied || {}
      Object.keys(occupied).forEach(function(k) { occ[k] = occupied[k].name })
      for (var i = 0; i < list.length; i++) {
        var r = list[i]
        if (r.role === '本人' || r.role === '配偶') occ[r.role] = r.name
      }
      return list.map(function(r) {
        var conflict = {}
        if (occ['本人'] && occ['本人'] !== r.name) conflict['本人'] = occ['本人']
        if (occ['配偶'] && occ['配偶'] !== r.name) conflict['配偶'] = occ['配偶']
        return Object.assign({}, r, { conflict: conflict })
      })
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

    // ============ 编辑 sheet ============
    onEditCard(e) {
      var pi = e.currentTarget.dataset.policyindex
      var mask = this.data.ocrMask
      if (mask.confirming || mask.procBusy) return
      var p = (this._procPolicies || [])[pi]
      if (!p) return
      this.setData({ 'ocrSheet.visible': true, 'ocrSheet.policyIndex': pi, 'ocrSheet.fields': this._buildSheetFields(p), 'ocrSheet.title': '编辑 · ' + (p.product_name || '保单') })
    },
    onSheetInput(e) {
      var fi = e.currentTarget.dataset.fi
      // 已修改：浅蓝底 + ⚠️ 消失（confidence 提升为高）
      var patch = {}
      patch['ocrSheet.fields[' + fi + '].value'] = e.detail.value
      patch['ocrSheet.fields[' + fi + '].modified'] = true
      patch['ocrSheet.fields[' + fi + '].tone'] = 'modified'
      patch['ocrSheet.fields[' + fi + '].confidence'] = 1
      this.setData(patch)
    },
    // UI 审计 交互 M1：effective_date 原生 date picker 选择（与 edit-sheet 一致）
    onSheetDateChange(e) {
      var fi = e.currentTarget.dataset.fi
      var patch = {}
      patch['ocrSheet.fields[' + fi + '].value'] = e.detail.value
      patch['ocrSheet.fields[' + fi + '].modified'] = true
      patch['ocrSheet.fields[' + fi + '].tone'] = 'modified'
      patch['ocrSheet.fields[' + fi + '].confidence'] = 1
      this.setData(patch)
    },
    // UI 审计 交互 M4：关闭即清空 sheet 状态，防下次打开残留旧字段
    onSheetClose() { this.setData({ 'ocrSheet.visible': false, 'ocrSheet.fields': [], 'ocrSheet.policyIndex': -1, 'ocrSheet.title': '' }) },
    // UI 审计 A-S2/A-S3：编辑/手动录入共用字段校验（产品名称必填 + 数值格式 + 日期格式）
    // requireProduct：新增模式下即使 fields 未包含 product_name 也强制必填
    _validateSheet(sheet, requireProduct) {
      var err = ''
      var hasProduct = false
      ;(sheet.fields || []).forEach(function(f) {
        if (f.isGroup || err) return
        var v = (f.value || '').trim()
        if (f.key === 'product_name') {
          hasProduct = true
          if (!v) err = '请填写产品名称'
          return
        }
        if (!v) return
        // 兼容"80万/2亿/800,000"等单位与分隔写法，仅拦截纯非数字（如"abc"）
        if (SHEET_NUMERIC_KEYS.indexOf(f.key) !== -1 && isNaN(Number(v.replace(/[万亿,，\s]/g, '')))) {
          err = '「' + f.label + '」需为数字'; return
        }
        if (f.key === 'effective_date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
          err = '「' + f.label + '」格式应为 YYYY-MM-DD'; return
        }
      })
      if (!err && requireProduct && !hasProduct) err = '请填写产品名称'
      return err
    },
    onSheetConfirm() {
      var sheet = this.data.ocrSheet
      if (!sheet.visible) return
      var err = this._validateSheet(sheet, sheet.policyIndex === -1)
      if (err) { wx.showToast({ title: err, icon: 'none' }); return }
      if (sheet.policyIndex === -1) {
        var np = {}
        ;(sheet.fields || []).forEach(function(f) {
          if (f.isGroup) return
          var v = (f.value || '').trim()
          if (v) { np[f.key] = v; np.field_confidence = np.field_confidence || {}; np.field_confidence[f.key] = 0.99 }
        })
        np.confidence = 0.99
        this._procPolicies.push(np)
        var fid = this._manualFileId
        if (fid) { this._procErrors = (this._procErrors || []).filter(function(x) { return x.fileId !== fid }) }
        this._manualFileId = ''
        this.setData({ 'ocrSheet.visible': false })
        this._procRefresh(); this._persistBatch()
        return
      }
      var policies = (this._procPolicies || []).slice()
      var p = policies[sheet.policyIndex]
      if (!p) { this.setData({ 'ocrSheet.visible': false }); return }
      var np2 = Object.assign({}, p)
      if (!np2.field_confidence) np2.field_confidence = {}
      ;(sheet.fields || []).forEach(function(f) {
        if (f.isGroup) return
        var v = (f.value || '').trim()
        if (v) { np2[f.key] = v; np2.field_confidence[f.key] = 0.99 }
        // UI 审计 A-M9：清空字段 = 删除错误识别值（原旧值保留，用户无法纠错）
        else { delete np2[f.key]; delete np2.field_confidence[f.key] }
      })
      policies[sheet.policyIndex] = np2
      this._procPolicies = policies
      this.setData({ 'ocrSheet.visible': false })
      this._procRefresh(); this._persistBatch()
    },

    // ============ 保存态 ============
    onFailedRetry() { if (!this._disposed) this._doSave() },
    onFailedBack() {
      if (this._disposed) return
      this._procPolicies = []; this._procCash = []; this._procErrors = []
      this.setData(Object.assign(flow.hide(), { 'ocrMask._policies': [], 'ocrMask._cashValues': [], 'ocrMask._familyId': '' }))
      this._emitBusy()
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
      this._savedTick = setTimeout(function() { self._finishSaved(false) }, self.properties.skipMatch ? 1000 : 2000)
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
        effective_date: '保障期限', insured_name: '被保险人', policyholder_name: '投保人', beneficiary_name: '受益人',
        sum_assured: '保额', payment_method: '缴费方式', payment_period: '缴费年限', annual_premium: '年缴保费',
        guaranteed: '保证领取', guaranteed_years: '保证领取年限'
      }
    },
    // 置信度三档 → 底色 tone（设计稿：高白/中淡黄/低淡橙/已修改浅蓝）
    _fieldTone(conf) {
      if (conf < 0.8) return 'low'
      if (conf < 0.95) return 'mid'
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
      } else if (!hasTone && (p2.confidence || 0) < 0.95) {
        var midAll = ['product_name', 'policy_number', 'insured_name', 'sum_assured', 'annual_premium', 'effective_date']
        midAll.forEach(function(f) { tone[f] = 'mid' })
      }
      var FL = this._fieldLabels()
      var GROUPS = [
        { title: '基础信息', keys: ['product_name', 'insurance_category', 'policy_number', 'insurer', 'effective_date'] },
        { title: '人员信息', keys: ['insured_name', 'policyholder_name', 'beneficiary_name'] },
        { title: '缴费信息', keys: ['payment_method', 'payment_period', 'annual_premium'] },
        { title: '保障信息', keys: ['sum_assured', 'guaranteed', 'guaranteed_years'] }
      ]
      var result = []
      GROUPS.forEach(function(g) {
        var fields = g.keys.filter(function(k) { return FL[k] !== undefined }).map(function(k) {
          var t = tone[k] || 'high'
          // UI 审计 A-S1：数值字段补 type:'digit'（原弹文本键盘，保额/保费/年限手动切数字）
          // UI 审计 交互 M2/M1：product_name 必填星号；effective_date 走原生 date picker（与 edit-sheet 一致）
          return { key: k, label: FL[k], value: p2[k] || '', tone: t, confidence: t === 'low' ? 0.4 : (t === 'mid' ? 0.7 : 1), modified: false, required: k === 'product_name', type: k === 'effective_date' ? 'date' : (SHEET_NUMERIC_KEYS.indexOf(k) !== -1 ? 'digit' : 'text') }
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
          // S2-3：沿用 batchOCR 自动分流（避免 DEEPSEEK_API_KEY 未配置时 parallel 报错）
          ocrRes = await flow.batchOCR([newFileId], null, opts)
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
function apiGetFamily(familyId) {
  return api('getFamily', { familyId: familyId }).then(function(r) { return r.ok ? r.data : null }).catch(function() { return null })
}
