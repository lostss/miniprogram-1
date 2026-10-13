# 保小秘 v2 数据模型

> 核心原则：**基础层 + 推理层，不重复，只叠加**。

> **索引与集合以本节实测为准（2026-09-12 cloud1 环境）**：下方各节「索引」行是早期设计目标，多数未落地；云端实际索引见下表，环境重建时按此补建。
>
> | 集合 | 实测索引（键 — 命中情况） |
> |------|--------------------------|
> | families | `_openid_1`、`_id_`、`idx_openid_updated`(_openid+updated_at desc，高频)、`has_portrait_index`(_openid+has_portrait，0 命中)、`agent_id_updated`(与前者同键，冗余)、`"1"`(openid+_openid+createdAt，0 命中，可删) |
> | members | `_openid_1`(高频)、`_id_`、`idx_fid_openid`(family_id+_openid) |
> | policies | `_openid_1`(高频)、`_id_`、`idx_fid_openid`(family_id+_openid) |
> | facts | `_openid_1`、`_id_`、`idx_fid_status`(family_id+status，高频)、`idx_family_created`(family_id+created_at desc) |
> | finances | 仅默认 `_id_` / `_openid_1` — 缺 `family_id`：本文件下文声称的「唯一索引 family_id」未落地，而 `upsertFinances` / `getFinance` 按 `family_id` 查询，数据量上升后会全表扫 |
> | operation_logs | `_id_`、`idx_created_at_desc`、`idx_family_created`、`_openid_1`(0 命中) |
> | undo_logs | 仅默认 `_id_` / `_openid_1` — cleanup 的 TTL 走 `expires_at`、级联删除走 `family_id`，两者均无索引（当前 2 条，暂无影响） |
>
> 业务在用集合：`families` / `members` / `finances` / `policies` / `facts`，辅助：`policy_cash_values` / `messages` / `reports` / `agents`。`products` 有 8 条数据但全仓无 `db.collection('products')` 调用（无消费端）；`insights` 已废弃（0 文档）。另有非业务残留：`auth_tokens` / `ocr_debug_logs` / `sys_department(-preview)` / `sys_user(-preview)` / `relation_data_depart(-preview)`。
>
> 索引声明未纳入 `cloudbaserc.json`（无 IaC），重建环境需手工补建。

---

## 一、架构

```
┌──────────────────────────────────────────────────────────┐
│                 AI 推理上下文                              │
│  base（必然加载）+ facts（按场景追加）                      │
└────────────┬─────────────────────────────┬───────────────┘
             │                             │
┌────────────▼───────────┐  ┌──────────────▼──────────────┐
│   基础层（结构化）        │  │   推理层（三元组）            │
│   覆盖更新 · 精确查询    │  │   追加更新 · 关系查询         │
│                         │  │                              │
│  members     finances   │  │  facts                       │
│  policies               │  │  配偶/子女/购买/缺少/建议...  │
└─────────────────────────┘  └─────────────────────────────┘
```

---

## 二、集合设计

### 1. families — 家庭容器

仅存不可变标识和状态。极少变更。

```javascript
{
  _id: 'fam_xxx',
  _openid: 'wx_openid_xxx',
  name: '李阳勇家庭',
  status: 'active',          // active | archived
  created_at: Date,
  updated_at: Date
}
```

**索引**：`_openid + status`、`name`

---

### 2. members — 成员主数据

**既是展示属性，也是 AI 推理基础输入。**

```javascript
{
  _id: 'mem_xxx',
  family_id: 'fam_xxx',
  member_id: 'mem_xxx',     // join key，policies.member_id / facts.subject_id 引用

  // === 核心标识 ===
  name: '李阳勇',           // 必填，2-20 字符
  birth_date: '1982-06-15', // YYYY-MM-DD，计算年龄（可选）
  age: 43,                  // 由 birth_date 推导的冗余存储，便于展示
  role: '本人',             // 本人 | 配偶 | 子女 | 父母
  gender: '男',             // 男 | 女 | 未知

  // === 展示 + 推理共用 ===
  income: 30,               // 个人年收入（万元），对话「个人年收入」fact 同步写入
  occupation: '工程师',     // 职业（核保输入 + 报告展示）
  health: '体健',           // 健康状况（核保输入 + 报告展示）

  // === 状态 ===
  status: 'active',         // active | deleted（软删除）

  // === 系统 ===
  created_at: Date,
  updated_at: Date
}
```

