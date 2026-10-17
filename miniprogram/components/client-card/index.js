// 2026-10-17：圆环（conic-gradient 资料完整度）已移除 —— 卡面只留家庭名称 + 更新时间。
// 原实现用 CSS conic-gradient 替代 canvas 是为了省冷启动开销，现在连指标本身都不呈现了。
Component({
  properties: { client: { type: Object, value: {} } },
  data: { _fmtTime: '', _staleTime: false, _id: '', _name: '' },
  observers: {
    'client'(c) {
      if (!c) return
      const t = this._fmt(c.updated_at)
      // 审计 P1-5 遗留说明：后端列表投影字段为 completeness_score（0-100）；
      // completeness / report.completeness 均为历史不存在字段。该值自 2026-10-17 起不再渲染。
      this.setData({ _fmtTime: t.text, _staleTime: t.stale, _name: c.name || c.family_name || '', _id: c._id || '' })
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
    // 2026-10-17 用户决策：一律用"多久前更新"表达，不再退化成 M/D。
    // 旧实现 diff >= 1 天就直接返回 `M/D`，丢掉了"这个客户多久没动过"（顾问扫列表的第一判断）。
    // 返回 { text, stale }：stale = 超过 30 天（卡面用强调色提示跟进，不是错误）。
    _fmt(d) {
      if (!d) return { text: '', stale: false }
      const t = new Date(d)
      const now = Date.now()
      if (isNaN(t.getTime())) return { text: '', stale: false }
      const diff = now - t.getTime()
      const MIN = 6e4, HOUR = 36e5, DAY = 864e5
      // 时钟偏差（服务端时间略超前）不应出现"-3 分钟前"
      if (diff < MIN) return { text: '刚刚更新', stale: false }
      if (diff < HOUR) return { text: Math.floor(diff / MIN) + ' 分钟前更新', stale: false }
      if (diff < DAY) return { text: Math.floor(diff / HOUR) + ' 小时前更新', stale: false }
      const days = Math.floor(diff / DAY)
      if (days < 30) return { text: days + ' 天前更新', stale: false }
      if (days < 365) return { text: Math.floor(days / 30) + ' 个月前更新', stale: true }
      return { text: Math.floor(days / 365) + ' 年前更新', stale: true }
    }
  }
})
