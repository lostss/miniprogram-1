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
const { yuanToWan, wanToYuan } = require('./amount')
const ROLE_OPTIONS = ['本人', '配偶', '子女', '父母', '其他']
const CATEGORY_OPTIONS = ['重疾险', '医疗险', '意外险', '寿险', '年金', '其他']
// 缴费方式选项（对齐 DB policies.payment_method）
const PAYMENT_METHOD_OPTIONS = ['趸交', '年交', '月交', '季交', '半年交']
// 保单状态：业务员可手动选择的有效/失效/退保/理赔终止；到期终止由系统自动判断，不进入手选
const POLICY_STATUS_OPTIONS = ['有效', '失效', '退保', '理赔终止']
const POLICY_STATUS_LABEL_TO_VALUE = {
  '有效': 'active',
  '失效': 'lapsed',
  '退保': 'surrendered',
  '理赔终止': 'claim_terminated'
}
const POLICY_STATUS_VALUE_TO_LABEL = {
  active: '有效',
  lapsed: '失效',
  surrendered: '退保',
  claim_terminated: '理赔终止',
  expired: '到期终止',
  cancelled: '退保',
    suspicious: '数据异常'
}


// 成员字段（编辑/新增共用，差异仅在 value 初值）
// UI 审计 A-S4：激活 edit-sheet 闲置的校验能力（required 必填星号 + pattern 失焦实时校验）
function _memberFields(member) {
  return [
    { key: 'name', label: '姓名', value: member.name || '', placeholder: '姓名', required: true, maxLen: 20 },
    { key: 'birth_date', label: '出生日期', value: member.birth_date || '', placeholder: 'YYYY-MM-DD', type: 'date' },
    { key: 'age', label: '年龄', value: String(member.age || ''), placeholder: '如35', type: 'number', pattern: '^\\d{1,3}$', patternMsg: '年龄需为数字' },
    { key: 'income', label: '年收入(万)', value: String(member.income || ''), placeholder: '如30', type: 'number', pattern: '^\\d+(\\.\\d+)?$', patternMsg: '请输入数字' },
    { key: 'role', label: '关系', value: member.role || '', placeholder: '请选择', type: 'selector', options: ROLE_OPTIONS }
  ]
}

// 财务字段（家庭级：收入/负债/支出均取家庭财务源——finances 唯一真相源经 financial_snapshot/family_income 组装）
// 2026-09-06 修复：收入回显曾用"成员个人收入求和"，致对话/表单录入的家庭收入在弹窗与报告中显示旧值
function _financialFields(family) {
  const cu = family || {}
  const da = (cu.debt && cu.debt.amount) || 0
  const fs = cu.financial_snapshot || {}
  const famInc = cu.family_income != null ? Number(cu.family_income) : (fs.income != null ? Number(fs.income) : 0)
  const ic = famInc > 0 ? famInc : 0
  const ex = fs.fixed_expense || 0
  return [
    { key: 'income', label: '家庭年收入(万)', value: String(ic), placeholder: '如80', type: 'number', pattern: '^\\d+(\\.\\d+)?$', patternMsg: '请输入数字' },
    { key: 'debt', label: '负债(万)', value: String(da), placeholder: '如200', type: 'number', pattern: '^\\d+(\\.\\d+)?$', patternMsg: '请输入数字' },
    { key: 'expense', label: '年支出(万)', value: String(ex), placeholder: '如15', type: 'number', pattern: '^\\d+(\\.\\d+)?$', patternMsg: '请输入数字' }
  ]
}

