/**
 * edit-form 单测 — 编辑表单配置（含 suspicious 数据异常视觉引导）
 */
const { buildEditConfig } = require('../miniprogram/utils/edit-form')

describe('buildEditConfig policy — suspicious 数据异常视觉引导', () => {
  function fields(p) { return buildEditConfig({ mode: 'policy', family: {}, member: p }).editFields }

  test('suspicious 状态保单：保额字段强制 tone=low（数据异常定位）', () => {
    const p = {
      status: 'suspicious',
      product_name: '测试医疗险',
      annual_premium: 800,
      sum_assured: 0,
      confidence: 0.99,
      field_confidence: { product_name: 0.99, annual_premium: 0.99 }
    }
    const fs = fields(p)
    const sum = fs.find(f => f.key === 'sum_assured')
    expect(sum).toBeDefined()
    expect(sum.tone).toBe('low')
  })

  test('非 suspicious（保额>0）保单：保额字段不因数据异常强制 tone（沿用置信度）', () => {
    const p = {
      status: 'active',
      product_name: '正常保单',
      annual_premium: 800,
      sum_assured: 2000000,
      confidence: 0.99,
      field_confidence: { product_name: 0.99, annual_premium: 0.99 }
    }
    const fs = fields(p)
    const sum = fs.find(f => f.key === 'sum_assured')
    expect(sum.tone).toBe('')
  })

  test('无显式 status 但保额=0且保费>0（calcStatus 同构判定）→ 保额字段 tone=low', () => {
    const p = {
      product_name: '异常数据',
      annual_premium: 500,
      sum_assured: 0,
      confidence: 0.99
    }
    const fs = fields(p)
    const sum = fs.find(f => f.key === 'sum_assured')
    expect(sum.tone).toBe('low')
  })

  test('suspicious 不影响其他字段（仅 sum_assured 定位）', () => {
    const p = {
      status: 'suspicious',
      product_name: '测试',
      annual_premium: 800,
      sum_assured: 0,
      confidence: 0.99,
      field_confidence: { product_name: 0.99, annual_premium: 0.99 }
    }
    const fs = fields(p)
    expect(fs.find(f => f.key === 'annual_premium').tone).toBe('')
    expect(fs.find(f => f.key === 'product_name').tone).toBe('')
  })
})

describe('buildUpdateData policy — P1-F1 清空字段须真实发送（此前空值门控丢弃导致静默失败）', () => {
  const { buildUpdateData } = require('../miniprogram/utils/edit-form')

  test('清空保单号 → payload 含空串（服务端 POLICY_EDITABLE 支持清空）', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', policy_number: '' }, {}, 'pid_1')
    expect(r.updatePolicy.data.policy_number).toBe('')
  })

  test('非空保单号正常发送；未提供的字段不进 payload', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', policy_number: 'P123' }, {}, 'pid_1')
    expect(r.updatePolicy.data.policy_number).toBe('P123')
    expect(r.updatePolicy.data.insurer).toBeUndefined()
    expect(r.updatePolicy.data.sum_assured).toBeUndefined()
  })

  test('清空保额 → 传空串（保留空语义，不换算成 0）', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', sum_assured: '' }, {}, 'pid_1')
    expect(r.updatePolicy.data.sum_assured).toBe('')
  })

  test('非空保额仍按万→元换算', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', sum_assured: '50' }, {}, 'pid_1')
    expect(r.updatePolicy.data.sum_assured).toBe(500000)
  })

  // 2026-09-11：P1-F1 修复时漏了这两个日期字段——它们仍用 truthy 门控，
  // 清空（'' 为 falsy）被静默丢弃 → 提示保存成功但 DB 仍旧值，下次打开"复原"。
  // 服务端侧已确认可安全接收空串：POLICY_EDITABLE 含两者，且 effective_date 的
  // 格式校验显式短路空串（`v !== ''`），不会因此报 400。
  test('清空生效日期 → payload 含空串（不再被 truthy 门控丢弃）', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', effective_date: '' }, {}, 'pid_1')
    expect(r.updatePolicy.data).toHaveProperty('effective_date')
    expect(r.updatePolicy.data.effective_date).toBe('')
  })

  test('清空状态生效日期 → payload 含空串', () => {
    const r = buildUpdateData('policy', { product_name: '测试险', status_effective_date: '' }, {}, 'pid_1')
    expect(r.updatePolicy.data).toHaveProperty('status_effective_date')
    expect(r.updatePolicy.data.status_effective_date).toBe('')
  })

  test('未提供生效日期 → 不进 payload（避免误清空既有值）', () => {
    const r = buildUpdateData('policy', { product_name: '测试险' }, {}, 'pid_1')
    expect(r.updatePolicy.data.effective_date).toBeUndefined()
    expect(r.updatePolicy.data.status_effective_date).toBeUndefined()
  })
})

