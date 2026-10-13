/**
 * 成员矛盾澄清机制单元测试
 * 验证 upsertMember：对话路径(confirmOnConflict)与历史年龄/出生日期相差≥2岁时返回 409 needsConfirm，
 * 确认卡片二次调用(confirmed:true)才覆盖；非对话调用与普通差异(<2岁)直接写入。
 */
const { upsertMember } = require('../cloudfunctions/_shared/memberRepo')
const { makeMemoryDb } = require('./helpers/memory-db')

// 2026-09-15 架构审查候选 4：改用手写原语的唯一实现 memory-db。
// 旧桩在匹配前 `delete f._openid`——因为 seed 不带 _openid，桩必须放水才匹配得上，
// 这使"查询是否真的按 _openid 隔离"完全无法被验证（越权读类问题一律静默通过）。
// adapter 按真实语义匹配 _openid，故 seed 补上该字段（生产记录必有，见 read 侧三件套不变量）。
function makeDb(seed = []) {
  const store = { members: seed.map((m, i) => ({ ...m, _id: m._id || 'id_' + i })) }
  return makeMemoryDb(store)
}

const FAM = 'fam1'
const OID = 'o1'
const EXISTING = [{ member_id: 'mem_1', family_id: FAM, _openid: 'o1', name: '李阳勇', role: '本人', age: 50, birth_date: '1976-01-01' }]

test('对话路径：年龄相差≥2岁 → 返回 409 needsConfirm 且不直接覆盖', async () => {
  const db = makeDb(JSON.parse(JSON.stringify(EXISTING)))
  const r = await upsertMember(db, FAM, OID, { memberName: '李阳勇', data: { age: 48 }, confirmOnConflict: true })
  expect(r.code).toBe(409)
  expect(r.needsConfirm).toBe(true)
  expect(r.data.conflict.field).toBe('age')
  expect(r.data.proposed.age).toBe(48)
  // 历史未被覆盖
  const still = await db.collection('members').where({ member_id: 'mem_1' }).get()
  expect(still.data[0].age).toBe(50)
})

test('对话路径：年龄相差<2岁 → 直接写入', async () => {
  const db = makeDb(JSON.parse(JSON.stringify(EXISTING)))
  const r = await upsertMember(db, FAM, OID, { memberName: '李阳勇', data: { age: 49 }, confirmOnConflict: true })
  expect(r.code).toBe(200)
  expect(r.needsConfirm).toBeFalsy()
  const m49 = await db.collection('members').where({ member_id: 'mem_1' }).get()
  expect(m49.data[0].age).toBe(49)
})

test('非对话调用（OCR/批量）：即使相差≥2岁也直接写入', async () => {
  const db = makeDb(JSON.parse(JSON.stringify(EXISTING)))
  const r = await upsertMember(db, FAM, OID, { memberName: '李阳勇', data: { age: 30 } })
  expect(r.code).toBe(200)
  expect(r.needsConfirm).toBeFalsy()
})

test('确认卡片二次调用(confirmed:true)：跳过矛盾检测强制覆盖', async () => {
  const db = makeDb(JSON.parse(JSON.stringify(EXISTING)))
  const first = await upsertMember(db, FAM, OID, { memberName: '李阳勇', data: { age: 48 }, confirmOnConflict: true })
  expect(first.code).toBe(409)
  const second = await upsertMember(db, FAM, OID, {
    memberName: '李阳勇',
    data: first.data.proposed,
    confirmed: true,
    confirmOnConflict: true
  })
  expect(second.code).toBe(200)
  const m = (await db.collection('members').where({ member_id: 'mem_1' }).get()).data[0]
  expect(m.age).toBe(48)
  expect(m.birth_date).toBe('1978-01-01')
})

test('出生日期年份相差≥2 → 矛盾', async () => {
  const db = makeDb([{ member_id: 'mem_2', family_id: FAM, _openid: 'o1', name: '谢敏', role: '配偶', birth_date: '1990-05-20' }])
  const r = await upsertMember(db, FAM, OID, { memberName: '谢敏', data: { birth_date: '1980-05-20' }, confirmOnConflict: true })
  expect(r.code).toBe(409)
  expect(r.data.conflict.field).toBe('birth_date')
})
