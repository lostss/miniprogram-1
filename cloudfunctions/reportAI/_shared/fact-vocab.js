/**
 * fact-vocab — 事实词表单一事实源（2026-09-14 事实体系重构）
 *
 * 【为什么谓词不再当字典】
 * 谓词是开放集合（业务有多少种说法就有多少种），必然泛化不了非标输入。
 * 真正需要闭合的只有一件事——代码要对事实做确定性判断，而其只有两种形态：
 *   1. 同属性冲突消解（"年薪30万" 与 "个人年收入35万" 指向同一个属性槽）
 *   2. 数值计算 / 字段定位（收入、职业、健康要落到 members 表与画像字段）
 * 因此本模块提供两个"闭合"维度：
 *   - kind ：事实的语义类别（4 值，稳定不增）→ 决定"这条信息怎么被消费"
 *   - axis ：归一化属性槽（可选）            → 决定"是否参与确定性计算/消解"
 *
 * 【字典降级：准入闸门 → 归一化建议器】
 * axis 未命中 ≠ 丢弃。predicate 照常保留 AI 原话落库，只是 axis 为空：
 * 该事实不进确定性计算，但仍按 kind 进入 AI 上下文（见 familyPortrait 分组渲染）。
 * 这是与旧 `FACT_STRATEGIES`（66 谓词准入表，未命中兜底"备注/有特征"）的根本区别：
 * 旧模式下未命中的语义被压平进"备注"垃圾桶，消费侧白名单再筛一次 → 等于没采。
 */

// ============ kind：事实的语义类别（闭合 4 值）============
const KIND = { FACT: 'fact', CONSTRAINT: 'constraint', RELATION: 'relation', LEAD: 'lead' }
const KINDS = ['fact', 'constraint', 'relation', 'lead']
const KIND_LABEL = {
  fact: '已确认事实',
  constraint: '分析约束',
  relation: '实体关系',
  lead: '待核实线索'
}

// ============ 保障维度（覆盖矩阵用，闭合 8 值）============
// 2026-09-22 修（数据盘点批次 1）：'年金险' → '年金'。
// 本表是**画像覆盖矩阵**的维度集合，而全仓的规范词是 '年金'（thresholds.js 的 THRESHOLDS 键与
// CANON_CAT 都用 '年金'）→ 原写法让「年金」类保单永远匹配不上，画像里该维度恒为 missing，
// 而缺口矩阵经 canonCat 归一后正常 → 同一份 AI 上下文对同一张保单给出相反结论。
// 不变量：本表每一项都必须满足 canonCat(x) === x（已由 tests/thresholds.test.js 钉住）。
const STANDARD_COVERAGE = ['寿险', '医疗险', '重疾险', '意外险', '年金', '教育金', '防癌险', '护理险']

// ============ 保单节点属性（封闭集）============
// 由 policyToFacts 写入（subject_type='policy'），familyPortrait 按此渲染保单表。
// 注意：这些是「保单实体的字段」，不是成员事实的属性槽 → 不进 AXIS_DEFS。
// 2026-09-18 加入「受益人」：报告页审计发现 AI 会建议"保单指定受益人做资产隔离"，但报告与 AI 上下文
// 都没有受益人现状 → 建议与事实脱节、代理人无从核对。policyToFacts 的 lit() 对空值有守卫，
// 故无受益人字段的保单不会产生该事实。仍属保单节点属性集（isPolicyAttr→true），
// 故 queryFacts 的默认排除策略一致，不会给成员事实视图添噪。
const POLICY_ATTRS = ['险种', '保额', '年缴保费', '生效日', '保障期间', '缴费期', '缴费方式', '特殊条款', '承保公司', '保单号', '受益人', '免赔额', '等待期']

