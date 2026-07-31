/**
 * edit-form.js — 报告页编辑表单的纯逻辑模块
 *
 * 解决问题：report/index.js 的 onEditField / onSaveEdit 内联三种模式
 * （member / addMember / financials）的字段定义、校验、payload 构建，
 * 单方法 50+ 行，UI 与业务耦合，无法独立测试。
 *
 * 设计：纯函数 + 显式入参，不绑定 Page 实例
 *  - buildEditConfig：按模式构建字段配置（含 title / _editMode / _editMemberIdx / editFields）
 *  - validate：按模式校验输入，返回 { ok, msg }
 *  - buildUpdateData：按模式构建 updateFamily 的 updateData（不含 familyId）
 */
const ROLE_OPTIONS = ['本人', '配偶', '子女', '父母', '其他']
const CATEGORY_OPTIONS = ['重疾险', '医疗险', '意外险', '寿险', '年金', '其他']

// 成员字段（编辑/新增共用，差异仅在 value 初值）
function _memberFields(member) {
  return [
    { key: 'name', label: '姓名', value: member.name || '', placeholder: '姓名' },
    { key: 'age', label: '年龄', value: String(member.age || ''), placeholder: '如35', type: 'number' },
    { key: 'income', label: '年收入(万)', value: String(member.income || ''), placeholder: '如30', type: 'number' },
    { key: 'role', label: '关系', value: member.role || '', placeholder: '本人/配偶/子女' }
  ]
}

// 财务字段（家庭级聚合：收入=成员求和，负债=debt.amount，支出=financial_snapshot.fixed_expense）
function _financialFields(family) {
  const cu = family || {}
  const da = (cu.debt && cu.debt.amount) || 0
  const dt = (cu.debt && cu.debt.type) || ''
  const ms = cu.members || []
  const ic = ms.reduce((s, m) => s + (m.income || 0), 0)
  const fs = cu.financial_snapshot || {}
  const ex = fs.fixed_expense || 0
  return [
    { key: 'income', label: '家庭年收入(万)', value: String(ic), placeholder: '如80', type: 'number' },
    { key: 'debt', label: '负债(万)', value: String(da), placeholder: '如200', type: 'number' },
    { key: 'debtType', label: '负债类型', value: dt, placeholder: '如房贷/车贷' },
    { key: 'expense', label: '年支出(万)', value: String(ex), placeholder: '如15', type: 'number' }
  ]
}

// 保单字段（Sheet 编辑入口，走 updatePolicy）
function _policyFields(p) {
  p = p || {}
  return [
    { key: 'product_name', label: '产品名称', value: p.product_name || '', placeholder: '如平安e生保' },
    { key: 'insurance_category', label: '险种', value: p.insurance_category || '', placeholder: '重疾险/医疗险/意外险/寿险' },
    { key: 'insured_name', label: '被保险人', value: p.insured_name || '', placeholder: '姓名' },
    { key: 'sum_assured', label: '保额(万)', value: p.sum_assured ? String(Math.round(p.sum_assured / 10000)) : '', placeholder: '如200', type: 'number' },
    { key: 'annual_premium', label: '年缴保费(元)', value: p.annual_premium ? String(p.annual_premium) : '', placeholder: '如8000', type: 'number' },
    { key: 'policy_number', label: '保单号', value: p.policy_number || '', placeholder: '保单号' },
    { key: 'insurer', label: '保险公司', value: p.insurer || '', placeholder: '如平安健康保险' },
    { key: 'effective_date', label: '生效日期', value: p.effective_date || p.contract_effective_date || '', placeholder: 'YYYY-MM-DD' }
  ]
}

/**
 * 构建编辑表单配置
 * @param {object} opts - { mode: 'member'|'addMember'|'financials', family, member }
 * @returns {{ title, _editMode, _editMemberIdx?, editFields }}
 */
function buildEditConfig(opts) {
  const { mode, family, member } = opts
  if (mode === 'member') {
    const ms = (family && family.members) || []
    const idx = ms.findIndex(m => (m.member_id && m.member_id === (member && member.member_id)) || m.name === (member && member.name))
    return {
      title: '编辑成员' + ((member && member.name) || ''),
      _editMode: 'member',
      _editMemberIdx: idx,
      editFields: _memberFields(member || {})
    }
  }
  if (mode === 'addMember') {
    return {
      title: '添加成员',
      _editMode: 'addMember',
      editFields: _memberFields({})
    }
  }
  if (mode === 'policy') {
    return {
      title: '编辑保单' + ((member && member.product_name) || ''),
      _editMode: 'policy',
      _editMemberIdx: (member && (member.policy_id || member._id)) || '',
      editFields: _policyFields(member || {})
    }
  }
  // financials
  return {
    title: '编辑财务信息',
    _editMode: 'financials',
    editFields: _financialFields(family)
  }
}

/**
 * 校验编辑输入
 * @returns {{ ok: boolean, msg?: string }}
 */
