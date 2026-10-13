/**
 * v2-context — 场景化上下文组装（5 集合并行查询）
 *
 * 接口契约（v2）：
 *   - markdown:    AI 消费的主上下文（场景化裁剪）
 *   - familyMeta:  节流/引用用元数据（不暴露整个 family 记录，避免调用方依赖原始 schema）
 *   - birthMap:    派生数据 memberId → birth_date（保单年龄解析用，仅 report/tool 场景填充）
 *   - datasets:    场景化原始数据集（仅 report 场景暴露 facts/cashValues 给 _buildStructuredCoverage）
 *
 * 不再返回 raw 字段：调用方依赖原始集合记录结构 = 接口泄漏。
 * 派生数据由本模块统一计算，调用方只消费显式契约字段。
 */
const { calcAge } = require('./calc-age')
const { safeQuery, safeQueryAll, getFamily } = require('./db-helpers')
const { buildPortrait, renderPortraitMarkdown } = require('./familyPortrait')
const { yuanToWan } = require('./amount')
// 2026-09-15：画像的覆盖判定改用 policies 集合（与缺口矩阵同源，见 familyPortrait.buildPortrait）
const { loadActivePolicies } = require('./policy-read')

// 保单读取包装（2026-09-15）：上下文构建以可用性优先（不因保单读取失败中断对话/报告），
// 但**必须留痕**并回退旧路径。不要写成 `.catch(() => [])`——空数组会被 buildPortrait 判成
// "该家庭确实无保单"，全维度误报"无保障"；这正是 policy-read.js 注释里记载的事故模式。
function _loadPoliciesOrNull(db, familyId, openid) {
  return loadActivePolicies(db, familyId, openid).catch(e => {
    console.error('[v2-context] 保单读取失败，画像回退 facts 派生（覆盖判定可能不准）:', (e && e.message) || e)
    return null
  })
}

function _memberTable(members) {
  if (!members || members.length === 0) return ''
  // 先算所有人年龄，找本人作为推断基准
  const enriched = members.filter(m => m.status !== 'deleted').map(m => ({
    m, age: calcAge(m.birth_date) || 0
  }))
  const self = enriched.find(e => (e.m.role || '') === '本人')
  const selfAge = self ? self.age : 0
  // role 归一化：本人→经济支柱；家庭成员按与本人年龄差推断
  function _normRole(role, age) {
    if (role === '本人') return '经济支柱'
    if (['配偶', '子女', '父母', '经济支柱'].indexOf(role) !== -1) return role
    if (role === '家庭成员' && selfAge > 0) {
      const diff = age - selfAge
      if (diff >= 20) return '父母'
      if (diff <= -15) return '子女'
      if (Math.abs(diff) <= 15) return '配偶'
      return '其他'
    }
    return role || '其他'
  }
  const rows = ['| memberId | 姓名 | 角色 | 年龄 | 性别 | 健康 | 职业 | 个人年收入 |', '|----------|------|------|------|------|------|------|----------|']
  for (const e of enriched) {
    const m = e.m, age = e.age || '-'
    const role = _normRole(m.role || '-', e.age)
    const inc = m.income ? m.income + '万' : (m.income === 0 ? '0（待补全）' : '待补全')
    rows.push('|' + [m.member_id || m._id, m.name || '-', role, age, m.gender || '-', m.health || '-', m.occupation || '-', inc].join('|') + '|')
  }
  return rows.join('\n')
}

function _financeTable(finances, snap) {
  let income = '-', debt = '-', debtType = '-'
  if (finances && finances.length > 0) {
    const f = finances[0]
    // 数值审计 #2：finances 统一存元（annual_income/total_debt），此处 ÷10000 转万显示；
    // 兼容旧数据（income/debt 万键直读）
    income = f.annual_income != null ? _wan(f.annual_income) : (f.income != null ? f.income : income)
    debt = f.total_debt != null ? _wan(f.total_debt) : (f.debt != null ? f.debt : debt)
    debtType = f.debt_type || debtType
  }
  // 2026-09-10 P1-3 口径统一：写侧唯一真相源为 finances 集合（元口径，见 reportAI/report-context._financeSnap 注释），
  // 原实现让 financial_snapshot 覆盖 finances，而同一份 prompt 内的保单汇总/缺口矩阵按 finances 取数
  // → 同上下文出现两个收入数（AI 被要求"直接引用结论禁止重算"，引用哪个取决于读到哪段）。
  // 现改为 finances 优先，snapshot 仅补齐 finances 缺失的字段（历史家庭残留数据兜底）。
  if (snap) {
    if (income === '-' && snap.income) income = snap.income
    if (snap.debt) {
      const d = typeof snap.debt === 'object' ? snap.debt : { amount: snap.debt }
      if (debt === '-' && d.amount != null) debt = d.amount
      if (debtType === '-' && d.type) debtType = d.type
    }
  }
  if (income === '-' && debt === '-' && debtType === '-') return ''
  const rows = ['| 年收入(万) | 总负债(万) | 负债类型 |', '|--------|--------|----------|']
  rows.push('|' + [income, debt, debtType].join('|') + '|')
  return rows.join('\n')
}

