// P2-5：canvas 颜色集中（canvas 不读 CSS 变量，需 JS 端单一来源）
// 与 app.wxss 的 --border / --accent / --text-primary 保持视觉一致
const COLORS = {
  ringTrack: '#E8E0D5',   // 轨道色（对应 --border）
  ringFill:  '#C9A96E',   // 进度色（对应 --accent）
  text:      '#1A1A2E'     // 文本色（对应 --text-primary）
}

Component({
  properties: { client: { type: Object, value: {} } },
  data: { _fmtTime: '', _completeness: 0 },
  observers: {
    'client'(c) {
      if (!c) return
      this.setData({ _fmtTime: this._fmt(c.updated_at), _completeness: c.completeness || (c.report && c.report.completeness) || 0, _name: c.name || c.family_name || '', _id: c._id || '' })
      if (this.data._completeness > 0) this._drawRing()
    }
  },
  methods: {
    onTap() { this.triggerEvent('tap', { _id: this.data._id }) },
    onLongPress() {
      wx.vibrateShort({ type: 'medium' })
      this.triggerEvent('longpress', { _id: this.data._id, name: this.data._name })
    },
    _fmt(d) {
      if (!d) return ''; const t = new Date(d), n = new Date(), diff = n - t
      if (diff < 6e4) return '刚才'
      if (diff < 36e5) return Math.floor(diff / 6e4) + '分钟前'
      if (diff < 864e5) return Math.floor(diff / 36e5) + '小时前'
      return (t.getMonth() + 1) + '/' + t.getDate()
    },
    _drawRing() {
      const query = this.createSelectorQuery()
      query.select('#ringCanvas').fields({ node: true, size: true }).exec(res => {
        if (!res || !res[0] || !res[0].node) return
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const dpr = wx.getWindowInfo().pixelRatio
        const w = res[0].width || 40
        const h = res[0].height || 40
        canvas.width = w * dpr
        canvas.height = h * dpr
        ctx.scale(dpr, dpr)

        const c = Math.min(this.data._completeness / 100, 1)
        const r = Math.min(w, h) / 2 - 4
        const x = w / 2, y = h / 2

        ctx.lineWidth = 3
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI)
        ctx.strokeStyle = COLORS.ringTrack; ctx.stroke()

        ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * c)
        ctx.strokeStyle = COLORS.ringFill; ctx.stroke()

        ctx.fillStyle = COLORS.text
        ctx.font = '12px sans-serif'
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(Math.round(c * 100) + '%', x, y)
      })
    }
  }
})
