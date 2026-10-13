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
const { calcStatus, STATUS_LABELS } = require('./policy-status')
const { STANDARD_COVERAGE, axisOf, kindOf } = require('./fact-vocab')
// 2026-09-22 修（数据盘点批次 1）：画像覆盖矩阵此前用**原始** insurance_category 与
// STANDARD_COVERAGE 比对，而库里可能存裸词/异体拼写（'年金险'）→ 命中不了就 continue，
// 该维度恒为 missing；同一张保单在缺口矩阵（经 canonCat 归一）却算作已有覆盖
// → 同一份 AI 上下文自相矛盾。改为同源归一。
const { canonCat } = require('./thresholds')
const { yuanToWan, fmtYuan } = require('./amount')

const SOURCE_PRIORITY = { ocr: 4, agent_confirmed: 3, user_form: 2, conversation: 1, ai: 1 }
const SOURCE_LABEL = { ocr: 'OCR', agent_confirmed: '已确认', user_form: '表单', conversation: '对话', ai: 'AI' }

// 已进结构化画像字段的属性槽 → 渲染时不再重复进「其他事实」区
const _STRUCTURED_AXES = new Set(['个人年收入', '职业', '健康异常', '总负债', '持有资产', '年龄', '性别'])
// 保障边谓词 → 已由 links / policies 消费
const _COVERAGE_EDGE_PREDICATES = ['拥有保障', '公司提供保障', '投保']

/** 剥离 facts 中 OCR 误带的「元」后缀 → 还原为 policies 集合一致的万单位数值 */
function _normalizeAmount(val) {
  if (val == null || val === '') return ''
  const s = String(val).replace(/[元万元]/g, '').trim()
  const n = Number(s)
  return isNaN(n) ? String(val) : n
}

// 孤儿保障按名称推断标准维度（对话补充保单无 policy 节点时）
// 返回【全部】命中维度："重疾+医疗综合险" 应同时点亮两个维度，不能只取首个命中
// ⚠️ 右值必须是 fact-vocab.STANDARD_COVERAGE 里的**规范词**：2026-09-22 把 '年金险' 规范为
// '年金' 时漏改了本表，'年金' 仍映射到不存在的 '年金险' → 下游 `coverage[dim].status` 读 undefined
// 直接抛 TypeError，**整份报告生成 500**（不是少点亮一个维度）。已由 tests/familyPortrait.test.js 钉住。
const _CATEGORY_KW = [['医疗', '医疗险'], ['重疾', '重疾险'], ['寿险', '寿险'], ['意外', '意外险'], ['年金', '年金'], ['教育', '教育金'], ['防癌', '防癌险'], ['护理', '护理险']]
function _inferCategories(name) {
  const n = String(name || '')
  const out = []
  for (const kw of _CATEGORY_KW) {
    if (n.indexOf(kw[0]) !== -1 && out.indexOf(kw[1]) === -1) out.push(kw[1])
  }
  return out
}

