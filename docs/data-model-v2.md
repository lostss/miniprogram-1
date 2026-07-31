# 保小秘 v2 数据模型

> 核心原则：**基础层 + 推理层，不重复，只叠加**。

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
  fixed_annual_expense: 100000,  // 年固定支出（元）
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

  predicate: '个人年收入',  // 见谓词表（30 谓词全量）

  object_type: 'member',    // member | policy | literal
  object_id: 'mem_yyy',     // literal 时为空
  object_value: '30万',     // 字面值或冗余名称
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

**写入策略**：`FACT_STRATEGIES` 30 谓词全覆盖（dedup 8 + versioned 22）。`versioned` 策略自动 supersede 旧事实 → 写入新事实。agent_confirmed 源受保护不被低置信源覆盖。

---

## 三、谓词表（30 谓词全量）

### 关系类

| Predicate | subject | object | 示例 | 策略 |
|-----------|---------|--------|------|------|
| `配偶` | member | member | (李阳勇, 配偶, 谢敏) | dedup |
| `子女` | member | member | (李牧云, 子女, 李阳勇) | dedup |
| `父母` | member | member | (李阳勇, 父母, 李父) | dedup |

### 保障类

| Predicate | subject | object | 示例 | 策略 |
|-----------|---------|--------|------|------|
| `拥有保障` | policy | literal | (pol_001, 拥有保障, 保额30万/年缴5600) | versioned |
| `公司提供保障` | member | literal | (李阳勇, 公司提供保障, 补充医疗) | versioned |

### 保单级字段（可变更 → versioned）

| Predicate | subject | object | 示例 | 策略 |
|-----------|---------|--------|------|------|
| `保额` | policy | literal | (pol_001, 保额, 300000) | versioned |
| `年缴保费` | policy | literal | (pol_001, 年缴保费, 5600) | versioned |
| `险种` | policy | literal | (pol_001, 险种, 重疾险) | versioned |
| `生效日` | policy | literal | (pol_001, 生效日, 2024-03-15) | versioned |
| `承保公司` | policy | literal | (pol_001, 承保公司, 平安人寿) | versioned |
| `保障期间` | policy | literal | ... | versioned |
| `缴费期` | policy | literal | ... | versioned |
| `缴费方式` | policy | literal | ... | versioned |
| `特殊条款` | policy | literal | ... | versioned |

### 人况类（可变更 → versioned）

| Predicate | subject | object | 示例 | 策略 |
|-----------|---------|--------|------|------|
| `职业` | member | literal | (李阳勇, 职业, 工程师) | versioned |
| `个人年收入` | member | literal | (李阳勇, 个人年收入, 30万) | versioned |
| `健康异常` | member | literal | (李阳勇, 健康异常, 高血压) | versioned |
| `年龄` | member | literal | (李阳勇, 年龄, 43) | versioned |
| `性别` | member | literal | (李阳勇, 性别, 男) | versioned |
| `教育程度` | member | literal | (李阳勇, 教育程度, 本科) | versioned |

### 家庭/偏好/备忘（dedup）

| Predicate | subject | object | 示例 | 策略 |
|-----------|---------|--------|------|------|
| `负债` | member/family | literal | (李阳勇, 负债, 房贷150万) | versioned |
| `持有资产` | member/family | literal | (李阳勇, 持有资产, 房产300万) | dedup |
| `未来计划` | member/family | literal | (李阳勇, 未来计划, 换房2026) | versioned |
| `有偏好` | member | literal | (李阳勇, 有偏好, 分红型) | versioned |
| `有特征` | member | literal | (李阳勇, 有特征, 宠物两只) | dedup |
| `备注` | member/family/policy | literal | 自由文本备注 | dedup |
| `投保` | member | policy | (李阳勇, 投保, pol_001) | dedup |
| `保单号` | policy | literal | (pol_001, 保单号, P2024001) | dedup |
| `固定支出` | member/family | literal | 月/年度固定支出 | versioned |
| `年保费预算` | family | literal | 家庭年保费预算 | versioned |

---

**不进入 facts 的数据**（直接查结构化表）：

| 数据 | 查询路径 |
|------|---------|
| 年收入、负债、固定支出 | `finances` |
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