**唯一性约束**：`member_id` 为主键，`name + role` 在云函数层做 UX 拦挡（同名同角色时弹提示），非数据库级约束。`birth_date` 可选，不作为唯一性判断条件。

**为何 occupation/health 留在 members 而非 facts**：
- 报告第 2 章直接展示，不应强制 join
- 核保推理关键输入，AI 上下文必然需要
- 是"这个人是谁"的属性，不是"这个人和什么有关"的关系

**删除规则**：软删除（`status: 'deleted'`），关联的 `policies.member_id` 保留原值不清空，关联的 `facts` 标记 `status: 'superseded'`。

> **2026-09-22 补记（这条规则曾被违反、后回退——记下证据以免再犯）**
> `member_id` 保留不是"没清理干净"，而是**有意保留的 join key**：它本身是一个索引（见 policies 小节），
> 并支撑 §6.2 的 `where({ member_id, status })` 查询范式。
> 曾有一版实现（2026-09-20）在删除成员时把 `policies.member_id` 置空，理由是"消除悬挂、让报告口径一致"。
> 复核发现它对报告**实际是 no-op**：三个消费点（`utils/report/gap-engine`、`utils/report/data-normalizer`、
> `utils/gap-core`）构建的 `memberIdToName` **只由在册成员构成**，已删成员的 id 本来就查不到、
> 一直走 `insured_name` 兜底 —— 清空前后代码路径完全相同；唯一真实变化是「保障人数」的去重 key
> 从 id 变成姓名，**个数不变**。该实现已于 2026-09-22 回退，并由 `tests/updateFamily.test.js` 与
> `tests/crud-gaps.test.js` 各一条断言钉住本规则。
>
> **遗留口径分歧（未决，需产品定夺）**：已删成员的保单会**计入**「保障人数」（`report-builder` 按
> `p.member_id || p.insured_name` 去重）却**没有**缺口矩阵行（矩阵按 `members` 行渲染）——
> 这是消费侧口径问题，改数据修不掉。

**索引**：`family_id + status`、`name`

---

### 3. finances — 财务主数据

家庭级财务快照，保额计算公式的输入。

```javascript
{
  _id: 'fin_xxx',
  family_id: 'fam_xxx',     // 唯一索引

  annual_income: 300000,    // 年收入（元）
  total_debt: 150000,       // 总负债（元）
  debt_type: '房贷',        // 自由文本

  updated_at: Date
}
```

**唯一索引**：`family_id`

---

### 4. policies — 保单事实表

保障分析的硬数据来源。高频追加 + 状态变更。

```javascript
{
  _id: 'pol_xxx',
  family_id: 'fam_xxx',
  member_id: 'mem_xxx',     // 被保人

  // === 核心保障 ===
  product_name: '阳光人寿i保定期寿险',
  insurance_category: '寿险',         // 重疾险 | 医疗险 | 意外险 | 寿险 | 年金 | 其他
  sum_assured: 1000000,     // 保额（元）
  annual_premium: 2230,     // 年缴保费（元）

  // === 日期与状态 ===
  effective_date: '2020-06-01',
  expiry_date: '2050-06-01',
  status: 'active',         // active | expired | pending | cancelled

  // === OCR 元数据 ===
  confidence: 0.95,
  need_review: false,

  // === 扩展 ===
  policy_number: 'P20200601001',
  insurer: '阳光人寿',
  policyholder: '李阳勇',

  created_at: Date,
  updated_at: Date
}
```

