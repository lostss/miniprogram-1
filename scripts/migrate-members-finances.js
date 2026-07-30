#!/usr/bin/env node
/**
 * migrate-members-finances.js — Plan A 去冗余迁移脚本（幂等、可重复跑）
 *
 * 前置：安装 wx-server-sdk（npm i wx-server-sdk），并设置 ENV_ID 环境变量：
 *   ENV_ID=xxx node scripts/migrate-members-finances.js
 *
 * 作用（逐 family）：
 *   1. families.members 内嵌 → members 集合（保留原 member_id，去重）
 *   2. families.financial_snapshot 内嵌 → finances 集合（单例）
 *   3. join key 统一：policies.member_id / facts.subject_id 由 members._id 改写为 members.member_id
 *   4. 清理 families.members / families.financial_snapshot 内嵌（完成去冗余）
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: process.env.ENV_ID || (cloud.DYNAMIC_CURRENT_ENV) })
const db = cloud.database()
const _ = db.command

const BATCH = 100

function _shapeFromEmbedded(em) {
  return {
    member_id: em.member_id,
    family_id: null, // 由调用方补
    name: em.name || '',
    role: em.role || '',
    age: em.age || 0,
    birth_date: em.birth_date || '',
    gender: em.gender || '',
    occupation: em.occupation || '',
    health: em.health || '',
    income: em.income || 0,
    status: 'active'
  }
}

async function _paginate(collection, where, fields) {
  const out = []
  let last = null
  while (true) {
    let q = collection.where(where).limit(BATCH)
    if (last) q = q.skip(out.length) // 简化分页：基于累计偏移（数据量不大，足够）
    const r = await q.get()
    if (!r.data || r.data.length === 0) break
    out.push(...r.data)
    if (r.data.length < BATCH) break
  }
  return out
}

async function migrateFamily(fam) {
  const familyId = fam._id
  const openid = fam._openid
  let createdMembers = 0, createdFinances = 0, policyFix = 0, factFix = 0

  // 已有 members 集合文档
  const existing = await _paginate(db.collection('members'), { family_id: familyId })
  const byMemberId = new Map(existing.map(m => [m.member_id, m]))
  const idToMemberId = new Map() // members 集合 _id → member_id（供 join key 改写）
  for (const m of existing) idToMemberId.set(m._id, m.member_id)

  // 1. 内嵌 members → 集合（去重：同 member_id 已存在则跳过）
  const embedded = fam.members || []
  for (const em of embedded) {
    const mid = em.member_id || ('mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6))
    if (byMemberId.has(mid)) continue
    const doc = _shapeFromEmbedded(em)
    doc.member_id = mid
    doc.family_id = familyId
    await db.collection('members').add({ data: { ...doc, _openid: openid, created_at: new Date(), updated_at: new Date() } })
    createdMembers++
    byMemberId.set(mid, { member_id: mid })
  }

  // 2. 内嵌 financial_snapshot → finances 集合
  const snap = fam.financial_snapshot || {}
  const hasSnap = snap.income != null || (snap.debt && (snap.debt.amount != null || snap.debt !== '')) || snap.fixed_expense != null
  if (hasSnap) {
    const finExisting = await db.collection('finances').where({ family_id: familyId }).limit(1).get()
    if (!finExisting.data || finExisting.data.length === 0) {
      const debt = snap.debt
      await db.collection('finances').add({
        data: {
          _openid: openid, family_id: familyId,
          income: snap.income != null ? snap.income : null,
          debt: (debt && debt.amount != null) ? debt.amount : (typeof debt === 'object' ? null : debt),
          debt_type: (debt && debt.type) || '',
          fixed_expense: snap.fixed_expense != null ? snap.fixed_expense : null,
          created_at: new Date(), updated_at: new Date()
        }
      })
      createdFinances++
    }
  }

  // 3. join key 改写：policies.member_id（旧 _id）→ member_id
  if (idToMemberId.size > 0) {
    const oldIds = Array.from(idToMemberId.keys())
    const pols = await _paginate(db.collection('policies'), { family_id: familyId, member_id: _.in(oldIds) })
    for (const p of pols) {
      const newId = idToMemberId.get(p.member_id)
      if (newId) { await db.collection('policies').doc(p._id).update({ data: { member_id: newId } }); policyFix++ }
    }
    const facts = await _paginate(db.collection('facts'), { family_id: familyId, subject_type: 'member', subject_id: _.in(oldIds) })
    for (const f of facts) {
      const newId = idToMemberId.get(f.subject_id)
      if (newId) { await db.collection('facts').doc(f._id).update({ data: { subject_id: newId } }); factFix++ }
    }
  }

  // 4. 清理内嵌（完成去冗余）
  await db.collection('families').doc(familyId).update({
    data: {
      members: [],
      financial_snapshot: { income: null, debt: { amount: null, type: '' }, fixed_expense: null },
      updated_at: new Date()
    }
  }).catch(() => {})

  return { familyId, createdMembers, createdFinances, policyFix, factFix }
}

async function main() {
  const families = await _paginate(db.collection('families'), { status: _.neq('deleted') })
  let total = { families: 0, createdMembers: 0, createdFinances: 0, policyFix: 0, factFix: 0 }
  for (const fam of families) {
    try {
      const r = await migrateFamily(fam)
      total.families++
      total.createdMembers += r.createdMembers
      total.createdFinances += r.createdFinances
      total.policyFix += r.policyFix
      total.factFix += r.factFix
      console.log(`[ok] ${fam._id} +members=${r.createdMembers} +finances=${r.createdFinances} policyFix=${r.policyFix} factFix=${r.factFix}`)
    } catch (e) {
      console.error(`[fail] ${fam._id}: ${e.message}`)
    }
  }
  console.log('迁移完成:', JSON.stringify(total))
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