// 保单字段（Sheet 编辑入口，走 updatePolicy）
// 设计稿 v4：编辑 Sheet 字段按置信度区分底色（高白 / 中 #FFF8E1 / 低 #FFF0E0 / 已修改 #E3F2FD）
function _policyFields(p) {
  p = p || {}
  const fc = p.field_confidence || {}
  const overall = typeof p.confidence === 'number' ? p.confidence : 0.95
  function toneOf(c) {
    if (c == null || c >= 0.95) return ''
    return c >= 0.8 ? 'mid' : 'low'
  }
  // 数据异常（suspicious）保单：核心异常字段强制低置信底色 + ⚠️，引导用户定位问题
  // 异常判定与 calcStatus 同构：保额=0 但保费>0（suspicious 状态由写入层落库，这里按状态+数据双保险）
  const isSuspicious = p.status === 'suspicious' || ((!p.sum_assured || p.sum_assured === 0) && p.annual_premium > 0)
  function tone(key) {
    const t = toneOf(fc[key] != null ? fc[key] : overall)
    if (t) return t
    if (isSuspicious && key === 'sum_assured') return 'low'
    return ''
  }
  // UI 审计 A-S4：激活 edit-sheet 校验能力（产品名称必填 + 数值字段 pattern）
  // 信息分组（与识别卡片 sheet 分组结构一致：基础/人员/缴费/保障，保留置信度 tone 底色）
  const groups = [
      { title: '状态信息', fields: [
        { key: 'status', label: '保单状态', value: POLICY_STATUS_VALUE_TO_LABEL[p.status] || '有效', placeholder: '请选择', type: 'selector', options: POLICY_STATUS_OPTIONS },
        // 用户决策（2026-08-30）：改失效/退保/理赔终止必须填写失效日期（validate 校验必填）
        { key: 'status_effective_date', label: '失效日期', value: p.status_effective_date || '', placeholder: 'YYYY-MM-DD', type: 'date' },
        { key: 'status_reason', label: '变更原因', value: p.status_reason || '', placeholder: '选填，如客户退保' }
      ] },

    { title: '基础信息', fields: [
      { key: 'product_name', label: '产品名称', value: p.product_name || '', placeholder: '如平安e生保', tone: tone('product_name'), required: true, maxLen: 40 },
      { key: 'insurance_category', label: '险种', value: p.insurance_category || '', placeholder: '请选择', type: 'selector', options: CATEGORY_OPTIONS, tone: tone('insurance_category') },
      { key: 'policy_number', label: '保单号', value: p.policy_number || '', placeholder: '保单号', tone: tone('policy_number') },
      { key: 'insurer', label: '保险公司', value: p.insurer || '', placeholder: '如平安健康保险', tone: tone('insurer') },
      { key: 'effective_date', label: '生效日期', value: p.effective_date || p.contract_effective_date || '', placeholder: 'YYYY-MM-DD', type: 'date', tone: tone('effective_date') }
    ] },
    { title: '人员信息', fields: [
      { key: 'insured_name', label: '被保险人', value: p.insured_name || '', placeholder: '姓名', tone: tone('insured_name'), required: true },
      { key: 'policyholder_name', label: '投保人', value: p.policyholder_name || '', placeholder: '姓名', tone: tone('policyholder_name') },
      { key: 'beneficiary_name', label: '受益人', value: p.beneficiary_name || '', placeholder: '姓名', tone: tone('beneficiary_name') }
    ] },
    { title: '缴费信息', fields: [
      { key: 'payment_method', label: '缴费方式', value: p.payment_method || '', placeholder: '请选择', type: 'selector', options: PAYMENT_METHOD_OPTIONS, tone: tone('payment_method') },
      { key: 'payment_period', label: '缴费期限', value: p.payment_period || '', placeholder: '如20年/交至60岁/月交', type: 'text', tone: tone('payment_period') },
      { key: 'annual_premium', label: '年缴保费(元)', value: p.annual_premium ? String(p.annual_premium) : '', placeholder: '如8000', type: 'number', tone: tone('annual_premium'), required: true, pattern: '^\\d+(\\.\\d+)?$', patternMsg: '请输入数字' }
    ] },
    { title: '保障信息', fields: [
      { key: 'sum_assured', label: '保额(万)', value: p.sum_assured ? String(Math.round(yuanToWan(p.sum_assured))) : '', placeholder: '如200', type: 'number', tone: tone('sum_assured'), required: true, pattern: '^\\d+(\\.\\d+)?$', patternMsg: '请输入数字' },
      { key: 'insurance_period', label: '保障期间', value: p.insurance_period || '', placeholder: '如终身/30年/至70岁/90天', type: 'text', tone: tone('insurance_period') }
    ] }
  ]
  const out = []
  groups.forEach(g => {
    out.push({ isGroup: true, label: g.title })
    g.fields.forEach(f => out.push(f))
  })
  return out
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
      title: ((member && member.product_name) || '编辑保单'),
      _editMode: 'policy',
      _editMemberIdx: (member && (member.policy_id || member.id || member._id)) || '',
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
    // 用户决策（2026-08-30）：状态改为失效/退保/理赔终止时必须填写失效日期
    if (vals.status && vals.status !== '有效') {
      if (!vals.status_effective_date) return { ok: false, msg: '请填写失效日期' }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(vals.status_effective_date)) return { ok: false, msg: '失效日期格式 YYYY-MM-DD' }
    }
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
        // 负债类型已移除（负债可同时存在多项，单一类型不准确）；debt 存 { amount } 兼容旧结构
        debt: { amount: Number(vals.debt) || 0 }
      }
    }
    if (vals.expense !== undefined && vals.expense !== '') d.financial_snapshot.fixed_expense = Number(vals.expense) || 0
    return d
  }
  if (mode === 'policy') {
    // updatePolicy 的 data 载荷（familyId/policyId 由调用方附加）
    // P1-F1 修复（2026-09-05）：可选字段"清空"须真实发送——服务端 POLICY_EDITABLE 支持写空串；
    // 原 `!== ''` 门控把用户清空静默丢弃 → 提示成功但 DB 仍旧值，下次渲染"复原"
    const data = {}
    if (vals.product_name !== undefined && vals.product_name !== '') data.product_name = vals.product_name // 必填（validate 已拦空）
    if (vals.insurance_category !== undefined) data.insurance_category = vals.insurance_category
    if (vals.insured_name !== undefined) data.insured_name = vals.insured_name
    if (vals.policyholder_name !== undefined) data.policyholder_name = vals.policyholder_name
    if (vals.beneficiary_name !== undefined) data.beneficiary_name = vals.beneficiary_name
    // 金额：清空 → 发空串（服务端保留空语义）；非空保持换算/数字化
    if (vals.sum_assured !== undefined) data.sum_assured = vals.sum_assured === '' ? '' : wanToYuan(vals.sum_assured)
    if (vals.annual_premium !== undefined) data.annual_premium = vals.annual_premium === '' ? '' : Number(vals.annual_premium)
    if (vals.payment_method !== undefined) data.payment_method = vals.payment_method
    if (vals.payment_period !== undefined) data.payment_period = vals.payment_period
    if (vals.insurance_period !== undefined) data.insurance_period = vals.insurance_period
    if (vals.policy_number !== undefined) data.policy_number = vals.policy_number
    if (vals.insurer !== undefined) data.insurer = vals.insurer
    // 2026-09-11：与上方字段同规则——可选字段"清空"须真实发送。
    // 服务端 POLICY_EDITABLE 含 effective_date / status_effective_date，且 updatePolicy 对
    // effective_date 的格式校验显式放行空串（v !== '' 短路），故空串可安全落库。
    // 原 truthy 门控把用户清空静默丢弃 → 提示保存成功但 DB 仍旧值，下次打开"复原"
    if (vals.effective_date !== undefined) data.effective_date = vals.effective_date
    if (vals.status && POLICY_STATUS_LABEL_TO_VALUE[vals.status]) data.status = POLICY_STATUS_LABEL_TO_VALUE[vals.status]
    if (vals.status_effective_date !== undefined) data.status_effective_date = vals.status_effective_date
    if (vals.status_reason !== undefined) data.status_reason = vals.status_reason

    return { updatePolicy: { policyId: editMemberIdx || '', data: data } }
  }
  if (mode === 'member') {
    const ms = [...((family && family.members) || [])]
    const idx = editMemberIdx == null ? -1 : editMemberIdx
    if (idx >= 0 && idx < ms.length) {
      ms[idx] = {
        ...ms[idx],
        name: vals.name || ms[idx].name,
        birth_date: vals.birth_date || ms[idx].birth_date || '',
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
      birth_date: vals.birth_date || '',
      age: Number(vals.age) || 0,
      income: Number(vals.income) || 0,
      role: vals.role,
      member_id: 'm_' + Date.now()
    }]
    return { members: ms }
  }
  return {}
}

module.exports = { buildEditConfig, validate, buildUpdateData, ROLE_OPTIONS, CATEGORY_OPTIONS, PAYMENT_METHOD_OPTIONS, POLICY_STATUS_OPTIONS, POLICY_STATUS_LABEL_TO_VALUE, POLICY_STATUS_VALUE_TO_LABEL }