// ============ axis：归一化属性槽 ============
// strategy：versioned=新值覆盖旧值（属性/状态/数值类）；dedup=同值不重复（关系/事件/多值类）
// syns：同义词 → 归一化到该槽（"年薪" 与 "个人年收入" 是同一个槽）
const AXIS_DEFS = [
  // —— 成员属性 ——
  // 2026-09-28 推翻既有口径：**移出 `月薪`**（原 syns 含它，见 docs/data-model-v2.md 同义词表的旧版本）。
  // 依据：槽 `个人年收入` 通过 AXIS_MEMBER_FIELD 直落 `members.income`（单位**万/年**）并被
  // gap-core 当作 5×年收入缺口的基数，而"月薪2万"承载的是**月度**语义 —— 归一进去 = 少报约 12×，
  // 且错在确定性计算上（不是文案）。不自动 ×12 换算：objectValue 是自由文本（"2万"/"2w"/"20000"），
  // 猜单位会错得更大。移出后 axis 留空 → 事实仍按 kind 进画像/上下文（原话保留、代理人可见），
  // 只是不再参与同槽冲突消解与年收入计算。
  { axis: '个人年收入', strategy: 'versioned', syns: ['收入', '年收入', '年薪', '收入水平', '税前收入', '税后收入'] },
  { axis: '职业', strategy: 'versioned', syns: ['职业状态', '岗位', '工作', '从事职业', '公司类型', '单位性质', '是否企业主', '企业类型'] },
  { axis: '健康异常', strategy: 'versioned', syns: ['健康', '病史', '病史记录', '病史时间线', '患病', '疾病', '健康问题', '身体状况', 'BMI指数', '吸烟习惯', '饮酒习惯'] },
  { axis: '年龄', strategy: 'versioned', syns: ['出生日期', '出生年月'] },
  { axis: '性别', strategy: 'versioned', syns: [] },
  { axis: '教育程度', strategy: 'versioned', syns: ['学历', '教育背景'] },
  { axis: '婚姻状态', strategy: 'versioned', syns: ['婚姻', '婚史', '婚姻状况', '婚姻财产制'] },
  { axis: '有偏好', strategy: 'versioned', syns: ['偏好', '投保偏好', '偏好保险公司', '缴费偏好', '风险偏好'] },
  // —— 家庭财务 ——
  { axis: '总负债', strategy: 'versioned', syns: ['负债', '负债总额', '贷款总额'] },
  { axis: '房贷余额', strategy: 'versioned', syns: ['房贷', '贷款余额', '按揭余额'] },
  { axis: '负债期限', strategy: 'versioned', syns: ['贷款期限', '还款期限'] },
  { axis: '持有资产', strategy: 'versioned', syns: ['资产', '家庭资产', '资产总额'] },
  { axis: '房产价值', strategy: 'versioned', syns: ['房产', '房子', '不动产'] },
  { axis: '金融资产', strategy: 'versioned', syns: ['存款', '理财'] },
  { axis: '收入来源', strategy: 'versioned', syns: [] },
  { axis: '抚养赡养人数', strategy: 'versioned', syns: ['赡养人数', '抚养人数'] },
  { axis: '社保情况', strategy: 'versioned', syns: ['社会保险', '五险一金'] },
  { axis: '年保费预算', strategy: 'versioned', syns: ['保费预算', '预算'] },
  { axis: '企业经营权', strategy: 'dedup', syns: [] },
  { axis: '资产持有比例', strategy: 'versioned', syns: ['持股比例', '持有比例'] },
  { axis: '婚前财产', strategy: 'dedup', syns: [] },
  // —— 目标与规划 ——
  { axis: '未来计划', strategy: 'versioned', syns: ['计划', '打算'] },
  { axis: '教育规划', strategy: 'versioned', syns: [] },
  { axis: '退休规划', strategy: 'versioned', syns: [] },
  { axis: '退休预期年龄', strategy: 'versioned', syns: ['退休年龄'] },
  { axis: '传承意图', strategy: 'versioned', syns: ['传承'] },
  { axis: '资产隔离需求', strategy: 'versioned', syns: ['资产隔离'] },
  { axis: '婚嫁规划', strategy: 'versioned', syns: [] },
  { axis: '教育支出预期', strategy: 'versioned', syns: [] },
  { axis: '赡养支出预期', strategy: 'versioned', syns: [] },
  { axis: '子女教育节点', strategy: 'versioned', syns: [] },
  { axis: '婚嫁预期时点', strategy: 'versioned', syns: [] },
  { axis: '贷款到期日', strategy: 'versioned', syns: [] }
]

const AXES = AXIS_DEFS.map(d => d.axis)
const AXIS_SET = new Set(AXES)

// 谓词/同义词 → axis（含 axis 自身）
const SYN_TO_AXIS = (() => {
  const m = {}
  for (const d of AXIS_DEFS) {
    m[d.axis] = d.axis
    for (const s of d.syns || []) m[s] = d.axis
  }
  return m
})()

// axis → 写策略
const AXIS_STRATEGY = (() => {
  const m = {}
  for (const d of AXIS_DEFS) m[d.axis] = d.strategy
  return m
})()

// ============ 关系类谓词（kind=relation 兜底推断）============
const RELATION_PREDICATES = ['配偶', '子女', '父母', '投保', '被保', '监护人']

// ============ 成员字段映射（fact → members 反向同步）============
// 按 axis 判定（predicate 已自由化，不能再靠字面量匹配）
const AXIS_MEMBER_FIELD = { '个人年收入': 'income', '职业': 'occupation', '健康异常': 'health', '年龄': 'age', '性别': 'gender' }

// ============ 派生函数 ============

/** 谓词（或同义词）→ 归一化属性槽；未命中返回 '' */
function axisOf(predicate) {
  if (!predicate) return ''
  return SYN_TO_AXIS[predicate] || ''
}

/**
 * 写策略：versioned（新值覆盖旧值）/ dedup（同值跳过）
 * 判定优先级：axis 槽策略 > 保单节点属性（字段语义即"当前值"→ versioned）> 默认 dedup
 */
function strategyOf(predicate, axis) {
  const ax = axis || axisOf(predicate)
  if (ax) return AXIS_STRATEGY[ax] || 'dedup'
  if (isPolicyAttr(predicate)) return 'versioned'
  return 'dedup'
}

/** kind 兜底推断：显式传入优先，其次按谓词类型（关系类 → relation），默认 fact */
function kindOf(predicate, kind) {
  if (kind && KINDS.indexOf(kind) !== -1) return kind
  if (RELATION_PREDICATES.indexOf(predicate) !== -1) return KIND.RELATION
  return KIND.FACT
}

/** 是否保单节点属性（policyToFacts 写入的封闭集） */
function isPolicyAttr(predicate) {
  return POLICY_ATTRS.indexOf(predicate) !== -1
}

module.exports = {
  KIND, KINDS, KIND_LABEL,
  STANDARD_COVERAGE,
  POLICY_ATTRS,
  AXIS_DEFS, AXES, AXIS_SET, AXIS_MEMBER_FIELD, RELATION_PREDICATES,
  axisOf, strategyOf, kindOf, isPolicyAttr
}
