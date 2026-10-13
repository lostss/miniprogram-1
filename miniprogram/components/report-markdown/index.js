const { normalize: normalizeBlock } = require('../../utils/custom-blocks')

Component({
  properties: { chapters: { type: Array, value: [] }, readonly: { type: Boolean, value: false } },
  data: { cards: [], toc: [], _detailOpen: {} },
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
  }
  },
  methods: {
    // V1.5 吸顶目录（2026-09-12）：长报告（十余屏）缺少跳转 → 章节 id（id="ch-{{key}}"）此前无人消费。
    // 章节节点在组件内部，父页面无法直接查询 → 本组件测量目标章节的视口坐标，
    // 交由页面换算为 scroll-top（组件不持有滚动容器）。
    onTocTap(e) {
      const k = e.currentTarget.dataset.k
      if (!k) return
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
