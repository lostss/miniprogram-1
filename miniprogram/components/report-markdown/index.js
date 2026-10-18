const { normalize: normalizeBlock } = require('../../utils/custom-blocks')
// 目录激活态归约（2026-10-18）：纯函数，规则见该文件头注释
const { pickActiveKey } = require('../../utils/toc-active')

Component({
  properties: { chapters: { type: Array, value: [] }, readonly: { type: Boolean, value: false } },
  // activeKey：当前正在读的章节（目录标签高亮）；tocInto：把高亮标签滚进可视区
  data: { cards: [], toc: [], _detailOpen: {}, activeKey: '', tocInto: '' },
  lifetimes: {
    ready() { this._armTocObserver() },
    detached() {
      if (this._tocObs) { try { this._tocObs.disconnect() } catch (e) {} this._tocObs = null }
    }
  },
  observers: {
  chapters(arr) {
    if (!arr || !arr.length) return
    const prev = {}
    ;(this.data.cards || []).forEach(c => { if (c.collapsible) prev[c.key] = c.collapsed })
    this.setData({ cards: arr.map((c, idx) => {
      const collapsible = !!c.collapsible
      const collapsed = collapsible ? (prev[c.key] !== undefined ? prev[c.key] : !!c.defaultCollapsed) : false
      const delay = (idx * 0.08).toFixed(2)
      const style = 'animation-delay:' + delay + 's'
      // customBlock 经注册表 normalize 补齐字段，防止 wxml 因 undefined 报错
      const customBlocks = c.customBlocks ? c.customBlocks.map(normalizeBlock) : null
      return { key: c.key, num: c.num || '', title: c.title || '', edit: c.edit || '', unit: c.unit || '', customBlocks, content: c.content || '', pre: c.pre || '', note: c.note || '', collapsible, collapsed, style }
    }), toc: arr.map(c => ({ key: c.key, num: c.num || '', title: c.title || '' })) })
    // 章节变化后重新挂观察器（首屏数据晚到 / 报告刷新都会走到这里）
    this._armTocObserver()
  }
  },
  methods: {
    /**
     * 目录激活态观察器（2026-10-18）
     * 章节节点在组件内、滚动容器在页面 → 用 IntersectionObserver 让节点自报"是否在可视带"。
     * 可视带：目录下方 96px 起、到视口底部上方 300px 止（避开底部输入栏与吸底条的遮挡区）。
     * observeAll 一次观察全部章节；回调里只更新 seen 集合，归约交给 pickActiveKey。
     */
    _armTocObserver() {
      if (this._tocObs) { try { this._tocObs.disconnect() } catch (e) {} }
      var self = this
      // 等一帧：observers 触发时节点可能还没渲染（首屏 chapters 一到就 arm 会观察不到）
      var arm = function() {
        if (!self.data.cards || !self.data.cards.length) return
        self._tocSeen = {}
        self._tocObs = self.createIntersectionObserver({ observeAll: true })
        self._tocObs.relativeToViewport({ top: -96, bottom: -300 })
          .observe('.md-card', function(res) {
            if (!res || !res.id) return
            var key = String(res.id).replace(/^ch-/, '')
            if (!key) return
            if (res.intersectionRatio > 0) self._tocSeen[key] = true
            else delete self._tocSeen[key]
            var active = pickActiveKey(self.data.toc.map(function(t) { return t.key }), self._tocSeen, self.data.activeKey)
            if (active && active !== self.data.activeKey) {
              // tocInto 让高亮标签自动滚进可视区（章节多时标签会滚出屏幕）
              self.setData({ activeKey: active, tocInto: 'toc-' + active })
            }
          })
      }
      if (typeof wx !== 'undefined' && wx.nextTick) wx.nextTick(arm)
      else setTimeout(arm, 50)
    },

    // V1.5 吸顶目录（2026-09-12）：长报告（十余屏）缺少跳转 → 章节 id（id="ch-{{key}}"）此前无人消费。
    // 章节节点在组件内部，父页面无法直接查询 → 本组件测量目标章节的视口坐标，
    // 交由页面换算为 scroll-top（组件不持有滚动容器）。
    onTocTap(e) {
      const k = e.currentTarget.dataset.k
      if (!k) return
      // 2026-10-18：点击立即点亮（乐观更新）—— 页面滚动到目标章节有过渡时间，
      // 若等观察器回调才高亮，手指抬起后约 0.3s 内没有任何反馈，像没点中。
      if (k !== this.data.activeKey) this.setData({ activeKey: k, tocInto: 'toc-' + k })
      this.createSelectorQuery().select('#ch-' + k).boundingClientRect((rect) => {
        if (!rect) return
        this.triggerEvent('tocnav', { key: k, top: rect.top })
      }).exec()
    },
    toggleChapter(e) {
      const k = e.currentTarget.dataset.k
      const cards = this.data.cards.map(c => c.key === k ? Object.assign({}, c, { collapsed: !c.collapsed }) : c)
      this.setData({ cards })
    },
    onPolicyTap(e) {
      if (this.data.readonly) return
      const id = e.currentTarget.dataset.id
      if (!id) return
      this.triggerEvent('policytap', { policyId: id })
    },
      onStatusTap(e) {
        if (this.data.readonly) return
        const id = e.currentTarget.dataset.id
        if (!id) return
        this.triggerEvent('statuschange', { policyId: id })
      },

    onRiskCheck(e) {
      if (this.data.readonly) return
      const pid = e.currentTarget.dataset.pid || ''
      const field = e.currentTarget.dataset.field || ''
      if (!pid) return
      this.triggerEvent('riskcheck', { policyId: pid, field: field })
    },
    onChapterEdit(e) {
      if (this.data.readonly) return
      const mode = e.currentTarget.dataset.mode
      const mid = e.currentTarget.dataset.mid || ''
      this.triggerEvent('chapteredit', { mode: mode || '', memberId: mid })
    },
    onLinkTap(e) {
      const href = e.detail && e.detail.href
      if (!href) return
      wx.setClipboardData({ data: href, success: function() { wx.showToast({ title: '链接已复制', icon: 'none' }) } })
    }
  }
})
