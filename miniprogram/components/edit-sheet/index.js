Component({
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '编辑' },
    fields: { type: Array, value: [] },
    saving: { type: Boolean, value: false }
  },
  methods: {
    onNoop() {},
    onFieldInput(e) {
      const key = e.currentTarget.dataset.key
      const value = e.detail.value
      const fields = this.properties.fields
      const idx = fields.findIndex(f => f.key === key)
      if (idx >= 0) {
        const patch = { ['fields[' + idx + '].value']: value }
        // 输入即清错（用户已在修正）
        if (fields[idx].error) patch['fields[' + idx + '].error'] = ''
        this.setData(patch)
      }
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
      this.triggerEvent('close')
    }
  }
})