**保额口径（2026-09-22 产品决策：医疗险报销限额也算保额）**：`sum_assured` 存的是**保单载明的"保险金额"**；医疗险填的是其**各项医疗费用保险金的年限额之和** —— 这不是我们换算出来的口径，条款原文即如此定义（见 `tests/fixtures/policy-clauses/康健华贵B款医疗保险.txt` 第四条：「本合同的保险金额为投保时约定的保障计划类别对应的各项医疗费用保险金**年限额之和**，约定的保险金额将在保险单上载明」）。

因此：**报销限额计入保额，不按「报销型 / 给付型」拆分**。三条理由 —— ① 条款与保单自身就称其为"保险金额"，另立口径会让入库值与客户纸面凭据不一致 ② 报告要回答的是"这张保单一共能兜住多少钱"，年限额正是这个数 ③ 真正需要提醒读者的**不是**"限额不算保障"，而是**期限**：一年期短险每年需续保（该提醒由 `isOneYearPolicy` 短险单列承担，见 `reportPdf._shortNote` 与 `report-context` 的总保额行）。

**索引**：`family_id + status`、`member_id + status`、`status + expiry_date`、`category`

---

### 5. facts — 三元组关系表（精简版）

**仅存关系和推理结论，不存结构化数据副本。5 条产线统一经 `addFact` 单入口写入。**

```javascript
{
  _id: 'fact_xxx',
  family_id: 'fam_xxx',

  // === 三元组 ===
  subject_type: 'member',   // member | family | policy
  subject_id: 'mem_xxx',
  subject_name: '李阳勇',   // 冗余，便于展示

  predicate: '公司团险在职有效',  // 开放文本：AI 原话，不再受词表限制（2026-09-14）

  // === 语义标注（2026-09-14 事实体系重构）===
  kind: 'constraint',       // fact | constraint | relation | lead —— 决定"这条信息怎么被消费"
  axis: '',                 // 归一化属性槽（可空）—— 命中则参与冲突消解与确定性计算

  object_type: 'member',    // member | policy | literal
  object_id: 'mem_yyy',     // literal 时为空
  object_value: '离职即失效',     // 字面值或冗余名称
  object_value_type: 'string', // string | number | boolean

  // === 元数据 ===
  confidence: 0.9,          // 仅展示和审计，不纳入推理权重
  source: 'ai',             // ocr | ai | user_form | agent_confirmed | agent_edit
  status: 'active',         // active | superseded（零物理删除）

  // === 推理追溯 ===
  reasoning: '从对话中提取', // 可选
  rule_id: 'rule_xxx',      // 可选

  created_at: Date
}
```

**写入策略**：谓词开放（`predicate` 保留 AI 原话），写策略由 `_shared/fact-vocab.js` 的 **axis 属性槽**派生——
属性/状态/数值类槽 → `versioned`（同槽新值覆盖旧值）；关系/多值类与未命中槽 → `dedup`；保单节点属性 → `versioned`。
agent_confirmed 源受保护不被低置信源覆盖。

> **2026-09-14 重构**：原 `FACT_STRATEGIES`（66 谓词准入表，未命中谓词兜底「备注/有特征」）已删除。
> 旧模式缺陷：谓词不在表中 → 语义被压平进「备注」垃圾桶 → 消费侧（`buildPortrait` 白名单）再筛一次 = **等于没采**
> ——实测 66 谓词中约 45 个写入后不参与任何消费。现在"闭合"的只有两处：
> `kind`（4 值，决定消费方式）与 `axis`（属性槽，决定是否参与计算）；谓词未命中 axis **不丢信息**，
> 只是不参与确定性计算，仍按 kind 进入 AI 上下文（见 `familyPortrait.buildPortrait` 的 `factsByKind`）。

---

## 三、axis 属性槽表（归一化字典）

> 2026-09-14 重构：谓词已**开放**（`predicate` 存 AI 原话）。本表不再是"准入词表"，而是**归一化目标**——
> AI 写"年薪"时归一化到槽 `个人年收入`（落 `axis` 字段），用于同槽冲突消解与确定性计算。
> **未命中槽不丢信息**：`axis` 留空，事实仍按 `kind` 进入 AI 上下文。
> 单一事实源：`cloudfunctions/_shared/fact-vocab.js`。