// ===========================================================================
// 2026-09-19 流程审计 P2-2：到期保单可编辑 + cancelled 不被静默改写
// ===========================================================================
describe('P2-2 保单状态：validate 只对手选终止类要求失效日期', () => {
  const { validate } = require('../miniprogram/utils/edit-form')

  test('系统推断态「到期终止」不要求失效日期（不在手选 options 内，DB 通常无此日期）', () => {
    // 原判定 `vals.status !== '有效'` 把 expired 也当"用户改了状态"→ 只改受益人的到期保单被卡死
    expect(validate('policy', { product_name: '康宁', status: '到期终止' }).ok).toBe(true)
  })

  test('手选终止类（失效/退保/理赔终止）仍强制填写失效日期', () => {
    for (const s of ['失效', '退保', '理赔终止']) {
      expect(validate('policy', { product_name: '康宁', status: s }).ok).toBe(false)
    }
    expect(validate('policy', { product_name: '康宁', status: '退保', status_effective_date: '2026-01-01' }).ok).toBe(true)
  })

  test('有效：不要求失效日期（原行为保持）', () => {
    expect(validate('policy', { product_name: '康宁', status: '有效' }).ok).toBe(true)
  })
})

describe('P2-2 保单状态：仅在文案变化时下发 status（防 cancelled→surrendered 静默改写）', () => {
  const { buildUpdateData } = require('../miniprogram/utils/edit-form')
  const withPolicy = (p) => ({ policies: [p] })

  test('文案未变（DB=cancelled，picker 显示「退保」）→ 不下发 status', () => {
    // 根因：STATUS_LABELS 中 surrendered 与 cancelled **共用文案「退保」**，
    // 反向派生表只能落回 Object.keys 首个（surrendered）→ 原实现每次保存都改写。
    const r = buildUpdateData('policy', { product_name: '康宁', status: '退保' }, withPolicy({ id: 'p1', status: 'cancelled' }), 'p1')
    expect(r.updatePolicy.data).not.toHaveProperty('status')
  })

  test('用户真改了状态（DB=active → 退保）→ 正常下发', () => {
    const r = buildUpdateData('policy', { product_name: '康宁', status: '退保' }, withPolicy({ id: 'p1', status: 'active' }), 'p1')
    expect(r.updatePolicy.data.status).toBe('surrendered')
  })

  test('未传 family（origPolicy 缺失）→ 视为变更并下发（保守，不吞用户操作）', () => {
    const r = buildUpdateData('policy', { product_name: '康宁', status: '退保' }, null, 'p1')
    expect(r.updatePolicy.data.status).toBe('surrendered')
  })

  test('DB=surrendered 且文本相同 → 不下发（幂等）', () => {
    const r = buildUpdateData('policy', { product_name: '康宁', status: '退保' }, withPolicy({ id: 'p1', status: 'surrendered' }), 'p1')
    expect(r.updatePolicy.data).not.toHaveProperty('status')
  })
})

