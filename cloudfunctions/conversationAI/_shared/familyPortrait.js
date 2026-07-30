/**
 * familyPortrait — 从扁平 facts 三元组组装统一「家庭保障画像」
 *
 * 替代原 report 场景的「保单列表 + 全部事实」两张独立表：
 * - 屏蔽数据来源差异（OCR / 对话 / 表单 / 确认），统一为结构化画像
 * - 冲突处理：同谓词多三元组 → 高置信度优先；平手按 source 优先级
 *   ocr > agent_confirmed > user_form > conversation
 * - 保单状态不在 facts 存储层，由 policy 节点的「保障期间 / 生效日」经 calcStatus 推导
 * - 成员表字段（income/occupation/health）与 facts 矛盾时以 facts 为准（B3）
 * - 支持孤儿保障（对话补充有边无 policy 节点）降级为待确认
 *
 * 纯函数，依赖 calc-age / policy-status（同 _shared，随 sync 分发）。
 */
const { calcAge } = require('./calc-age')
const { calcStatus } = require('./policy-status')

const STANDARD_COVERAGE = ['寿险', '医疗险', '重疾险', '意外险', '年金险', '教育金', '防癌险', '护理险']
const SOURCE_PRIORITY = { ocr: 4, agent_confirmed: 3, user_form: 2, conversation: 1, ai: 1 }

/** 剥离 facts 中 OCR 误带的「元」后缀 → 还原为 policies 集合一致的万单位数值 */
function _normalizeAmount(val) {
  if (val == null || val === '') return ''
  const s = String(val).replace(/[元万元]/g, '').trim()
  const n = Number(s)
  return isNaN(n) ? String(val) : n
}

// 孤儿保障按名称推断标准维度（对话补充保单无 policy 节点时）
function _inferCategory(name) {
  const n = (name || '')
  for (const kw of [['医疗', '医疗险'], ['重疾', '重疾险'], ['寿险', '寿险'], ['意外', '意外险'], ['年金', '年金险'], ['教育', '教育金'], ['防癌', '防癌险'], ['护理', '护理险']]) {
    if (n.indexOf(kw[0]) !== -1) return kw[1]
  }
  return ''
}

// 同一 subject+predicate 的多条 fact → 取最优，标记争议
function _resolveOne(facts) {
  if (!facts || facts.length === 0) return null
  if (facts.length === 1) return { value: facts[0].object_value, source: facts[0].source, confidence: facts[0].confidence, disputed: false }
  const sorted = [...facts].sort((a, b) => {
    const c = (b.confidence || 0) - (a.confidence || 0)
    if (c !== 0) return c
    return (SOURCE_PRIORITY[b.source] || 0) - (SOURCE_PRIORITY[a.source] || 0)
  })
  const best = sorted[0]
  const disputed = sorted.some(f => f !== best && String(f.object_value) !== String(best.object_value))
  return { value: best.object_value, source: best.source, confidence: best.confidence, disputed }
}

// B3：时间衰减（读时计算，不写回存储）。超过 N 个月未更新且未 agent_confirmed 的事实临时降一级参与聚合
const { PORTRAIT } = require('./config')
const _DECAY_MONTHS = PORTRAIT.DECAY_MONTHS
const _DECAY_STEP = PORTRAIT.DECAY_STEP
function _decayedConfidence(f) {
  if (!f || f.source === 'agent_confirmed') return f ? f.confidence : 0
  const tsRaw = f.updated_at || f.created_at
  if (!tsRaw) return f.confidence
  const ts = new Date(tsRaw).getTime()
  if (!ts) return f.confidence
  const months = (Date.now() - ts) / (30 * 24 * 60 * 60 * 1000)
  return months > _DECAY_MONTHS ? Math.max(0.1, (f.confidence || 0) - _DECAY_STEP) : f.confidence
}

function _memberAgeMap(members) {
  const map = {}
  for (const m of members) {
    const id = m.member_id || m._id
    if (id) map[id] = calcAge(m.birth_date) || 0
  }
  return map
}

