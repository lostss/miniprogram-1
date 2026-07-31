/**
 * ocr-flow 组件 — OCR 全链路流程（首页/报告页共用）
 * 属性：skipMatch(报告页跳过匹配) / familyId(报告页当前家庭)
 * 事件：saved{familyId,savedPolicies,savedCash} / discarded
 * 方法：chooseAndStart() / startWithPaths(paths) / checkResume()
 */
const flow = require('../../utils/ocr-flow')
const session = require('../../utils/session-store')
const api = require('../../utils/apiClient')

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
      wx.showModal({
        title: '检测到未完成的保单处理',
        content: '上次处理进度：已识别 ' + batch.policies.length + ' 份保单，等待家庭匹配。是否继续？',
        confirmText: '继续处理', cancelText: '放弃',
        success: function(r) {
          if (self._disposed) return
          if (r.confirm) {
            self._procPolicies = batch.policies || []
            self._procCash = batch.cashValues || []
            self._procErrors = (batch.errors || []).map(function(e) { return { fileId: e.fileId, thumb: e.thumb || '', error: e.error || '识别失败', retrying: false } })
            self._procFamilyId = self.properties.familyId || ''
            self._procRefresh()
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
      if (this._ocrBusy) return
      this._ocrBusy = true
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
        var upResult = await flow.compressAndUpload(tempFiles, upProgress)
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
            allPolicies = ocrRes.policies || []; cashValues = ocrRes.cashValues || []; errors = ocrRes.errors || []
          } catch (e2) { errors.push({ error: (e2 && e2.message) || 'OCR异常', error_code: 'ocr_exception' }) }
          clearInterval(this._ocrTick)
        }
        console.log('[OCR] 全批次收齐, 耗时:' + (Date.now() - tStart) + 'ms, 产品:' + allPolicies.length + ', 失败:' + errors.length)
        if (this._disposed) return
        if (allPolicies.length === 0 && cashValues.length > 0) {
          var activeFid = this.properties.familyId || session.getActiveFamily()
          if (!activeFid) {
            wx.showModal({ title: '需要先创建家庭', content: '现价表需关联到家庭，请先上传保单或创建家庭后再试。', showCancel: false, confirmText: '知道了' })
            return
          }
          var cr = await flow.saveCashValuesWithRetry(activeFid, cashValues, setData)
          if (cr.ok) wx.showToast({ title: cr.matched ? '现价表已关联保单' : '现价表已保存，可手动关联保单', icon: cr.matched ? 'success' : 'none', duration: cr.matched ? 1500 : 2500 })
          return
        }
        if (allPolicies.length === 0) {
          var lastErrObj = errors.length > 0 ? errors[errors.length - 1] : null
          var ui = flow.errorToUI(lastErrObj)
          var isSkippable = (lastErrObj && lastErrObj.error_code) === 'not_policy'
          wx.showModal({
            title: ui.title || '无可识别保单',
            content: isSkippable ? '当前图片中无新保单可识别' : '遇到点问题，请重试',
            showCancel: !isSkippable, confirmText: isSkippable ? '知道了' : '重试',
            success: function(res) { if (self._disposed) return; if (res.confirm && !isSkippable) self._startOCR(tempFiles) }
          })
          return
        }
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
    onProcDiscardAll() {
      var self = this
      if (this.data.ocrMask.confirming || this.data.ocrMask.procBusy) return
      wx.showModal({
        title: '全部放弃',
        content: '将丢弃本次识别的所有结果，不保存任何内容。确定吗？',
        confirmText: '放弃', confirmColor: '#B85450',
        success: function(r) {
          if (!r.confirm || self._disposed) return
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
          if (this.properties.skipMatch) return
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
      if (!ok || !ok.ok) { this.setData(flow.setFailed((ok && ok.error) || '写入失败，请检查网络后重试')); return }
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
        }
      }
      var savedCount = policies.length, cashCount = (cashValues || []).length, self = this
      wx.nextTick(function() { if (!self._disposed) self._showSaved(savedCount, cashCount) })
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
    onSheetClose() { this.setData({ 'ocrSheet.visible': false }) },
    onSheetConfirm() {
      var sheet = this.data.ocrSheet
      if (!sheet.visible) return
      if (sheet.policyIndex === -1) {
        var np = {}
        ;(sheet.fields || []).forEach(function(f) {
          if (f.isGroup) return
          var v = (f.value || '').trim()
          if (v) { np[f.key] = v; np.field_confidence = np.field_confidence || {}; np.field_confidence[f.key] = 0.99 }
        })
        if (!np.product_name) { wx.showToast({ title: '请填写产品名称', icon: 'none' }); return }
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
          return { key: k, label: FL[k], value: p2[k] || '', tone: t, confidence: t === 'low' ? 0.4 : (t === 'mid' ? 0.7 : 1), modified: false }
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
          var upRes = await flow.compressAndUpload([localPath], null)
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