/** 元 → 万（数值审计 #1/#2 共用，round 到 2 位防浮点噪音；换算核心走金额契约 amount.js） */
function _wan(v) {
  const n = Number(v)
  return isNaN(n) ? '-' : yuanToWan(n)
}

/**
 * 派生 familyMeta — 仅暴露节流/引用/财务快照字段，不泄露整个 family 记录
 */
function _deriveFamilyMeta(family) {
  if (!family) return null
  return {
    family_id: family._id,
    family_name: family.family_name || '',
    last_analysis_at: family.last_analysis_at || null,
    // 2026-09-22（数据质量批次 3）：透出脏标记。writeSeam 每次写入都会置 insight_stale=true，
    // 而 report-context 的"上一版参考"段需要它才能告诉模型"上一版之后数据又变了"。
    // 原先只在写侧使用，上下文看不到 → prompt 里"若与上一版矛盾则说明变化"这条无从执行。
    insight_stale: !!family.insight_stale,
    last_summary: family.last_summary || '',
    last_conclusion: family.last_conclusion || '',
    financial_snapshot: family.financial_snapshot || null,
    engagement_stage: family.engagement_stage || '',
    // 长期记忆版本号（2026-08-30）：families.updated_at 由 writeSeam 统一维护，
    // 外部入口更新数据时自然变化 → 基础摘要据此条件重建（对话内写操作不 touch 该字段触发重建）
    updated_at: family.updated_at || null,
    // 压缩游标（2026-08-30）：历史注入起点——压缩后只读该时间点之后的消息
    ctx_compacted_at: family.ctx_compacted_at || null
  }
}

/**
 * 派生 birthMap — memberId → birth_date，供保单年龄解析用
 */
function _deriveBirthMap(members) {
  const map = new Map()
  for (const m of (members || [])) {
    if (m.birth_date) map.set(m.member_id || m._id, m.birth_date)
  }
  return map
}

/**
 * @param {object} db - cloud.database()
 * @param {string} familyId
 * @param {string} openid
 * @param {string} scene - list | conversation | analysis | report | tool
 * @returns {{
 *   markdown: string,
 *   familyMeta: object|null,
 *   birthMap: Map<string, string>,
 *   datasets: { facts?: array, cashValues?: array, members?: array, finances?: array }
 * }}
 */
/**
 * safeQueryAll 的"完整数据"包装（2026-09-28 复审，dsh 审计项⑤）
 *
 * 原写法 `.then(r => r.data || [])` 把 `truncated` / `failedPages` 直接丢掉 —— 分页查询失败
 * （某页报错被 catch 成空页）或超页上限时，上层仍把结果当作完整数据喂 AI。
 * 这里把"不完整"记进 dq.sources，供调用方 ① 在上下文里声明 ② 落日志 metrics。
 * 只用于 report 场景（该场景的产物是给客户看的结论，最不能把"读到的部分"说成完整）。
 */
function _queryAll(db, coll, where, openid, label, dq) {
  return safeQueryAll(db, coll, where, openid).then(r => {
    if (r && (r.truncated || (r.failedPages && r.failedPages.length))) dq.sources.push(label)
    return (r && r.data) || []
  })
}

