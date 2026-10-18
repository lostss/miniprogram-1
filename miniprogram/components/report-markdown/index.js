const { normalize: normalizeBlock } = require('../../utils/custom-blocks')
// 目录激活态（2026-10-18 第二版）：按滚动位置取"最后一个越过目录下沿的章节"，规则见该文件头注释
const { pickActiveByOffset } = require('../../utils/toc-active')

Component({
  properties: { chapters: { type: Array, value: [] }, readonly: { type: Boolean, value: false } },
  // activeKey：当前正在读的章节（目录标签高亮）；tocInto：把高亮标签滚进可视区
  data: { cards: [], toc: [], _detailOpen: {}, activeKey: '', tocInto: '' },
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
    // 章节变了 → 旧的几何测量作废，等下一次滚动重新测
    this._tocOffsets = null
  }
  },
  methods: {
    /**
     * 目录激活态（2026-10-18 第二版）
     *
     * 第一版（IntersectionObserver + 可视带）在真机上错两处：回顶不回弹、以及章节标题被
     * 吸顶目录挡住时高亮跳过一章。原因都是"用可见性近似阅读位置"。
     * 现在改为确定性判定：页面把 scrollTop 通过 syncPageScroll 送进来（方法调用，不 setData），
     * 本组件按"最后一个 top 越过目录下沿的章节"决定高亮。
     *
     * 测量只在需要时做（首屏 / 章节变化 / 折叠展开后）：目录是 sticky 的，其下沿屏幕坐标
     * 在滚动中不变，所以只需测一次即可配合滚动增量使用。
     */
    // ⚠️ 方法名不能以 on 开头：本项目有守卫（wxml-binding-integrity）要求所有 onXxx 都必须
    // 在 wxml 里绑定，而本方法由**父页面直接调用**（没有、也不需要 wxml 绑定）。
    syncPageScroll(scrollTop) {
      var s = Number(scrollTop) || 0
      // 2026-10-18 真机修（回顶不回弹的第二层保险）：滚动到最顶部时**直接**判定为第一章，
      // 不参与几何比较。原因是"测量时刻"可能落在页面中部（数据刷新后重测），
      // 一旦测量点与真实回顶之间存在偏差，几何比较会把某章误判为已越过线。
      // 顶部是一个绝对状态，直接给答案比推算更可靠。
      if (s <= 2) {
        var first = (this.data.toc && this.data.toc.length) ? this.data.toc[0].key : ''
        if (first && first !== this.data.activeKey) this.setData({ activeKey: first, tocInto: 'toc-' + first })
        return
      }
      if (!this._tocOffsets) {
        this._measureToc(s)
        return // 本次先测，下一次滚动事件就能用上（滚动是连续的，不会漏帧）
      }
      var dy = s - this._tocMeasuredAt
      var active = pickActiveByOffset(this._tocOffsets, dy, this._tocLineY)
      if (active && active !== this.data.activeKey) {
        // tocInto 让高亮标签自动滚进可视区（章节多时标签会滚出屏幕）
        this.setData({ activeKey: active, tocInto: 'toc-' + active })
      }
    },

    _measureToc(scrollTop) {
      var self = this
      var q = this.createSelectorQuery()
      q.select('.toc').boundingClientRect()
      // 用 fields({id:true, rect:true}) 而不是 boundingClientRect()：后者在部分基础库上
      // 不返回节点 id → 章节 key 全空 → 整条判定静默失效（不报错，只是永远不高亮）。
      q.selectAll('.md-card').fields({ id: true, rect: true })
      q.exec(function(res) {
        var toc = res && res[0]
        var cards = (res && res[1]) || []
        if (!cards.length) return
        self._tocOffsets = cards.map(function(r) {
          return { key: String((r && r.id) || '').replace(/^ch-/, ''), top0: (r && r.top) || 0 }
        }).filter(function(o) { return o.key })
        // 目录下沿 + 4px 容差：标题越过这条线就算"当前章"
        self._tocLineY = toc ? (toc.bottom + 4) : 72
        self._tocMeasuredAt = Number(scrollTop) || 0
        // 测完立刻按当前位置算一次，避免第一帧不高亮
        self.syncPageScroll(self._tocMeasuredAt)
      })
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
      // 折叠/展开会改变其后所有章节的位置 → 几何测量作废
      this._tocOffsets = null
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