### 成员属性（versioned：同槽新值覆盖旧值）

| axis 槽 | 常见同义说法（自动归一） |
|---------|------------------------|
| `个人年收入` | 收入 / 年薪 / 年收入水平 |
| `职业` | 职业状态 / 岗位 / 公司类型 / 是否企业主 / 企业类型 |
| `健康异常` | 健康 / 病史 / 病史时间线 / 患病 / BMI指数 / 吸烟习惯 / 饮酒习惯 |
| `年龄` / `性别` / `教育程度` | 出生日期 / 学历 等 |
| `婚姻状态` | 婚姻 / 婚史 / 婚姻财产制 |
| `有偏好` | 偏好 / 投保偏好 / 偏好保险公司 / 缴费偏好 / 风险偏好 |

> ⚠️ 2026-09-28 推翻并修改（原表把 `月薪` 列进 `个人年收入` 的同义说法）：该槽经
> `AXIS_MEMBER_FIELD` 直落 `members.income`（单位**万/年**）并被 `gap-core` 当作 5×年收入缺口的基数，
> 而"月薪2万"是**月度**语义 → 归一进去 = 少报约 12×，错在确定性计算上。现 `月薪` **不归一**
> （`axis` 留空），事实仍按 `kind` 进画像与 AI 上下文、原话保留；**不做** ×12 自动换算
> （objectValue 是自由文本，猜单位会错得更大）。单一事实源：`cloudfunctions/_shared/fact-vocab.js`。

### 家庭财务（versioned）

| axis 槽 | 常见同义说法 |
|---------|-------------|
| `总负债` | 负债 / 负债总额 |
| `房贷余额` | 房贷 / 贷款余额 / 按揭余额 |
| `负债期限` / `贷款到期日` | 贷款期限 / 还款期限 |
| `持有资产` / `房产价值` / `金融资产` | 资产 / 存款 / 理财 |
| `收入来源` / `抚养赡养人数` / `社保情况` | 赡养人数 / 五险一金 |
| `年保费预算` / `资产持有比例` | 保费预算 / 持股比例 |
| `企业经营权`（dedup） / `婚前财产`（dedup） | — |

### 目标与规划（versioned）

`未来计划` / `教育规划` / `退休规划` / `退休预期年龄` / `传承意图` / `资产隔离需求` / `婚嫁规划` /
`教育支出预期` / `赡养支出预期` / `子女教育节点` / `婚嫁预期时点`

### 保单节点属性（封闭集，versioned）

`险种` / `保额` / `年缴保费` / `生效日` / `保障期间` / `缴费期` / `缴费方式` / `特殊条款` / `承保公司` /
`保单号` / `免赔额` / `等待期`

> 这些是**保单实体的字段**（`subject_type='policy'`），不是成员属性槽——由 `policyToFacts` 写入，
> 按"当前值"语义 versioned 覆盖。

### 保障边与关系（dedup，非属性槽）

| Predicate | subject | object | 示例 |
|-----------|---------|--------|------|
| `拥有保障` | member | policy | (李阳勇, 拥有保障, pol_001) |
| `公司提供保障` | member | literal | (李阳勇, 公司提供保障, 补充医疗) |
| `投保` | member | policy | (李阳勇, 投保, pol_001) |
| `配偶` / `子女` / `父母` | member | member | (李阳勇, 配偶, 谢敏) |

### kind：信息性质（闭合 4 值）

| kind | 含义 | AI 消费方式 | 代码消费 |
|------|------|------------|---------|
| `fact` | 可确认的事实值（默认） | 可直接引用为事实 | `axis` 命中则参与计算 |
| `constraint` | 约束/时效（如"团险离职即失效"） | **分析时必须考虑** | 不参与计算 |
| `relation` | 实体关系（如"夫妻共保"） | 提示多实体覆盖 | `object_id` 有效则可跳转 |
| `lead` | 待核实线索（如"公司可能有年金"） | 列入待确认，不得当事实 | 不参与计算 |