function buildPortrait(members, facts) {
  const active = (facts || []).filter(f => f.status === 'active').map(f => ({ ...f, confidence: _decayedConfidence(f) }))
  const ageMap = _memberAgeMap(members)
  const byMember = {}            // memberId -> facts[]
  const policyNodes = {}         // policyId -> { id, name, attrs, insuredMemberIds }
  const links = []               // { memberId, policyId, kind, name }

  for (const f of active) {
    if (f.subject_type === 'policy') {
      const node = policyNodes[f.subject_id] || (policyNodes[f.subject_id] = { id: f.subject_id, name: f.subject_name || '', attrs: {}, insuredMemberIds: new Set() })
      ;(node.attrs[f.predicate] = node.attrs[f.predicate] || []).push(f)
    } else {
      const mid = f.subject_id
      ;(byMember[mid] = byMember[mid] || []).push(f)
      if (f.predicate === '拥有保障' || f.predicate === '公司提供保障') {
        links.push({ memberId: mid, policyId: f.object_id, kind: f.predicate, name: f.object_value, confidence: f.confidence })
        if (f.predicate === '拥有保障' && policyNodes[f.object_id]) policyNodes[f.object_id].insuredMemberIds.add(mid)
      }
    }
  }

  // 解析保单节点 + 推导状态（status 不在 facts，由保障期间/生效日算）
  const policies = []
  for (const id of Object.keys(policyNodes)) {
    const node = policyNodes[id]
    const attrs = {}
    for (const p of Object.keys(node.attrs)) attrs[p] = _resolveOne(node.attrs[p])
    const insuredAge = [...node.insuredMemberIds].map(m => ageMap[m] || 0).filter(a => a > 0)[0] || 0
    const st = calcStatus({
      insurance_period: (attrs['保障期间'] || {}).value,
      effective_date: (attrs['生效日'] || {}).value,
      insured_age: insuredAge
    })
    const confs = Object.keys(attrs).map(k => (attrs[k] || {}).confidence || 0)
    policies.push({
      id, name: node.name, attrs,
      category: (attrs['险种'] || {}).value || '',
      sumAssured: _normalizeAmount((attrs['保额'] || {}).value),
      status: st.status, expiryInfo: st.expiryInfo,
      confidence: confs.length ? Math.max(...confs) : 0,
      insuredMemberIds: [...node.insuredMemberIds]
    })
  }

  const memberPortraits = []
  const pendingItems = []

  for (const m of members) {
    if (m.status === 'deleted') continue
    const mid = m.member_id || m._id
    const mf = byMember[mid] || []
    const get = pred => _resolveOne(mf.filter(f => f.predicate === pred))
    const own = get('个人年收入')
    const occ = get('职业')
    const healthFacts = mf.filter(f => f.predicate === '健康异常')
    const debt = get('负债')
    const asset = get('持有资产')
    const extraInfo = mf.filter(f => f.predicate === '未来计划' || f.predicate === '有特征' || f.predicate === '有偏好').map(f => `${f.predicate}：${f.object_value}`)

    // 覆盖矩阵
    const coverage = {}
    for (const dim of STANDARD_COVERAGE) coverage[dim] = { status: 'missing', amount: '', source: '' }
    const owned = links.filter(l => l.memberId === mid)
    for (const l of owned) {
      const pol = policies.find(p => p.id === l.policyId)
      if (!pol) {
        // 孤儿保障：有边无 policy 节点 → 降级为待确认
        const dim = _inferCategory(l.name)
        if (dim && coverage[dim].status === 'missing') coverage[dim] = { status: 'unknown', amount: '', source: 'conversation' }
        pendingItems.push(`${m.name}的「${l.name}」（来源：${l.kind === '公司提供保障' ? '公司团险' : '对话补充'}，缺保单明细，待确认）`)
        continue
      }
      const dim = pol.category
      if (STANDARD_COVERAGE.indexOf(dim) === -1) continue
      const st = pol.status === 'active' ? 'covered' : pol.status === 'expired' ? 'missing' : 'unknown'
      coverage[dim] = { status: st, amount: pol.sumAssured, source: (pol.attrs['险种'] || {}).source || '' }
    }

    memberPortraits.push({
      memberId: mid, name: m.name, role: m.role, age: calcAge(m.birth_date) || 0, gender: m.gender || '',
      // B3：facts 优先覆盖成员表字段
      income: own ? own.value : (m.income ? m.income + '万' : (m.income === 0 ? '0（待补全）' : '待补全')),
      incomeSource: own ? own.source : 'table',
      occupation: occ ? occ.value : (m.occupation || '-'),
      occupationSource: occ ? occ.source : 'table',
      health: healthFacts.length ? healthFacts.map(f => f.object_value).join('、') : (m.health || '-'),
      debt: debt ? debt.value : '-',
      asset: asset ? asset.value : '-',
      extraInfo,
      policies: owned.map(l => {
        const pol = policies.find(p => p.id === l.policyId)
        return pol
          ? { name: pol.name, category: pol.category, amount: pol.sumAssured, status: pol.status, expiryInfo: pol.expiryInfo, paymentPeriod: (pol.attrs['缴费期'] || {}).value || '', orphan: false, confidence: pol.confidence }
          : { name: l.name, category: _inferCategory(l.name), amount: '', status: 'unknown', orphan: true, confidence: l.confidence || 0 }
      }),
      coverage
    })
  }

  // 待确认：保单节点内争议
  for (const pol of policies) {
    for (const p of Object.keys(pol.attrs)) {
      const a = pol.attrs[p]
      if (a && a.disputed) pendingItems.push(`${pol.name} 的「${p}」存在争议（取高置信度：${a.value}）`)
    }
  }

  return { members: memberPortraits, policies, pending: pendingItems }
}

