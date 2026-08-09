// 完整度圆环改用 CSS conic-gradient 绘制（lib 3.15+ 支持），
// 移除每卡一个 canvas 2d 实例，避免客户列表 10+ 卡片的冷启动开销
Component({
  properties: { client: { type: Object, value: {} } },
  data: { _fmtTime: '', _completeness: 0, _id: '', _name: '' },
  observers: {
    'client'(c) {
      if (!c) return
      const comp = c.completeness || (c.report && c.report.completeness) || 0
      this.setData({ _fmtTime: this._fmt(c.updated_at), _completeness: comp, _name: c.name || c.family_name || '', _id: c._id || '' })
    }
  },
  methods: {
    // 真机 404 修复：onTap 直读 client 属性 _id，不再依赖 observers 缓存（observers 未触发时 this.data._id 为 undefined
    // → navigateToFamily(undefined) → URL familyId=undefined → getFamily 404 "客户不存在"）
    onTap() {
      const c = this.data.client || {}
      this.triggerEvent('tap', { _id: c._id || '' })
    },
    onLongPress() {
      wx.vibrateShort({ type: 'medium' })
      const c = this.data.client || {}
      this.triggerEvent('longpress', { _id: c._id || '', name: c.name || c.family_name || '' })
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