// 覆盖三态：保单状态 → covered / missing / unknown
// 2026-09-15：原实现只认 active/expired，lapsed/surrendered/claim_terminated 等
// 手动终止状态全部落进 unknown（在报告里显示为"待确认"）——与 reportPdf._statusTxt 同源的缺陷。
const _MISSING_STATES = ['expired', 'lapsed', 'surrendered', 'claim_terminated', 'cancelled']
function _coverageState(status) {
  if (status === 'active') return 'covered'
  if (_MISSING_STATES.indexOf(status) !== -1) return 'missing'
  return 'unknown'
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

// 事实按 kind 分组（供 AI 深度分析消费）
// 2026-09-14：不再用谓词白名单过滤（旧 EXTRA_PREDICATES 只放行 8 个谓词，其余写入等于没采）。
// 只排除两类「已在别处消费」的：
//   1) 已进结构化画像字段的属性槽（收入/职业/健康/负债/资产/年龄/性别）
//   2) 保障边（拥有保障/公司提供保障/投保 → links + policies）
// 其余全量按 kind 落地：fact 可直接引用 / constraint 分析时必须考虑 / relation 提示多实体 / lead 列入待确认
function _groupFacts(mf) {
  const out = { fact: [], constraint: [], relation: [], lead: [] }
  for (const f of mf) {
    const ax = f.axis || axisOf(f.predicate)
    if (ax && _STRUCTURED_AXES.has(ax)) continue
    if (_COVERAGE_EDGE_PREDICATES.indexOf(f.predicate) !== -1) continue
    const k = kindOf(f.predicate, f.kind)
    out[k].push({
      label: f.predicate,
      value: f.object_value,
      source: f.source || '',
      confidence: f.confidence || 0
    })
  }
  return out
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

function buildPortrait(members, facts, opts = {}) {
  const active = (facts || []).filter(f => f.status === 'active').map(f => ({ ...f, confidence: _decayedConfidence(f) }))
  const ageMap = _memberAgeMap(members)
  const byMember = {}            // memberId -> facts[]
  const policyNodes = {}         // policyId -> { id, name, attrs, insuredMemberIds }
  const links = []               // { memberId, policyId, kind, name }

  // 2026-09-15 收敛「保障覆盖」权威源（架构审查候选 1）：
  // 画像的保单节点与覆盖判定原来自 facts 派生——facts 缺 policy 记录即误报"无保障"，
  // 这正是 reportAI prompts「禁止仅凭画像覆盖矩阵判定无任何保障」警告的根因；
  // 而同一份 AI 上下文里的「保障缺口矩阵」用 policies 集合 → 两个判定互相打架。
  // 现支持传入 opts.policies（policies 集合）：保单节点与覆盖判定与缺口矩阵同源。
  // 未传时回退 facts 派生（旧路径），行为不变。
  const authPolicies = Array.isArray(opts.policies) ? opts.policies.filter(p => p.status !== 'deleted') : null

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

  // 保单节点：权威 policies 集合优先（与「保障缺口矩阵」同源）；未提供则从 facts 派生
  // （facts 派生的状态由保障期间/生效日经 calcStatus 推导；权威源的 status 直接来自 DB）
  const policies = []
  if (authPolicies) {
    for (const p of authPolicies) {
      const id = p.id || p._id || ''
      if (!id) continue
      // 单位契约（amount.js）：DB 存元、展示转万。facts 派生的保额已是"XX万"（经 _normalizeAmount
      // 还原为万数值），权威源必须同样转万——否则渲染出"500000万"。
      const rawAmt = Number(p.sum_assured)
      const amt = isFinite(rawAmt) && rawAmt > 0 ? yuanToWan(rawAmt) : ''
      const src = p.source || 'ocr'
      // 适配为内部 attrs 形状 → 渲染层与覆盖判定无需分支
      const attrs = {
        '险种': { value: p.insurance_category || '', source: src },
        '保额': { value: amt, source: src },
        '年缴保费': { value: p.annual_premium ? fmtYuan(p.annual_premium) : '', source: src },
        '生效日': { value: p.effective_date || '', source: src },
        '保障期间': { value: p.insurance_period || '', source: src },
        '缴费期': { value: p.payment_period || '', source: src }
      }
      policies.push({
        id, name: p.product_name || '', attrs,
        category: canonCat(p.insurance_category || ''),
        sumAssured: amt,
        // 保留原始状态值（渲染经 STATUS_LABELS 查表；原实现只认 active/expired，
        // lapsed/surrendered 等手动终止状态会掉进 unknown）
        status: p.status || 'unknown',
        expiryInfo: '',
        confidence: p.confidence || 0,
        insuredMemberIds: p.member_id ? [p.member_id] : []
      })
    }
  } else {
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
  }

  const memberPortraits = []
  const pendingItems = []

  for (const m of members) {
    if (m.status === 'deleted') continue
    const mid = m.member_id || m._id
    const mf = byMember[mid] || []
    // 2026-09-14：改为按归一化属性槽（axis）取值——predicate 已自由化（AI 可能写"年薪"），
    // 字面量精确匹配会漏；axisOf 把同义说法归一到同一槽（"年薪" → "个人年收入"）。
    const axOf = f => f.axis || axisOf(f.predicate)
    const getAx = ax => _resolveOne(mf.filter(f => axOf(f) === ax))
    const own = getAx('个人年收入')
    const occ = getAx('职业')
    const healthFacts = mf.filter(f => axOf(f) === '健康异常')
    const debt = getAx('总负债')
    const asset = getAx('持有资产')

    // 覆盖矩阵
    const coverage = {}
    for (const dim of STANDARD_COVERAGE) coverage[dim] = { status: 'missing', amount: '', source: '' }
    // 保单来源：权威 policies（若提供）取该成员名下保单；facts 边只补充「孤儿保障」
    // （对话补充的团险等库里无记录的保障——只存在于 facts，不能被权威源覆盖掉）
    let owned
    if (authPolicies) {
      const authOwned = policies
        .filter(p => p.insuredMemberIds.indexOf(mid) !== -1)
        .map(p => ({ memberId: mid, policyId: p.id, kind: '拥有保障', name: p.name, confidence: p.confidence }))
      const authIds = new Set(authOwned.map(o => o.policyId))
      owned = authOwned.concat(links.filter(l => l.memberId === mid && !(l.policyId && authIds.has(l.policyId))))
    } else {
      owned = links.filter(l => l.memberId === mid)
    }
    for (const l of owned) {
      const pol = policies.find(p => p.id === l.policyId)
      if (!pol) {
        // 孤儿保障：有边无 policy 记录 → 降级为待确认（综合型产品可能同时点亮多个维度）
        for (const dim of _inferCategories(l.name)) {
          // 防御：字典若再漂移（新增关键词但漏进 STANDARD_COVERAGE），此处只跳过该维度，
          // 不让整份报告生成失败（2026-09-22 的 '年金险' 事故就是这么炸的）
          if (!coverage[dim]) continue
          if (coverage[dim].status === 'missing') coverage[dim] = { status: 'unknown', amount: '', source: 'conversation' }
        }
        pendingItems.push(`${m.name}的「${l.name}」（来源：${l.kind === '公司提供保障' ? '公司团险' : '对话补充'}，缺保单明细，待确认）`)
        continue
      }
      const dim = pol.category
      if (STANDARD_COVERAGE.indexOf(dim) === -1) continue
      // 2026-09-22 修（报告链路审计 P1-4）：原为**赋值** → 同一成员同险种有多张保单时只留最后一张，
      // 与缺口矩阵口径分裂：gap-core 对同一 member+category 的 active 保额是**累加**
      // （gap-core.js:139 `existing[c] = (existing[c]||0) + ...`）→ 画像说"医疗险 800 万"，
      // 而同一份 AI 上下文的结构化保单清单里是 400 + 800 两行，模型按哪个说都可能。
      // 现按同一口径累加，状态取更乐观的一个（任一 covered 即 covered）。
      // ⚠️ 2026-09-28 审计 P3 更正：金额必须**只计 covered**（= active），不能用 `st !== 'missing'`
      // —— `_coverageState` 对非 active 且不在 _MISSING_STATES 的状态（pending/历史脏值）返回 'unknown'，
      // 那样这些保单会同时出现在"画像已有保额"里、却不出现在缺口矩阵的 existing 里（gap-core 只累加 active）
      // → 同一份 AI 上下文两个数。可达性低，但既称"同口径"就必须真的同口径。
      const st = _coverageState(pol.status)
      const cur = coverage[dim]
      const addAmt = Number(pol.sumAssured) || 0
      const counted = st === 'covered'
      coverage[dim] = {
        status: (cur.status === 'covered' || st === 'covered') ? 'covered'
          : ((cur.status === 'unknown' || st === 'unknown') ? 'unknown' : 'missing'),
        amount: counted ? (Number(cur.amount) || 0) + addAmt : cur.amount,
        source: counted ? ((pol.attrs['险种'] || {}).source || cur.source || '') : cur.source
      }
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
      // 全量事实按 kind 分组（供 AI 深度分析；已进结构化字段与保障边的除外）
      factsByKind: _groupFacts(mf),
      policies: owned.map(l => {
        const pol = policies.find(p => p.id === l.policyId)
        return pol
          ? { name: pol.name, category: pol.category, amount: pol.sumAssured, status: pol.status, expiryInfo: pol.expiryInfo, paymentPeriod: (pol.attrs['缴费期'] || {}).value || '', premium: (pol.attrs['年缴保费'] || {}).value || '', effectiveDate: (pol.attrs['生效日'] || {}).value || '', orphan: false, confidence: pol.confidence }
          : { name: l.name, category: _inferCategories(l.name).join('+'), amount: '', status: 'unknown', orphan: true, confidence: l.confidence || 0 }
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

// kind 渲染顺序：约束/关系/线索优先（分析价值最高），普通事实垫底
const _KIND_ORDER = ['constraint', 'relation', 'lead', 'fact']
const _KIND_HEAD = {
  constraint: '**分析约束（判断时必须考虑）：**',
  relation: '**家庭关系：**',
  lead: '**待核实线索（需向客户确认，勿当作事实）：**',
  fact: '**其他事实：**'
}
const _KIND_SHORT = { constraint: '约束', relation: '关系', lead: '待核实', fact: '其他' }

function _factText(it) {
  return it.value && it.value !== it.label ? `${it.label}：${it.value}` : it.label
}

// 非 compact：分组完整渲染（带来源标注）
function _renderFactGroups(lines, mp) {
  const g = mp.factsByKind || {}
  for (const k of _KIND_ORDER) {
    const items = g[k] || []
    if (!items.length) continue
    lines.push(_KIND_HEAD[k])
    for (const it of items) {
      const src = it.source ? `（${SOURCE_LABEL[it.source] || it.source}）` : ''
      lines.push(`- ${_factText(it)}${src}`)
    }
  }
}

// compact：单行合并（省 token，但非标信息不丢——流式阶段 AI 要用得上约束/线索）
function _renderFactGroupsCompact(lines, mp) {
  const g = mp.factsByKind || {}
  const seg = []
  for (const k of _KIND_ORDER) {
    const items = g[k] || []
    if (!items.length) continue
    seg.push(`${_KIND_SHORT[k]}：` + items.map(_factText).join('；'))
  }
  if (seg.length) lines.push('- ' + seg.join('｜'))
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
    if (mp.debt && mp.debt !== '-') info.push(`- 总负债：${mp.debt}`)
    if (mp.asset && mp.asset !== '-') info.push(`- 持有资产：${mp.asset}`)
    lines.push(...info)

    if (!compact) _renderFactGroups(lines, mp)

    if (compact) {
      const cov = STANDARD_COVERAGE.map(dim => {
        const c = mp.coverage[dim]
        const t = c.status === 'covered' ? '有' : c.status === 'unknown' ? '待确认' : '缺'
        return `${dim}:${t}`
      }).join(' ')
      lines.push(`- 保障覆盖：${cov}`)
      // P0：compact 补保单明细摘要（AI 流式阶段需能回答"家里有什么保单/年缴保费/何时生效"）
      // 截断分档：≤4 完整摘要（含保费/生效日）；>4 只列全部保单名（防隐形保单，token 仍可控）
      if (mp.policies.length) {
        if (mp.policies.length <= 4) {
          const polSum = mp.policies.map(p => {
            const st = STATUS_LABELS[p.status] || '待确认'
            const amt = p.amount ? (typeof p.amount === 'number' ? p.amount + '万' : p.amount) : '待确认'
            const prem = p.premium ? `,保费${p.premium}` : ''
            const eff = p.effectiveDate ? `,生效${p.effectiveDate}` : ''
            return `${p.name || '待确认'}(${p.category || '待确认'},${amt}${prem}${eff},${st})`
          }).join(' ')
          lines.push(`- 已有保障：${polSum}`)
        } else {
          lines.push(`- 已有保障（${mp.policies.length}份）：${mp.policies.map(p => p.name || '待确认').join('、')}`)
        }
      }
      _renderFactGroupsCompact(lines, mp)
      continue
    }

    lines.push('**已有保障：**')
    if (mp.policies.length) {
      lines.push('| 保障 | 险种 | 保额 | 状态 | 来源 | 置信度 | 缴费期 | 备注 |')
      lines.push('|------|------|------|------|------|------|------|------|')
      for (const p of mp.policies) {
        const statusTxt = STATUS_LABELS[p.status] || '待确认'
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