// ===========================================================================
// 2026-09-19 流程审计 P2-1：成员 Sheet 补性别/职业/健康，且整组提交必须带上它们
//   （否则又是"表单收得到、payload 丢掉"——前几轮同类缺陷的复发路径）
// ===========================================================================
describe('P2-1 成员字段：Sheet 可填 + payload 不丢', () => {
  const { buildEditConfig, buildUpdateData } = require('../miniprogram/utils/edit-form')

  test('成员 Sheet 含 gender（男/女 selector）/ occupation / health', () => {
    const fs = buildEditConfig({ mode: 'member', family: { members: [] }, member: {} }).editFields
    const byKey = {}
    fs.forEach(f => { byKey[f.key] = f })
    expect(byKey.gender.type).toBe('selector')
    expect(byKey.gender.options).toEqual(['男', '女']) // 必须与后端 member-write 的 gender 校验同源
    expect(byKey.occupation).toBeDefined()
    expect(byKey.health).toBeDefined()
  })

  test('buildUpdateData(member)：三个新字段随整组提交（后端 _syncMembers 按白名单逐字段写，缺席即丢）', () => {
    const family = { members: [{ member_id: 'm1', name: '张三', role: '本人', age: 35 }] }
    const r = buildUpdateData('member', { name: '张三', age: '35', role: '本人', gender: '男', occupation: '工程师', health: '良好' }, family, 0)
    expect(r.members[0].gender).toBe('男')
    expect(r.members[0].occupation).toBe('工程师')
    expect(r.members[0].health).toBe('良好')
  })

  test('buildUpdateData(member)：清空 → 空串（后端对 undefined 跳过，空串才是真清空）', () => {
    const family = { members: [{ member_id: 'm1', name: '张三', role: '本人', age: 35, gender: '男', occupation: '工程师', health: '良好' }] }
    const r = buildUpdateData('member', { name: '张三', age: '35', role: '本人', gender: '', occupation: '', health: '' }, family, 0)
    expect(r.members[0].gender).toBe('')
    expect(r.members[0].occupation).toBe('')
    expect(r.members[0].health).toBe('')
  })

  test('buildUpdateData(member)：未提供的字段沿用原值（不被误清空）', () => {
    const family = { members: [{ member_id: 'm1', name: '张三', role: '本人', age: 35, gender: '男', occupation: '工程师' }] }
    const r = buildUpdateData('member', { name: '张三', age: '35', role: '本人' }, family, 0)
    expect(r.members[0].gender).toBe('男')
    expect(r.members[0].occupation).toBe('工程师')
    expect(r.members[0].health).toBe('')
  })

  test('buildUpdateData(addMember)：新成员同样带上三字段', () => {
    const r = buildUpdateData('addMember', { name: '赵六', role: '配偶', gender: '女', occupation: '教师', health: '健康' }, { members: [] })
    expect(r.members[r.members.length - 1]).toMatchObject({ gender: '女', occupation: '教师', health: '健康' })
  })
})

// ===========================================================================
// 2026-09-19 流程审计 P2-7：整组覆盖必须带删除基线（否则误删并发新增的成员）
// ===========================================================================
describe('P2-7 删除基线：整组覆盖带上"客户端见过的 member_id"', () => {
  const { buildUpdateData } = require('../miniprogram/utils/edit-form')
  const family = { members: [{ member_id: 'm1', name: '张三', role: '本人' }, { member_id: 'm2', name: '李四', role: '配偶' }] }

  test('member / addMember 两种模式都带 members_baseline', () => {
    expect(buildUpdateData('member', { name: '张三', age: '35', role: '本人' }, family, 0).members_baseline).toEqual(['m1', 'm2'])
    expect(buildUpdateData('addMember', { name: '王五', role: '子女' }, family).members_baseline).toEqual(['m1', 'm2'])
  })

  test('基线只含真实 member_id（骨架/未落库的临时 id 不入基线，避免误判"见过"）', () => {
    const mixed = { members: [{ member_id: 'm1', name: '张三' }, { name: '未落库的' }] }
    expect(buildUpdateData('member', { name: '张三', role: '本人' }, mixed, 0).members_baseline).toEqual(['m1'])
  })
})
