const api = require('../../utils/apiClient')
const session = require('../../utils/session-store')
const flow = require('../../utils/ocr-flow')
const { navigateToFamily, confirmDeleteFamily } = require('../../utils/family-actions')

/** 保小秘 首页 */
Page({
  data: {
    recentClients: [], loadingClients: false,
    ocrMask: flow.defaultState()
  },

  onLoad() {},
  onUnload() { this._ocrBusy = false; this._pageDead = true; clearTimeout(this._navTimer); flow.forgetDedupCache() },
  onShow() { this._fetchClients() },

  async _fetchClients() {
    this.setData({ loadingClients: true })
    try {
      const res = await api('listFamilies', { limit: 3 })
      if (res.result && res.result.code === 200) this.setData({ recentClients: res.result.data.families || [], loadingClients: false })
      else this.setData({ loadingClients: false })
    } catch (e) { this.setData({ loadingClients: false }); console.error('获取客户列表失败:', e) }
  },

  onUploadTap() {
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (res) => {
        const sourceType = res.tapIndex === 0 ? ['camera'] : ['album']
        const MAX_SIZE = 10 * 1024 * 1024
        wx.chooseMedia({ sourceType, count: 9, mediaType: ['image'], sizeType: ['compressed'], success: (r) => {
          const valid = r.tempFiles.filter(f => f.size <= MAX_SIZE)
          if (valid.length < r.tempFiles.length) {
            wx.showToast({ title: (r.tempFiles.length - valid.length) + '张超过10MB已跳过', icon: 'none' })
          }
          if (valid.length === 0) return
          this._startOCR(valid.map(f => f.tempFilePath))
        } })
      }
    })
  },

  // 逐张流式 OCR 管线：全收齐 → 匹配+角色 → 展卡
  async _startOCR(tempFiles) {
    if (this._ocrBusy) return
    this._ocrBusy = true
    var tStart = Date.now()
    var total = tempFiles.length
    var setData = this.setData.bind(this)
    var allFileIds = []
    flow.forgetDedupCache()
    this.setData(flow.start(total))
    console.log('[OCR] ====== 开始, ' + total + ' 张 ======')
    try {
      var allPolicies = [], cashValues = [], errors = []
      var familyId = '', matched = false, uploaded = 0, processed = 0
      var batchSize = 3
      // ① 一次性全部上传（并发）
      var allUploadTasks = tempFiles.map(function(path) {
        return flow.compressAndUpload([path], setData).then(function(upResult) {
          return upResult.fileIds[0]
        }).catch(function() { return null })
      })
      var allUpResults = await Promise.allSettled(allUploadTasks)
      for (var i = 0; i < allUpResults.length; i++) {
        var fid = allUpResults[i].status === 'fulfilled' ? allUpResults[i].value : null
        if (fid) { allFileIds.push(fid); uploaded++ }
      }
      setData({ 'ocrMask.uploaded': uploaded, 'ocrMask.phaseText': '上传完成 ' + uploaded + '/' + total + ' 张' })
      // ② 全部传入 ocrSingle（云函数内错峰 AI，消除冷启动）
      var validIds = allFileIds.filter(function(id) { return !!id })
      if (validIds.length > 0) {
        try {
          var ocrRes = await flow.batchOCR(validIds, setData, { familyId: familyId })
          allPolicies = ocrRes.policies || []
          cashValues = ocrRes.cashValues || []
          errors = ocrRes.errors || []
          processed = validIds.length
          setData({ 'ocrMask.processed': processed, 'ocrMask.phaseText': '识别完成 ' + processed + '/' + total + ' 张' })
        } catch (e2) {
          errors.push({ error: (e2 && e2.message) || 'OCR异常', error_code: 'ocr_exception' })
        }
      }
      // 注意：流式回填期间 phase='recognize-stream'，UI 已展示占位+真实卡片
      // 此处 phaseText 在 batchOCR 内部已通过 setStreamingSlots 更新
      console.log('[OCR] 全批次收齐, 总OCR耗时:' + (Date.now() - tStart) + 'ms, 产品:' + allPolicies.length)
      // 全批次收齐 → 家庭匹配 + 角色补全
      if (allPolicies.length > 0 && !this._pageDead) {
        var mr = await this._matchOrCreate(allPolicies)
        familyId = mr.familyId
        matched = mr.matched
        await this._assignMemberRoles(familyId, allPolicies)
        console.log('[OCR] 匹配+角色完成, 累计耗时:' + (Date.now() - tStart) + 'ms, familyId:' + familyId)
      }
      // 清理云存储临时图片
      flow.cleanupTempFiles(allFileIds)
      if (this._pageDead) return
      // 纯现价表（无保单）→ 跳过家庭匹配，直接入库现价数据
      if (allPolicies.length === 0 && cashValues.length > 0) {
        this.setData(Object.assign(flow.setSaving(cashValues), { 'ocrMask.cashCount': cashValues.length }))
        var cr = await flow.saveCashValuesWithRetry(session.getActiveFamily(), cashValues, setData)
        if (cr.ok) {
          wx.showToast({ title: cr.matched ? '现价表已关联保单' : '现价表已保存，可手动关联保单', icon: cr.matched ? 'success' : 'none', duration: cr.matched ? 1500 : 2500 })
        }
        return
      }
      if (allPolicies.length === 0) {
        this.setData(flow.hide())
        var lastErrObj = errors.length > 0 ? errors[errors.length - 1] : null
        var lastErrCode = lastErrObj ? lastErrObj.error_code : null
        var ui = flow.errorToUI(lastErrObj || lastErrCode)
        var isSkippable = lastErrCode === 'not_policy' || (lastErrCode && lastErrCode.indexOf('dedup:') === 0)
        wx.showModal({
          title: ui.title || '无可识别保单',
          content: isSkippable ? '当前图片中无新保单可识别' : '遇到点问题，请重试',
          showCancel: !isSkippable,
          confirmText: isSkippable ? '知道了' : '重试',
          success: function(res) { if (res.confirm && !isSkippable) this._startOCR(tempFiles) }.bind(this)
        })
        return
      }
      if (errors.length > 0) console.warn('[index] OCR 部分失败:', errors.length, '张')
      this._renderCard(allPolicies, cashValues, familyId, matched)
    } catch (e) {
      console.error('OCR失败:', e)
      this.setData(flow.hide())
      wx.showModal({ title: '识别失败', content: '遇到点问题，请重试', showCancel: false, confirmText: '重试', success: function() { this._startOCR(tempFiles) }.bind(this) })
    } finally { flow.cleanupTempFiles(allFileIds); this._ocrBusy = false }
  },

  // 置信度分流 → 渲染确认卡或自动入库
  _renderCard: function(allPolicies, cashValues, familyId, matched) {
    var highPolicies = allPolicies.filter(function(p) { return (p.auto_confirmed !== false) && (p.confidence >= 0.95) })
    var lowPolicies = allPolicies.filter(function(p) { return !((p.auto_confirmed !== false) && p.confidence >= 0.95) })
    var preview = allPolicies.slice(0, 10).map(function(p) {
      return { product_name: p.product_name || '未知', insurance_category: p.insurance_category || '未知', low: !((p.auto_confirmed !== false) && p.confidence >= 0.95) }
    })
    if (lowPolicies.length === 0) {
      // Bug 修复：setData 异步，onOcrConfirm 不能依赖 this.data 读取
      // 直接传参绕开竞态，同时 setData 维持 UI 状态同步
      this.setData({ 'ocrMask._familyId': familyId, 'ocrMask._policies': allPolicies, 'ocrMask._cashValues': cashValues })
      this.onOcrConfirm({ _familyId: familyId, _policies: allPolicies, _cashValues: cashValues })
      return
    }
    this.setData(flow.setDone(allPolicies, cashValues, {
      'ocrMask.highConf': highPolicies.length, 'ocrMask.lowConf': lowPolicies.length,
      'ocrMask.matched': matched, 'ocrMask.preview': preview, 'ocrMask._familyId': familyId
    }))
  },

  // override 可选：高置信度自动入库路径传入，避免依赖 setData 异步刷新的 this.data
  // wxml bindtap 会传事件对象 e，需识别并回退到 this.data
  async onOcrConfirm(override) {
    const isOverride = override && override._policies
    const o = isOverride ? override : this.data.ocrMask
    const { _familyId, _policies, _cashValues, confirming } = o
    if (confirming) return
    if (!_policies || _policies.length === 0) {
      wx.showToast({ title: '无可写入保单', icon: 'none' })
      return
    }
    this.setData(flow.setConfirming(true))
    const setData = this.setData.bind(this)
    const ok = await flow.confirmWritePolicies(_familyId, _policies, _cashValues, setData)
    if (!ok || !ok.ok) {
      this.setData(flow.setConfirming(false))
      wx.showToast({ title: (ok && ok.error) || '写入失败，请重试', icon: 'none' })
      return
    }
    this.setData(Object.assign(flow.hide(), flow.setConfirming(false)))
    wx.showToast({ title: '小秘整理好了！', icon: 'success' })
    this._fetchClients()
    this._navTimer = setTimeout(() => { if (!this._pageDead) { session.setActiveFamily(_familyId); wx.navigateTo({ url: `/pages/report/index?familyId=${_familyId}` }) } }, 800)
  },

  // P3-3：OCR 错误码 → 用户提示映射（保留供 wxml 调用 / 测试 / 旧调用点使用）
  _ocrErrorUI(errorCode) { return flow.errorToUI(errorCode) },

  onOcrModify() {
    var mask = this.data.ocrMask
    if (!mask._policies || mask._policies.length === 0 || mask.confirming) return
    var familyId = mask._familyId, policies = mask._policies, cashValues = mask._cashValues
    this.setData({ 'ocrMask.confirming': true })
    api('writePoliciesBatch', { familyId: familyId, policies: policies, cash_values: cashValues }).then(function() {
      if (this._pageDead) return
      this.setData(Object.assign(flow.hide(), flow.setConfirming(false)))
      session.setActiveFamily(familyId)
      wx.navigateTo({ url: '/pages/report/index?familyId=' + familyId + '&focus=review' })
    }.bind(this)).catch(function() {
      if (this._pageDead) return
      this.setData(flow.setConfirming(false))
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }.bind(this))
  },

  // 角色卡片：单选切换
  onRolePick(e) {
    var idx = e.currentTarget.dataset.idx
    var role = e.currentTarget.dataset.role
    var list = (this.data.ocrMask.roleList || []).slice()
    list[idx] = Object.assign({}, list[idx], { role: role })
    this.setData({ 'ocrMask.roleList': list })
  },
  // 角色卡片：确认全部
  onRoleConfirm() {
    if (this._roleResolve) { this._roleResolve((this.data.ocrMask.roleList || []).slice()); this._roleResolve = null }
  },

  // ponytail: 同名客户消歧。多候选时若成员交叉匹配命中多个→弹选择器；仅1个命中→自动选
  async _matchOrCreate(allPolicies) {
    const holderCount = {}
    allPolicies.forEach(p => { const name = p.policyholder_name || p.insured_name; if (name) holderCount[name] = (holderCount[name] || 0) + 1 })
    const sorted = Object.entries(holderCount).sort((a, b) => b[1] - a[1])
    const primaryHolder = sorted[0] ? sorted[0][0] : '新客户'
    // 血缘姓名：投保人 + 被保人 + 非法定受益人 → 全部纳入匹配/建家
    var bloodNames = [primaryHolder]
    var seen = { [primaryHolder]: true }
    function _add(name) { if (name && !seen[name]) { seen[name] = true; bloodNames.push(name) } }
    allPolicies.forEach(function(p) {
      _add(p.insured_name)
      if (p.beneficiary_name && !/法定|法定继承人|未指定/.test(p.beneficiary_name)) _add(p.beneficiary_name)
    })
    // 匹配缓存：5分钟内同投保人跳过 searchFamilies
    var cachedId = session.getMatchCache(primaryHolder)
    if (cachedId) return { familyId: cachedId, matched: true }
    const matchRes = await api('searchFamilies', { keyword: primaryHolder })
    if (matchRes.result && matchRes.result.code === 200) {
      // 同名消歧：仅严格相等匹配，避免 includes 子串误匹配（如"王"误命中"王先生"/"王太太"）
      const candidates = (matchRes.result.data.families || []).filter(c => c.name === primaryHolder)
      if (candidates.length === 1) {
        session.cacheMatch(primaryHolder, candidates[0]._id)
        return { familyId: candidates[0]._id, matched: true }
      }
      if (candidates.length > 1) {
        // 多个同名家庭 → 弹选择器，列出各家庭全部成员供识别
        const details = await Promise.all(candidates.map(c => api('getFamily', { familyId: c._id }).then(d => ({ c, d })).catch(e => { console.error('[index] _matchOrCreate getFamily 失败:', (e && e.message) || e); return { c, d: null } }))).then(rs => rs.filter(r => r.d && r.d.result && r.d.result.code === 200))
        const pick = await this._showFamilyPicker(details.map(function(item) { return { _id: item.c._id, name: item.c.name, members: (item.d.result.data.members || []).map(function(m) { return { name: m.name, role: m.role } }) } }))
        if (pick) { session.cacheMatch(primaryHolder, pick); return { familyId: pick, matched: true } }
      }
    }
    // 新建家庭：投保人=本人，被保人+非法定受益人=其他成员
    var members = [{ role: '本人', name: primaryHolder }]
    for (var i = 1; i < bloodNames.length; i++) members.push({ role: '', name: bloodNames[i] })
    const createRes = await api('createFamily', { family_name: primaryHolder, members: members })
    var newId = createRes.result.data._id
    session.cacheMatch(primaryHolder, newId)
    return { familyId: newId, matched: false }
  },

  // 角色补全：出生日期推断 + 弹窗确认
  async _assignMemberRoles(familyId, allPolicies) {
    var ROLES = ['本人', '配偶', '子女', '父母']
    try {
      var q = await api('getFamily', { familyId: familyId })
      if (!q.result || q.result.code !== 200) return
      var members = q.result.data.members || []
      // 从 OCR 保单中按姓名收集出生日期
      var birthMap = {}
      ;(allPolicies || []).forEach(function(p) {
        if (p.policyholder_name && p.policyholder_birth_date) birthMap[p.policyholder_name] = p.policyholder_birth_date
        if (p.insured_name && p.insured_birth_date) birthMap[p.insured_name] = p.insured_birth_date
        if (p.beneficiary_name && p.beneficiary_birth_date) birthMap[p.beneficiary_name] = p.beneficiary_birth_date
      })
      function _age(birthStr) {
        if (!birthStr) return NaN
        var d = new Date(birthStr)
        if (isNaN(d.getTime())) return NaN
        return new Date().getFullYear() - d.getFullYear()
      }
      function _inferRole(name, selfAge) {
        var age = _age(birthMap[name])
        if (isNaN(age) || isNaN(selfAge)) return null
        var diff = selfAge - age
        if (diff > 18) return '子女'
        if (diff < -18) return '父母'
        if (Math.abs(diff) <= 18) return '配偶'
        return null
      }
      var needRole = members.filter(function(m) { return !m.role || m.role === '' })
      if (!needRole.length) return
      var selfAge = _age(birthMap[(members.find(function(m) { return m.role === '本人' }) || {}).name])
      // 预测每个缺角色的成员（仅作提示，不静默写入）
      var predictions = {}
      for (var i = 0; i < needRole.length; i++) {
        var guessed = _inferRole(needRole[i].name, selfAge)
        if (guessed) predictions[needRole[i].member_id] = guessed
      }
      // 全体角色确认卡：每人默认预测值，单选可改，一键确认
      if (needRole.length > 0) {
        var self = this
        var roleList = needRole.map(function(m) {
          var def = predictions[m.member_id] || '本人'
          return { name: m.name, memberId: m.member_id, role: def }
        })
        var role = await new Promise(function(resolve) {
          self.setData({
            'ocrMask.showRoles': true,
            'ocrMask.roleList': roleList
          })
          self._roleResolve = resolve
        })
        if (role && role.length > 0) {
          var updates = role.filter(function(r) { return r.role }).map(function(r) {
            return api('updateMember', { familyId: familyId, memberId: r.memberId, field: 'role', value: r.role }).catch(function() {})
          })
          await Promise.all(updates)
        }
        self.setData({ 'ocrMask.showRoles': false, 'ocrMask.roleList': null })
      }
      if (!this._pageDead) {
        var rq = await api('getFamily', { familyId: familyId })
        if (rq.result && rq.result.code === 200) {
          this.setData({ 'ocrMask._family': rq.result.data })
        }
      }
    } catch (e) { console.error('[index] _assignMemberRoles 失败:', (e && e.message) || e) }
  },

  // 同名客户选择器
  _showFamilyPicker(families) {
    const items = families.map(f => ({
      name: f.name, value: f._id,
      members: (f.members || []).map(m => m.name + (m.role ? '(' + m.role + ')' : '')).join('、')
    }))
    return new Promise(resolve => {
      wx.showActionSheet({
        itemList: items.map(i => i.name + '（' + i.members + '）'),
        success: r => resolve(items[r.tapIndex].value),
        fail: () => resolve(null)
      })
    })
  },

  onClientTap(e) {
    const { _id } = (e.detail && e.detail._id !== undefined) ? e.detail : e.currentTarget.dataset
    navigateToFamily(_id)
  },
  onClientLongPress(e) {
    const idx = e.currentTarget.dataset.idx
    const c = (this.data.recentClients || [])[idx]
    if (!c) return
    confirmDeleteFamily({
      familyId: c._id,
      name: c.name || c.family_name || '',
      onSuccess: () => this._fetchClients()
    })
  },
  onViewAll() { wx.navigateTo({ url: '/pages/clients/index' }) }
})