function validate(mode, vals) {
  if (mode === 'financials') {
    const inc = Number(vals.income), debt = Number(vals.debt)
    if (isNaN(inc) || inc < 0) return { ok: false, msg: '年收入须为非负数' }
    if (isNaN(debt) || debt < 0) return { ok: false, msg: '负债须为非负数' }
    if (inc > 100000) return { ok: false, msg: '年收入单位为万元，请检查' }
    if (vals.expense !== undefined && vals.expense !== '') {
      const ex = Number(vals.expense)
      if (isNaN(ex) || ex < 0) return { ok: false, msg: '年支出须为非负数' }
    }
    return { ok: true }
  }
  if (mode === 'policy') {
    const name = (vals.product_name || '').trim()
    if (!name) return { ok: false, msg: '请填写产品名称' }
    const cat = (vals.insurance_category || '').trim()
    if (cat && !CATEGORY_OPTIONS.includes(cat)) return { ok: false, msg: '险种需为：重疾险/医疗险/意外险/寿险/年金/其他' }
    if (vals.sum_assured !== undefined && vals.sum_assured !== '') {
      const s = Number(vals.sum_assured)
      if (isNaN(s) || s < 0) return { ok: false, msg: '保额须为非负数' }
    }
    if (vals.annual_premium !== undefined && vals.annual_premium !== '') {
      const a = Number(vals.annual_premium)
      if (isNaN(a) || a < 0) return { ok: false, msg: '保费须为非负数' }
    }
    if (vals.effective_date && !/^\d{4}-\d{2}-\d{2}$/.test(vals.effective_date)) return { ok: false, msg: '生效日期格式 YYYY-MM-DD' }
    return { ok: true }
  }
  if (mode === 'member' || mode === 'addMember') {
    const name = (vals.name || '').trim()
    if (!name) return { ok: false, msg: '请填写姓名' }
    if (name.length > 20) return { ok: false, msg: '姓名过长' }
    const role = (vals.role || '').trim()
    if (!role) return { ok: false, msg: '请选择关系' }
    if (!ROLE_OPTIONS.includes(role)) return { ok: false, msg: '关系需为：本人/配偶/子女/父母/其他' }
    if (vals.age !== undefined && vals.age !== '') {
      const age = Number(vals.age)
      if (isNaN(age) || age < 0 || age > 130) return { ok: false, msg: '年龄需在 0-130' }
    }
    if (vals.income !== undefined && vals.income !== '') {
      const inc = Number(vals.income)
      if (isNaN(inc) || inc < 0) return { ok: false, msg: '年收入须为非负数' }
    }
    return { ok: true }
  }
  return { ok: true }
}

/**
 * 构建 updateFamily 的 updateData（不含 familyId，由调用方附加）
 * @param {string} mode
 * @param {object} vals - 表单值
 * @param {object} family - 当前家庭数据（member 模式需用 members 数组）
 * @param {number} editMemberIdx - member 模式的目标索引
 */
function buildUpdateData(mode, vals, family, editMemberIdx) {
  if (mode === 'financials') {
    const d = {
      financial_snapshot: {
        income: Number(vals.income) || 0,
        debt: { amount: Number(vals.debt) || 0, type: vals.debtType || '房贷' }
      }
    }
    if (vals.expense !== undefined && vals.expense !== '') d.financial_snapshot.fixed_expense = Number(vals.expense) || 0
    return d
  }
  if (mode === 'policy') {
    // updatePolicy 的 data 载荷（familyId/policyId 由调用方附加）
    const data = {}
    if (vals.product_name !== undefined && vals.product_name !== '') data.product_name = vals.product_name
    if (vals.insurance_category !== undefined && vals.insurance_category !== '') data.insurance_category = vals.insurance_category
    if (vals.insured_name !== undefined && vals.insured_name !== '') data.insured_name = vals.insured_name
    if (vals.sum_assured !== undefined && vals.sum_assured !== '') data.sum_assured = Number(vals.sum_assured) * 10000
    if (vals.annual_premium !== undefined && vals.annual_premium !== '') data.annual_premium = Number(vals.annual_premium)
    if (vals.policy_number !== undefined && vals.policy_number !== '') data.policy_number = vals.policy_number
    if (vals.insurer !== undefined && vals.insurer !== '') data.insurer = vals.insurer
    if (vals.effective_date) data.effective_date = vals.effective_date
    return { updatePolicy: { policyId: editMemberIdx || '', data: data } }
  }
  if (mode === 'member') {
    const ms = [...((family && family.members) || [])]
    const idx = editMemberIdx == null ? -1 : editMemberIdx
    if (idx >= 0 && idx < ms.length) {
      ms[idx] = {
        ...ms[idx],
        name: vals.name || ms[idx].name,
        age: Number(vals.age) || 0,
        income: Number(vals.income) || 0,
        role: vals.role || ms[idx].role
      }
    }
    return { members: ms }
  }
  if (mode === 'addMember') {
    const ms = [...((family && family.members) || []), {
      name: vals.name,
      age: Number(vals.age) || 0,
      income: Number(vals.income) || 0,
      role: vals.role,
      member_id: 'm_' + Date.now()
    }]
    return { members: ms }
  }
  return {}
}

module.exports = { buildEditConfig, validate, buildUpdateData, ROLE_OPTIONS, CATEGORY_OPTIONS }