function renderPortraitMarkdown(portrait, { compact = false } = {}) {
  if (!portrait) return ''
  const lines = ['## 家庭保障画像']
  for (const mp of portrait.members) {
    const tags = [mp.role, mp.age].filter(Boolean).join('，')
    lines.push(`### 成员：${mp.name}（${tags}）`)
    const info = []
    if (mp.occupation && mp.occupation !== '-') info.push(`- 职业：${mp.occupation}`)
    if (mp.health && mp.health !== '-' && mp.health !== '健康') info.push(`- 健康：${mp.health}`)
    if (mp.income) info.push(`- 个人年收入：${mp.income}`)
    if (mp.debt && mp.debt !== '-') info.push(`- 负债：${mp.debt}`)
    if (mp.asset && mp.asset !== '-') info.push(`- 持有资产：${mp.asset}`)
    lines.push(...info)

    if (!compact && mp.extraInfo && mp.extraInfo.length) {
      lines.push('**其他补充信息：**')
      for (const e of mp.extraInfo) lines.push('- ' + e)
    }

    if (compact) {
      const cov = STANDARD_COVERAGE.map(dim => {
        const c = mp.coverage[dim]
        const t = c.status === 'covered' ? '有' : c.status === 'unknown' ? '待确认' : '缺'
        return `${dim}:${t}`
      }).join(' ')
      lines.push(`- 保障覆盖：${cov}`)
      continue
    }

    lines.push('**已有保障：**')
    if (mp.policies.length) {
      lines.push('| 保障 | 险种 | 保额 | 状态 | 来源 | 置信度 | 缴费期 | 备注 |')
      lines.push('|------|------|------|------|------|------|------|------|')
      for (const p of mp.policies) {
        const statusTxt = p.status === 'active' ? '有效' : p.status === 'expired' ? '已失效' : '待确认'
        const src = p.orphan ? '对话' : 'OCR'
        const conf = p.confidence || 0
        const confTxt = conf >= 0.8 ? '高' : conf >= 0.5 ? '中' : '低'
        lines.push(`| ${p.name || '-'} | ${p.category || '待确认'} | ${p.amount || '待确认'} | ${statusTxt} | ${src} | ${confTxt} | ${p.paymentPeriod || '—'} | ${p.expiryInfo || (p.orphan ? '缺保单明细' : '')} |`)
      }
    }
    lines.push('**保障覆盖：**')
    lines.push('| 险种 | 覆盖状态 | 保额 |')
    lines.push('|------|---------|------|')
    for (const dim of STANDARD_COVERAGE) {
      const c = mp.coverage[dim]
      const txt = c.status === 'covered' ? '✅ 已覆盖' : c.status === 'unknown' ? '⚠️ 待确认' : '❌ 缺失'
      lines.push(`| ${dim} | ${txt} | ${c.amount || '—'} |`)
    }
  }
  if (!compact && portrait.pending.length) {
    lines.push('### 待确认事项')
    for (const it of portrait.pending) lines.push('- ' + it)
  }
  return lines.join('\n')
}

module.exports = { buildPortrait, renderPortraitMarkdown, STANDARD_COVERAGE, SOURCE_PRIORITY }