> **非标信息**（如"团险在职有效"、"夫妻共保份额待确认"）不属于任何 axis 槽，也不需要——
> 它们以 `kind=constraint/relation/lead` 原话入上下文，由 AI 判读；这是"参与深度分析"的正确路径，
> 而不是把非标信息硬塞进闭合维度（旧实现塞进「备注」后无人消费）。

---

**不进入 facts 的数据**（直接查结构化表）：

| 数据 | 查询路径 |
|------|---------|
| 年收入、总负债 | `finances` |
| 保额、保费 | `policies` |
| 险种分类 | `policies.category` |
| 职业、健康状况 | `members` |
| 年龄、性别 | `members` |

---

## 四、上下文组装

```javascript
function buildFamilyContext(familyId, scene) {
  // 基础层：所有推理场景必然加载
  const base = {
    members: db.collection('members').where({ family_id: familyId }).get(),
    finances: db.collection('finances').where({ family_id: familyId }).get()
  }

  const policies = (status) =>
    db.collection('policies').where({ family_id: familyId, ...(status && { status }) }).get()

  const facts = (predicates, limit) => {
    let q = db.collection('facts')
      .where({ family_id: familyId, status: 'active' })
      .orderBy('created_at', 'desc')
    if (predicates) q = q.where({ predicate: _.in(predicates) })
    if (limit) q = q.limit(limit)
    return q.get()
  }

  switch (scene) {
    case 'list':
      // 首页：仅展示
      return {
        family: db.collection('families').doc(familyId).get(),
        members: base.members.field({ name: true, role: true })
      }

    case 'conversation':
      // 对话：基础层 + 保单摘要 + 近期事实（全量谓词）
      return {
        ...base,
        policies: aggregateByCategory(policies('active')),
        facts: facts(null, 10)
      }

    case 'analysis':
      // 分析：基础层 + 保单 + 保障相关 facts（排除个人偏好/特征，减少干扰）
      return {
        ...base,
        policies: policies('active'),
        facts: facts(['配偶', '子女', '父母', '购买了', '角色', '缺少', '有缺口', '建议'])
      }

    case 'report':
      // 报告：全量
      return {
        ...base,
        policies: policies(),
        facts: facts()
      }
  }
}
```

**关键**：`members` 和 `finances` 始终在 base 中。AI 计算 `寿险缺口 = 负债 + 5 × 年收入` 时，数据从 finances 直接取，不走 facts。

---

## 五、数据流

### 5.1 写入路由

```
用户输入 → AI 提取 → 确认卡片 → 路由写入：

  ┌───────────────────────────────────┐
  │ 覆盖更新                           │
  ├───────────────────────────────────┤
  │ 姓名/出生日期/角色/gender → members │
  │ 职业/健康 → members                │
  │ 年收入/负债/支出 → finances        │
  │ 保单全部字段 → policies            │
  └───────────────────────────────────┘
  ┌───────────────────────────────────┐
  │ 追加更新                           │
  ├───────────────────────────────────┤
  │ 配偶/子女/父母 → facts            │
  │ 购买了（member→policy）→ facts    │
  │ 角色=经济支柱 → facts             │
  │ 有习惯/有偏好/有特征 → facts      │
  │ 缺少/有缺口/建议 → facts          │
  └───────────────────────────────────┘
```

### 5.2 完整示例

```
输入："我老婆谢敏是教师，年收入50万，她还没有重疾险"

AI 提取 → 确认卡片 → 确认后：

写 members:  { name:'谢敏', role:'配偶', occupation:'教师' }
写 finances: { annual_income: 500000 }
写 facts:    [
  { 李阳勇, 配偶, 谢敏, source:'ai' },
  { 谢敏,   缺少, 重疾险, source:'ai' }
]

buildFamilyContext(familyId, 'analysis') →
  base.members = [李阳勇(本人), 谢敏(配偶,教师), ...]
  base.finances = { annual_income: 500000, ... }
  base.policies = [已有保单...]
  facts = [配偶→谢敏, 谢敏→缺少重疾险]

AI 看到完整图景 → 生成缺口分析：
  "谢敏作为配偶且为教师（收入稳定），缺少重疾险是家庭主要保障缺口..."
```

