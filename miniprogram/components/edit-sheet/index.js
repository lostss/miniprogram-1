Component({
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '编辑' },
    fields: { type: Array, value: [] },
    saving: { type: Boolean, value: false }
  },
  methods: {
    onNoop() {},
    _applyValue(idx, value) {
      const fields = this.properties.fields
      const patch = { ['fields[' + idx + '].value']: value }
      // 输入即清错（用户已在修正）
      if (fields[idx].error) patch['fields[' + idx + '].error'] = ''
      // 已修改：切浅蓝底色、⚠️ 消失（设计稿 v4）
      patch['fields[' + idx + '].modified'] = true
      this.setData(patch)
    },
    onFieldInput(e) {
      const key = e.currentTarget.dataset.key
      const idx = this.properties.fields.findIndex(f => f.key === key)
      if (idx >= 0) this._applyValue(idx, e.detail.value)
    },
    // 原生 picker：selector 取 options[detail.value]（index），date 取日期字符串
    onFieldPicker(e) {
      const key = e.currentTarget.dataset.key
      const fields = this.properties.fields
      const idx = fields.findIndex(f => f.key === key)
      if (idx < 0) return
      let value = e.detail.value
      if (fields[idx].type === 'selector') {
        const opts = fields[idx].options || []
        value = opts[Number(value)] || ''
      }
      this._applyValue(idx, value)
    },
    onFieldBlur(e) {
      const key = e.currentTarget.dataset.key
      const fields = this.properties.fields
      const idx = fields.findIndex(f => f.key === key)
      if (idx < 0) return
      const error = this._validateField(fields[idx])
      if (error !== fields[idx].error) {
        this.setData({ ['fields[' + idx + '].error']: error })
      }
    },
    _validateField(f) {
      const v = (f.value === null || f.value === undefined) ? '' : String(f.value).trim()
      if (f.required && !v) return (f.label || '此字段') + '不能为空'
      if (f.maxLen && v.length > f.maxLen) return `不能超过${f.maxLen}字`
      if (f.pattern && v) {
        const re = new RegExp(f.pattern)
        if (!re.test(v)) return f.patternMsg || '格式不正确'
      }
      return ''
    },
    _validateAll() {
      const fields = this.properties.fields
      const errors = {}
      fields.forEach((f, idx) => {
        const err = this._validateField(f)
        if (err) errors[idx] = err
      })
      if (Object.keys(errors).length > 0) {
        const patch = {}
        Object.keys(errors).forEach(idx => {
          patch['fields[' + idx + '].error'] = errors[idx]
        })
        this.setData(patch)
        return false
      }
      return true
    },
    onSave() {
      if (this.properties.saving) return
      if (!this._validateAll()) return
      const data = {}
      this.data.fields.forEach(f => { data[f.key] = f.value })
      this.triggerEvent('save', data)
    },
    onClose() {
      if (this.properties.saving) return
      // UI 审计 R-M7：有已修改字段时先确认放弃（误触遮罩/关闭按钮不再静默丢失输入）
      const dirty = (this.data.fields || []).some(f => f.modified)
      if (dirty) {
        wx.showModal({
          title: '放弃修改？',
          content: '当前修改尚未保存，确定放弃吗？',
          confirmText: '放弃', cancelText: '继续编辑',
          success: (r) => { if (r.confirm) this.triggerEvent('close') }
        })
        return
      }
      this.triggerEvent('close')
    }
  }
})