async function buildFamilyContext(db, familyId, openid, scene) {
  // 基础层：所有场景加载
  const [family, members, finances] = await Promise.all([
    getFamily(db, familyId, openid).then(f => f || {}),
    safeQuery(db, 'members', { family_id: familyId }, openid).then(r => r.data || []),
    safeQuery(db, 'finances', { family_id: familyId }, openid).then(r => r.data || [])
  ])
  const familyMeta = _deriveFamilyMeta(family)
  const birthMap = _deriveBirthMap(members)
  // datasets 按场景填充：默认空，仅场景需要时暴露原始数据集
  const datasets = {}
  // 数据完整性收集器（2026-09-28）：见 report 场景 `_queryAll` 处注释
  const dataQuality = { sources: [] }

  if (scene === 'list') {
    // 首页：仅展示成员名+角色
    return {
      markdown: _memberTable(members.map(m => ({ _id: m._id, member_id: m.member_id, name: m.name, role: m.role }))),
      familyMeta,
      birthMap,
      datasets
    }
  }

  const parts = []
  parts.push('# 家庭保障档案')
  // last_conclusion 注入：conversation/tool 场景用带标签结论块（见各场景分支）；
  // report 场景由 buildReportContext 的「## 上一版报告结论（参考，禁止照抄）」承载，此处不再注入裸 quote
  // （2026-09-10 上下文审计 P1：同一份结论进上下文两次，且裸 quote 无"上一版"标识，模型易误当当前结论）
  if (scene !== 'conversation' && scene !== 'tool' && scene !== 'report' && family.last_conclusion) parts.push('> ' + family.last_conclusion + '\n')

  // 经济状况表始终注入（家庭级年收入/负债，画像不覆盖）
  const ft = _financeTable(finances, family.financial_snapshot)
  if (ft) parts.push('## 经济状况\n' + ft)

  if (scene === 'conversation') {
    // Phase 2：读统一画像（精简版）；画像已聚合全部 active facts，无需重复回流原始三元组
    const [facts, activePolicies] = await Promise.all([
      safeQueryAll(db, 'facts', { family_id: familyId, status: 'active' }, openid).then(r => r.data || []),
      _loadPoliciesOrNull(db, familyId, openid)
    ])
    const portrait = buildPortrait(members, facts, { policies: activePolicies })
    const pm = renderPortraitMarkdown(portrait, { compact: true })
    if (pm) parts.push(pm)
    // 采集钩子原料（2026-09-02）：compact 画像会省略 '-' 字段，模型难区分"缺失"与"省略"，
    // 显式注入待补全清单——prompt【结尾引导】的"信息采集"分支据此选择采集目标
    const missing = _missingInfo(portrait, finances, family.financial_snapshot)
    if (missing.length) parts.push('## 待补全信息（仅提示可补充项，未采集不得暗示已采集）\n' + missing.map(x => '- ' + x).join('\n'))
    // 报告结论带标签注入（审计改法 3）：A 通道据此回答缺口类问题（"上次检视"标注防 stale 误导）
    if (family.last_conclusion) parts.push('## 报告结论（上次检视，回答缺口类问题可引用）\n' + family.last_conclusion)
    return { markdown: parts.join('\n\n'), familyMeta, birthMap, datasets }
  }

  if (scene === 'report') {
    // Phase 2：统一画像取代「保单列表 + 全部事实」两张表
    // 成员表已由画像覆盖（画像已合并 members 表字段，B3 以 facts 为准），不再单独渲染原始成员表
    const [facts, cashValues, activePolicies] = await Promise.all([
      _queryAll(db, 'facts', { family_id: familyId, status: 'active' }, openid, 'facts', dataQuality),
      _queryAll(db, 'policy_cash_values', { family_id: familyId, matched: true }, openid, 'cashValues', dataQuality),
      _loadPoliciesOrNull(db, familyId, openid)
    ])
    // 2026-09-28 复审（dsh 审计项⑤）：`safeQueryAll` 的 truncated/failedPages 此前**无人消费**
    // （悬空契约：分页失败/超页时上层仍把结果当"完整数据"喂 AI，报告会基于缺失数据下结论且不留痕）。
    // 现两处消费：① 上下文里显式声明，禁止把"读到的部分"说成完整；② datasets 暴露给 reportAI 落 metrics。
    datasets.dataQuality = dataQuality
    if (dataQuality.sources.length) {
      parts.push('## ⚠️ 数据完整性（系统检测，非用户输入）\n分页读取以下数据时失败或超出页上限，内容可能不完整：' +
        dataQuality.sources.join('、') + '。凡涉及总数/总额/成员数的结论，必须限定为"以现有数据为限"。')
    }
    // report 场景业务逻辑（_buildStructuredCoverage）需要 facts/cashValues 原始数据集
    datasets.facts = facts
    datasets.cashValues = cashValues
    // prompt 工程审计：缺口矩阵需识别"无保单成员"，暴露 members
    datasets.members = members
    // readiness 门禁（2026-08）：暴露 finances 原始文档（对齐 tool 场景），供深度分析前置检查判"有无"（financial_snapshot 不在 families 集合，唯一真相源在 finances）
    datasets.finances = finances
    const portrait = buildPortrait(members, facts, { policies: activePolicies })
    const pm = renderPortraitMarkdown(portrait, { compact: false })
    if (pm) parts.push(pm)
    if (cashValues && cashValues.length > 0) {
      // 2026-09-10 精简（上下文审计 P2）：原实现逐产品附带现金价值表前 5 行明细，而「结构化保单清单」
      // 已含「现价」「回本」两列（按已缴年取当前值）→ 报告写作不需要逐年明细。此处只保留满期现价一行，
      // 省 token 并避免与清单里"当前现价"两处口径混淆（一个满期、一个当前）。
      parts.push('## 保单现价数据（满期值；当前现价见结构化保单清单）\n')
      for (const cv of cashValues) {
        const latest = cv.cash_values && cv.cash_values[cv.cash_values.length - 1]
        parts.push(`- ${cv.product_name || '未知产品'}（${cv.insured_name || '-'}）：第${cv.total_years || 0}年现价 ${latest?.v || 0}元`)
      }
    }
    return { markdown: parts.join('\n\n'), familyMeta, birthMap, datasets }
  }

  if (scene === 'tool') {
    // conversationAI 工具上下文专用：画像 + 原始成员表（冲突检测用）+ 财务表 + 报告结论摘要
    // 复用 v2-context 内部已查询的 members/finances，避免 conversationAI 重复查询
    const [facts, activePolicies] = await Promise.all([
      safeQueryAll(db, 'facts', { family_id: familyId, status: 'active' }, openid).then(r => r.data || []),
      _loadPoliciesOrNull(db, familyId, openid)
    ])
    const portrait = buildPortrait(members, facts, { policies: activePolicies })
    const pm = renderPortraitMarkdown(portrait, { compact: true })
    if (pm) parts.push(pm)
    // 工具上下文需要"未合并的成员表"用于冲突检测（与画像视图互补）
    const activeMembers = (members || []).filter(m => m.status !== 'deleted')
    const mt = _memberTable(activeMembers)
    if (mt) parts.push('## 成员数据（冲突检测用）\n' + mt)
    // 报告结论摘要（供 AI 引用，禁止照抄）
    if (familyMeta) {
      const sumParts = []
      if (familyMeta.last_summary) sumParts.push('**摘要**：' + familyMeta.last_summary)
      if (familyMeta.last_conclusion) sumParts.push('**结论**：' + familyMeta.last_conclusion)
      if (sumParts.length > 0) parts.push('## 报告结论（供引用，禁止照抄）\n' + sumParts.join('\n'))
    }
    // 暴露 members/finances 给 conversationAI 复用（避免重复查询）
    datasets.members = activeMembers
    datasets.finances = finances
    return { markdown: parts.join('\n\n'), familyMeta, birthMap, datasets }
  }

  // 默认（analysis 等未明确场景）：仅基础 markdown
  return { markdown: parts.join('\n\n'), familyMeta, birthMap, datasets }
}

