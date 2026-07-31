// 完整度圆环改用 CSS conic-gradient 绘制（lib 3.15+ 支持），
// 移除每卡一个 canvas 2d 实例，避免客户列表 10+ 卡片的冷启动开销
Component({
  properties: { client: { type: Object, value: {} } },
  data: { _fmtTime: '', _completeness: 0 },
  observers: {
    'client'(c) {
      if (!c) return
      const comp = c.completeness || (c.report && c.report.completeness) || 0
      this.setData({ _fmtTime: this._fmt(c.updated_at), _completeness: comp, _name: c.name || c.family_name || '', _id: c._id || '' })
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
    }
  }
})