### 5.3 保单写入时同步写 facts

```javascript
async function writePolicyWithFacts(policyData) {
  const policyId = await db.collection('policies').add({ data: policyData })

  await db.collection('facts').add({
    data: {
      family_id: policyData.family_id,
      subject_type: 'member', subject_id: policyData.member_id,
      predicate: '购买了',
      object_type: 'policy', object_id: policyId,
      object_value: policyData.product_name,
      source: 'system', status: 'active',
      created_at: new Date()
    }
  })
}
```

---

## 六、查询示例

### 6.1 家庭保障分布（纯结构化）

```javascript
const policies = await db.collection('policies')
  .where({ family_id, status: 'active' }).get()

const dist = {}
policies.forEach(p => { dist[p.category] = (dist[p.category] || 0) + p.sum_assured })
// → { 寿险: 1000000, 重疾险: 500000, ... }
```

### 6.2 查某人缺少的保障（组合查询）

```javascript
// 1. 从 facts 查"缺少"
const gaps = await db.collection('facts')
  .where({ subject_id: 'mem_xxx', predicate: '缺少', status: 'active' }).get()
// → [{ object_value: '重疾险' }, { object_value: '意外险' }]

// 2. 从 policies 查已有保障做交叉验证
const existing = await db.collection('policies')
  .where({ member_id: 'mem_xxx', status: 'active' }).get()
// → [{ category: '寿险', sum_assured: 1000000 }]

// 3. 缺口中排除已有的 → 最终缺口
```

### 6.3 保障缺口计算（AI 侧）

```
Prompt 上下文:
  members:   [李阳勇(37岁,本人,工程师,体健), 谢敏(35岁,配偶,教师), 李牧云(8岁,子女)]
  finances:  { annual_income: 500000, total_debt: 1500000, debt_type: '房贷' }
  policies:  [李阳勇→寿险100万, 李阳勇→医疗险200万]
  facts:     [李阳勇角色=经济支柱, 谢敏缺少重疾险]

AI 推理:
  1. 李阳勇是经济支柱 → 寿险缺口 = 负债150万 + 5×年收入250万 - 已有100万 = 300万
  2. 谢敏缺少重疾险 → 建议补充50万
  3. 李牧云无任何保障 → 建议基础医疗+意外
```

---

## 七、集合总览

| 集合 | 定位 | 变更 | 量级 |
|------|------|------|------|
| `families` | 家庭容器 | 极少 | 100-500 |
| `members` | 成员属性（展示+推理输入） | 低频覆盖 | 2-20/家庭 |
| `finances` | 财务数据（推理输入） | 低频覆盖 | 1/家庭 |
| `policies` | 保单硬数据（推理输入） | 高频追加 | 5-30/家庭 |
| `facts` | 关系+推理结论 | 高频追加 | 20-80/家庭 |

---

## 八、一条判断标准

> 这个数据是"这个人/保单**是什么**"→ 结构化表。
> 这个数据是"这个人与什么/谁**有关**"或"**由此推出什么结论**"→ facts。

---

## 九、实施

| 阶段 | 内容 | 预估 |
|------|------|------|
| 第 1 周 | 建 5 张集合 + 索引 + dataWrite 适配 | 3 天 |
| | buildFamilyContext + 场景化组装 | 1 天 |
| | 改写 conversationAI/reportAI 上下文加载 | 1 天 |
| 第 2 周 | 前端适配（查询路径变更 + 卡片确认逻辑） | 2 天 |
| | 测试 + 修复 | 2 天 |
| | 部署 + 联调 | 1 天 |

**总预估：2 周。**