/**
 * 待补全清单 — 采集钩子原料（2026-09-02）
 * compact 画像会省略 '-' 字段，模型易把"未列出"当"已省略"；此处基于 portrait
 * （已合并 facts+成员表）与 finances/financial_snapshot 显式枚举缺失项，供【结尾引导】采集。
 */
function _missingInfo(portrait, finances, snap) {
  const out = []
  const fin = (finances && finances[0]) || {}
  const fsnap = snap || {}
  for (const mp of (portrait && portrait.members) || []) {
    const name = mp.name || '未命名成员'
    if (!mp.age) out.push(name + '缺出生日期（无法精确判断年龄阶段）')
    const occ = String(mp.occupation || '')
    if (!occ || occ === '-') out.push(name + '缺职业')
    const health = String(mp.health || '')
    if (!health || health === '-') out.push(name + '缺健康信息（既往症/体检异常）')
    const inc = String(mp.income || '')
    if (inc.indexOf('待补全') !== -1 || inc === '0') out.push(name + '缺个人年收入')
  }
  const hasIncome = fin.annual_income != null || fin.income != null || fsnap.income != null
  if (!hasIncome) out.push('家庭年收入未填写')
  const hasDebt = fin.total_debt != null || fin.debt != null || (fsnap.debt && fsnap.debt.amount != null)
  if (!hasDebt) out.push('家庭总负债未填写')
  return out
}

module.exports = { buildFamilyContext }
