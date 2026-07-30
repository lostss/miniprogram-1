/**
 * member-matcher — 保单成员匹配（ocr-core 内部子模块）
 * Plan A：成员真相源为 members 集合，本模块只读写 members 集合，不再触碰 families.members
 *
 * 对外接口: matchPoliciesToMembers(opts)
 */

const { writeSeam } = require('./writeSeam')
const { getMembers, updateMemberFields } = require('./memberRepo')

const SKELETON_RE = /^成员\d+$/

function _tryMatch(name, members) {
  if (!name) return null
  let m = members.find(m2 => m2.name === name)
  if (m) return m
  const fuzz = members.filter(m2 => m2.name && !SKELETON_RE.test(m2.name) && (m2.name.includes(name) || name.includes(m2.name)))
  if (fuzz.length === 1) return fuzz[0]
  return null
}

async function matchPoliciesToMembers({ db, familyId, openid, allPolicies }) {
  if (!allPolicies || allPolicies.length === 0) return

  try {
    const members = await getMembers(db, familyId, openid)
    let membersDirty = false

    const unmatchedNames = new Set()

    for (const p of allPolicies) {
      // 尊重已存在的 member_id（ocrSingle 已移除此调用，但前端可能预设）
      if (p.member_id) continue

      const names = [
        p.insured_name,
        p.policyholder_name,
        p.beneficiary_birth_date ? p.beneficiary_name : null
      ].filter(Boolean).map(s => s.trim()).filter((v, i, a) => a.indexOf(v) === i)

      let insuredMatch = null
      for (const name of names) {
        const match = _tryMatch(name, members)
        if (!match) {
          if (name === (p.insured_name || '').trim()) unmatchedNames.add(name)
          continue
        }
        if (name === (p.insured_name || '').trim() && !insuredMatch) insuredMatch = match
      }
      if (insuredMatch) p.member_id = insuredMatch.member_id || ''
    }

    const skeletonMembers = members.filter(m => SKELETON_RE.test(m.name || ''))
    let skeletonIdx = 0
    // Bug-8 修复：跟踪新成员写入结果，失败时回滚 member_id 赋值，避免孤儿引用
    const newMemberPromises = []
    const failedMemberIds = new Set()
    for (const name of unmatchedNames) {
      let target = null
      if (skeletonIdx < skeletonMembers.length) {
        target = skeletonMembers[skeletonIdx++]
        target.name = name
      } else {
        const memberId = 'mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)
        target = { member_id: memberId, name }
        members.push(target)
        // 新增成员：经 writeSeam silentAdd（_openid 注入），钩子由末尾统一触发
        const ws = writeSeam(db, openid, familyId, { markMutated: false, advanceStageHook: false })
        newMemberPromises.push(ws.silentAdd('members', {
          member_id: memberId, family_id: familyId, name, role: '', status: 'active',
          created_at: new Date(), updated_at: new Date()
        }).then(() => ({ ok: true, memberId })).catch(e => {
          console.error('[member-matcher] 新增成员写入失败:', e.message)
          return { ok: false, memberId }
        }))
      }
      membersDirty = true
      for (const p of allPolicies) {
        if ((p.insured_name || '').trim() === name && !p.member_id) {
          p.member_id = target.member_id
        }
      }
    }
    // 检查新成员写入结果，回滚失败的 member_id 赋值
    const addResults = await Promise.all(newMemberPromises)
    for (const r of addResults) {
      if (r && !r.ok && r.memberId) {
        failedMemberIds.add(r.memberId)
        // 从 members 数组移除失败的成员
        const idx = members.findIndex(m => m.member_id === r.memberId)
        if (idx >= 0) members.splice(idx, 1)
      }
    }
    // 回滚赋给失败 member_id 的保单
    if (failedMemberIds.size > 0) {
      for (const p of allPolicies) {
        if (p.member_id && failedMemberIds.has(p.member_id)) {
          p.member_id = ''
        }
      }
    }

    // Bug-7 修复：birthDateUpdated 仅在真正写入时置 true，避免误报触发不必要的 markMutated/advanceStage
    // - updateMemberFields 返回 data.updated 表示是否实际更新（patch 非空时为 true）
    // - 同步更新本地 members 数组的 birth_date，避免同成员被多张保单重复推送
    let birthDateUpdated = false
    const birthUpdatePromises = []
    function _pushBirthUpdate(memberId, birthDate) {
      birthUpdatePromises.push(
        updateMemberFields(db, familyId, openid, memberId, { birth_date: birthDate })
          .then(r => {
            if (r && r.code === 200 && r.data && r.data.updated) {
              birthDateUpdated = true
              // 同步本地缓存，避免同成员重复推送
              const m = members.find(x => x.member_id === memberId)
              if (m) m.birth_date = birthDate
            }
          })
          .catch(e => console.error('[member-matcher] 更新生日失败:', e.message))
      )
    }
    for (const p of allPolicies) {
      const insuredBd = p.insured_birth_date
      const policyholderBd = p.policyholder_birth_date
      const beneficiaryBd = p.beneficiary_birth_date
      const insuredName = (p.insured_name || '').trim()
      const phName = (p.policyholder_name || '').trim()
      const bnName = (p.beneficiary_name || '').trim()

      // 被保人生日：写入 member_id 对应成员
      if (p.member_id && insuredBd && /^\d{4}-\d{2}-\d{2}$/.test(insuredBd)) {
        const m = members.find(x => x.member_id === p.member_id)
        if (m && !m.birth_date) _pushBirthUpdate(p.member_id, insuredBd)
      }
      // 投保人生日
      if (policyholderBd && /^\d{4}-\d{2}-\d{2}$/.test(policyholderBd) && phName && phName !== insuredName) {
        const phMatch = members.find(m => m.name === phName)
        if (phMatch && !phMatch.birth_date) _pushBirthUpdate(phMatch.member_id, policyholderBd)
      }
      // 受益人生日
      if (beneficiaryBd && /^\d{4}-\d{2}-\d{2}$/.test(beneficiaryBd) && bnName && bnName !== insuredName && bnName !== phName) {
        const bnMatch = members.find(m => m.name === bnName)
        if (bnMatch && !bnMatch.birth_date) _pushBirthUpdate(bnMatch.member_id, beneficiaryBd)
      }
    }
    await Promise.all(birthUpdatePromises)

    // policies.member_id 同步：经 writeSeam silentUpdateWhere（_openid 注入）
    const wsSync = writeSeam(db, openid, familyId, { markMutated: false, advanceStageHook: false })
    const syncPromises = allPolicies.filter(p => p.member_id).map(p => {
      const where = {}
      if (p.policy_number) {
        where.policy_number = p.policy_number
      } else if (p.id) {
        where.id = p.id
      } else {
        return Promise.resolve()
      }
      return wsSync.silentUpdateWhere('policies', where, { member_id: p.member_id })
        .catch(e => console.error('[member-matcher] 同步 member_id 失败:', e.message))
    })
    await Promise.all(syncPromises)

    // 成员/保单变更 → 末尾统一触发钩子（markMutated + advanceStage）
    if (membersDirty || birthDateUpdated) {
      const ws = writeSeam(db, openid, familyId)
      await ws.triggerHooks()
    }

    try {
      const mc = allPolicies.filter(p => p.member_id).length
      // operation_logs 审计写入：无 familyId 钩子（writeSeam 工厂 silentAdd 已注入 _openid）
      const wsLog = writeSeam(db, openid, null)
      await wsLog.silentAdd('operation_logs', {
        action: 'match_policies', family_id: familyId, _openid: openid,
        result: { status: 'ok', summary: '匹配' + allPolicies.length + '份保单, ' + mc + '份有成员关联' },
        meta: { updated: !!(membersDirty || birthDateUpdated), total: allPolicies.length, matched: mc },
        created_at: new Date()
      }).catch(() => {})
    } catch (e) { console.error('[member-matcher] operation_log 写入失败:', e.message) }

    return { updated: membersDirty || birthDateUpdated, policies: allPolicies }
  } catch (e) {
    console.error('[member-matcher] 失败:', e.message)
    try {
      const wsLog = writeSeam(db, openid, null)
      await wsLog.silentAdd('operation_logs', {
        action: 'match_policies', family_id: familyId, _openid: openid,
        result: { status: 'fail', error: e.message }, created_at: new Date()
      }).catch(err => console.error('[member-matcher] 错误日志写入失败:', err.message))
    } catch (e2) { console.error('[member-matcher] operation_log 错误日志写入异常:', e2.message) }
  }
}

module.exports = { matchPoliciesToMembers, _tryMatch, SKELETON_RE }
