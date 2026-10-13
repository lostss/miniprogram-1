/**
 * 客户版分享的脱敏与 token —— 2026-09-28 dsh 会话复审（审计项⑧：覆盖率空洞）
 *
 * `cloudfunctions/dataQuery/share.js` 此前整段无测试，而它同时担着两件事：
 *   ① **数据红线**：客户（非 owner）拿到的是脱敏后的整份报告 → 姓名掩码、`_openid`/
 *      `special_agreement`/内部字段剔除、保单号只留尾 4 位
 *   ② **安全**：token 是「用户输入直接当 where 值、且刻意不带 _openid」的唯一查询 →
 *      必须严格类型 + 48 位小写 hex 校验（2026-09-22 P0-1：`{$exists:true}` 操作符注入
 *      可命中任意已分享家庭）
 *
 * 本文件只覆盖**纯函数脱敏**、`shareFamily` 的 token 复用/过期，以及 `getSharedFamily`
 * 的入参校验（校验发生在任何 DB 访问之前）；整链取数不在范围内。
 */
const { shareFamily, getSharedFamily, _maskName, _maskFamilyName, _maskMembers, _maskFacts, _maskPolicies } =
  require('../cloudfunctions/dataQuery/share')

const HEX48 = 'a'.repeat(48)
const DAY = 24 * 3600 * 1000

/** 极简假 db：只实现本文件用到的链式形态 */
function mkDb(fam) {
  const updates = []
  return {
    _updates: updates,
    collection: () => ({
      where: () => ({
        get: async () => ({ data: fam ? [fam] : [] }),
        update: async ({ data }) => { updates.push(data); return { stats: { updated: 1 } } }
      })
    })
  }
}

describe('脱敏纯函数（数据红线）', () => {
  test('姓名：首字 + **；空值返回空串', () => {
    expect(_maskName('张三')).toBe('张**')
    expect(_maskName('')).toBe('')
    expect(_maskName(undefined)).toBe('')
  })

  test('家庭名：首字 + 家庭', () => {
    expect(_maskFamilyName('李四')).toBe('李家庭')
    expect(_maskFamilyName('')).toBe('')
  })

  test('成员：掩码姓名 + 剔除 _openid（owner 身份不得泄露给查看者）', () => {
    const out = _maskMembers([{ _id: 'm1', name: '王五', role: '本人', _openid: 'o_owner' }])
    expect(out[0].name).toBe('王**')
    expect(out[0]._openid).toBeUndefined()
    expect(out[0].role).toBe('本人')
  })

  test('保单：三类姓名掩码 + 保单号只留尾 4 位 + 剔除 special_agreement/_openid', () => {
    const out = _maskPolicies([{
      _id: 'p1', insured_name: '王五', policyholder_name: '李四', beneficiary_name: '张六',
      policy_number: 'P2026092800012345', special_agreement: '私下约定', _openid: 'o_owner'
    }])
    expect(out[0].insured_name).toBe('王**')
    expect(out[0].policyholder_name).toBe('李**')
    expect(out[0].beneficiary_name).toBe('张**')
    expect(out[0].policy_number).toBe('****2345')
    expect(out[0].special_agreement).toBeUndefined()
    expect(out[0]._openid).toBeUndefined()
  })

  test('事实：主体姓名掩码 + 自由文本值走 pii-rules 脱敏（手机号不得原样下发）', () => {
    const out = _maskFacts([{
      _id: 'f1', subject_id: 'm1', subject_type: 'member', subject_name: '王五',
      predicate: '联系方式', axis: '', kind: 'fact', object_value: '手机13800138000', confidence: 0.9, created_at: 1
    }])
    expect(out[0].subject_name).toBe('王**')
    expect(out[0].object_value).not.toContain('13800138000')
    // 白名单投影：未列出的字段不带出去
    expect(out[0]._openid).toBeUndefined()
  })
})

describe('shareFamily — token 生成/复用', () => {
  test('未过期 → 复用同一 token，不写库', async () => {
    const token = 'b'.repeat(48)
    const expires = Date.now() + 3 * DAY
    const db = mkDb({ _id: 'f1', _openid: 'o1', share: { token, expires_at: expires } })
    const r = await shareFamily(db, 'o1', { familyId: 'f1' })
    expect(r.code).toBe(200)
    expect(r.data).toEqual({ token, expiresAt: expires })
    expect(db._updates.length).toBe(0)
  })

  test('已过期 → 换新 token 并写库，TTL 为 7 天', async () => {
    const db = mkDb({ _id: 'f1', _openid: 'o1', share: { token: 'c'.repeat(48), expires_at: Date.now() - DAY } })
    const before = Date.now()
    const r = await shareFamily(db, 'o1', { familyId: 'f1' })
    expect(r.code).toBe(200)
    expect(r.data.token).toMatch(/^[0-9a-f]{48}$/)
    expect(r.data.token).not.toBe('c'.repeat(48))
    expect(r.data.expiresAt - before).toBeGreaterThan(7 * DAY - 60000)
    expect(r.data.expiresAt - before).toBeLessThan(7 * DAY + 60000)
    expect(db._updates.length).toBe(1)
  })

  test('家庭不存在/非 owner → 404，不生成 token', async () => {
    const r = await shareFamily(mkDb(null), 'o1', { familyId: 'f1' })
    expect(r.code).toBe(404)
    expect(await shareFamily({ collection: () => ({ where: () => ({ get: async () => ({ data: [] }) }) }) }, 'o1', {})).toMatchObject({ code: 400 })
  })
})

describe('getSharedFamily — token 入参校验（P0-1 操作符注入）', () => {
  const boomDb = { collection: () => { throw new Error('不得触碰 DB') } }

  test.each([
    ['操作符对象 $exists', { $exists: true }],
    ['嵌套对象', { 'share.token': 'x' }],
    ['48 位但大写', 'A'.repeat(48)],
    ['47 位', 'a'.repeat(47)],
    ['非 hex 字符', 'z'.repeat(48)],
    ['数字', 12345],
    ['undefined', undefined]
  ])('%s → 400 且不访问数据库', async (_label, token) => {
    const r = await getSharedFamily(boomDb, 'o_customer', { token })
    expect(r.code).toBe(400)
    expect(r.msg).toBe('分享链接无效')
  })
})
