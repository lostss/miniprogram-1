const { normalize: normalizeBlock } = require('../../utils/custom-blocks')

Component({
  properties: { chapters: { type: Array, value: [] } },
  data: { cards: [], _detailOpen: {} },
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
    }) })
  }
  },
  methods: {
    toggleChapter(e) {
      const k = e.currentTarget.dataset.k
      const cards = this.data.cards.map(c => c.key === k ? Object.assign({}, c, { collapsed: !c.collapsed }) : c)
      this.setData({ cards })
    },
    onPolicyTap(e) {
      const id = e.currentTarget.dataset.id
      if (!id) return
      this.triggerEvent('policytap', { policyId: id })
    },
    onRiskCheck(e) {
      const pid = e.currentTarget.dataset.pid || ''
      const field = e.currentTarget.dataset.field || ''
      if (!pid) return
      this.triggerEvent('riskcheck', { policyId: pid, field: field })
    },
    onChapterEdit(e) {
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
