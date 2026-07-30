# CONTEXT

## 产品定位
保险销售辅助工具。帮助业务员在见客户前准备、见客户后复盘，完成从保单录入到保障方案输出的完整链路。**不用于客户面前实时交互。**

**核心理念**：旧产品以客户档案（数据库记录）为对象，新产品以客户报告（活文档）为对象。业务员的核心工作不是"填数据库"，而是"让一份报告从空变完整、从骨架变成品"。DNA 是 publishing，不是 CRUD。

## 智能对话定位

**对话围绕报告展开**，智能体不是通用聊天机器人，而是这份报告的 co-writer。所有交互都锚定在报告结构上：

## 核心实体

| 术语 | 定义 |
|------|------|
| **家庭档案** | 一个客户家庭的完整数据集合，包含成员、保单、经济状况、生命周期阶段 |
| **保障画像（Protection Profile）** | 从家庭结构、生命周期、已有保障、经济状况四个维度综合评估得到的立体式需求全景 |
| **缺口清单（Gap List）** | 精确列出每个家庭成员在哪些险种上缺少保障，或保额不足 |
| **优先级推荐（Priority Plan）** | 在缺口清单基础上，按紧急程度排序的购买建议（最紧急 → 次优先 → 可延后） |

## 四个分析维度

| 维度 | 来源 | 作用 |
|------|------|------|
| 家庭结构 | 成员数、年龄、角色 | 确定谁最需要保障 |
| 生命周期 | 单身/新婚/育儿/中年/空巢/退休 | 确定保障阶段重点 |
| 已有保障 | OCR 保单识别 + 手动补充 | 计算缺口 |
| 经济状况 | 年收入、负债、固定支出、保费预算 | 确定合理保额和保费承受力 |

## 分析引擎

**由 LLM 驱动**，运用大语言模型的保险领域知识，从保障画像四维度数据生成缺口清单和优先级推荐。规则引擎不参与分析判断，仅负责前端的数据校验和格式转换。

## 信息采集模式

**渐进式 + 断点续采**。一个家庭的信息很少一次性齐全。流程不是线性的：
```
拍照 → 系统发现信息缺口 → 引导业务员补充 → 业务员找客户确认（可能数小时/数天后）→ 回来录入 → 系统再评估 → 可能还有缺口 → 继续引导...
```

因此 LLM 承担双重角色：
- **引导者**：信息不足时，告诉业务员"还需要问客户什么"，给出具体的问题清单
- **分析者**：信息足够时，生成缺口清单和优先级推荐

系统需追踪每个家庭的**信息完备度**，允许随时断点恢复。

## 分析触发

- **LLM 自动评估**（主导）：每次新信息录入后，LLM 以资深保险顾问角色评估当前数据完备度，建议"可以分析了"或"还缺 X，缺它会影响 Y 结论"
- **手动触发**（辅助）：业务员随时可以点击"开始分析"，但 LLM 必须在结果中标注"因缺少 X 信息，Y 结论仅供参考"
- **置信度标注**：每项推荐必须附带置信度说明，明确指出哪些缺失信息影响了该结论

## PDF 报告结构

专业排版，严谨易懂。12 个章节：

| # | 章节 | 内容 |
|---|------|------|
| 1 | 家庭摘要 | 一句话概览 |
| 2 | 家庭结构 | 成员表（姓名/年龄/角色） |
| 3 | 保障汇总 | 已有保单总览 |
| 4 | 保障分布 | 按险种/被保人分布的图表 |
| 5 | 缴费月历 | 每月保费支出明细 |
| 6 | 缴费年历和关键节点 | 年度支出 + 续保/到期提醒 |
| 7 | 客户保障分析 | 缺口矩阵 |
| 8 | 保障规划建议及理由 | 优先级推荐 + 每项理由 |
| 9 | 行动建议 | 下一步动作清单 |
| 10 | 风险提示 | 置信度告警 + 免责 |
| 11 | 附录：保单明细 | 全部保单原始数据表 |
| 12 | 附录：保障规划常用原理 | 静态科普知识 |

## 输出结构

LLM 生成的结构化分析结果，手机和 PDF 共用同一数据源：
```
{ 客户画像, 缺口清单: [...], 优先级推荐: [...], 信息提示: [...] }
```

## 交互模式

**报告为中心，对话为辅助**。每个客户的核心界面是一份动态保障报告（12 章骨架），保单 OCR 后自动填入已知字段，缺失项标红待补。

```
┌─────────────────────────────────┐
│  📄 张三保障报告 · 完成度 60%    │
├─────────────────────────────────┤
│  1. 家庭摘要 ✅                  │
│  2. 家庭结构 ✅                  │
│  3. 保障汇总 ✅ (2份保单)        │
│  4. 保障分布 ⚠️ (数据不足)       │
│  ...                             │
│  8. 保障规划建议 ❌ (需补充收入)  │
│  ...                             │
├─────────────────────────────────┤
│  👤 输入框：[_____] [📎] [📷]    │  ← 底部对话交互区
└─────────────────────────────────┘
```

- 报告是主界面，实时刷新
- 底部输入区：补充信息、提问、触发分析
- 确认操作：弹出式卡片（不打断报告浏览）
- 客户切换：侧边抽屉
- **实时联动**：轻量化更新自动生效；重要更新弹卡片确认后，LLM 提示"数据已变更，正在重新分析"并自动刷新报告 7-10 章

**进入逻辑**：打开小程序 → 上次活跃客户的报告 → 静止展示。切换客户时，新客户的报告加载并显示摘要引导。

## 系统架构

- **前端**：微信小程序（原生），报告为主 + 底部对话 + 侧边抽屉，3 页（index/report/clients）
- **后端**：CloudBase 云函数（dataWrite / dataQuery / reportAI / conversationAI / ocrService / login），共享模块经 `scripts/sync-shared.js` 同步至各函数 `_shared/` 副本
- **数据库**：CloudBase NoSQL（文档型，5 集合：families / members / finances / policies / facts，灵活适配渐进式录入）
- **AI**：通过 CloudBase 调用混元大模型（`hunyuan-exp` 分组 + `hy3-preview` 模型）

原则：**轻量化，单一服务，零分布式复杂度**。

## 顾问人格

系统必须以一个**具名的、人格化的资深保险顾问**形象出现在产品中。所有对话围绕着"如何让这份报告更完整、更精准"展开。

核心会话场景：

| 场景 | 示例 |
|------|------|
| 信息收集引导 | "第 8 章保障规划建议还缺收入数据，建议下次见客户时确认——这直接影响重疾保额精度" |
| 保障检视提醒 | "张三的医疗险下个月到期，建议在第 6 章缴费年历标注续保提醒" |
| 分析结果解读 | "第 7 章缺口矩阵显示，家庭经济支柱的重疾保障完全缺失——这是最优先要解决的" |
| 报告完成度提示 | "目前完成度 60%，第 4/8/9 章待补——需要我帮你优先处理哪一块？" |

## 数据模型

### 集合总览（5 集合架构）

| 集合 | 定位 | 变更 | 量级 |
|------|------|------|------|
| `families` | 家庭容器（标识+状态+报告产物） | 低频 | 100-500 |
| `members` | 成员主数据（展示+推理输入） | 低频覆盖 | 2-20/家庭 |
| `finances` | 财务主数据（推理输入） | 低频覆盖 | 1/家庭 |
| `policies` | 保单事实表（推理输入） | 高频追加 | 5-30/家庭 |
| `facts` | 三元组关系+推理结论 | 高频追加 | 20-80/家庭 |

> **去冗余（Plan A）**：`members` / `finances` 为独立集合，成员与财务的**唯一真相源**；`families.members` / `families.financial_snapshot` 内嵌字段已废弃（迁移脚本清空）。关联键统一为 `members.member_id`（形如 `mem_xxx`）：`policies.member_id` 与 `facts.subject_id` 均指向它。读写经 `_shared/member-store.js`（`loadFamilyView` / `getMembers` / `upsertMember` 等）。

### families — 家庭容器
| 字段 | 类型 | 说明 |
|------|------|------|
| `_openid` | string | 业务员 |
| `family_name` | string | 家庭名称 |
| `family_structure` | object | `{ roles[], member_count, created_with_roles[] }` |
| `engagement_stage` | string | onboarding/...（stageMachine 推导） |
| `completeness_score` | 0-100 | 完备度（每次分析后评估） |
| `insight_stale` | bool | 洞察是否过期（写入即置 true） |
| `last_analysis_at` | timestamp | 上次分析时间（60s 节流） |
| `last_portrait` / `last_review` / `last_plan` / `last_suggestions` / `last_milestones` / `last_disclaimer` / `last_conclusion` | string | 报告产物（AI 生成） |
| `profile_state` | string | collecting/... |
| `status` | string | active/deleted |

> 成员/保单/事实/笔记均不内嵌，分别从 `members`/`policies`/`facts` 集合按 `family_id` 查询。

### Member（成员，独立 `members` 集合文档）
| 字段 | 类型 | 说明 |
|------|------|------|
| `member_id` | string | **join key**（`mem_xxx`），`policies.member_id` / `facts.subject_id` 引用 |
| `family_id` | string | 归属家庭 |
| `name`, `age`, `role` | string | 年龄优先由 `birth_date` 推导；`age` 冗余存储便于展示 |
| `birth_date` | string | YYYY-MM-DD |
| `gender`, `health`, `occupation` | string | |
| `income` | number | 个人年收入（万元），对话「个人年收入」fact 同步写入 |
| `status` | string | active/deleted（软删除，关联 policies.member_id 保留） |

### Policy（保单，独立 `policies` 集合文档）
| 字段 | 类型 | 来源 |
|------|------|------|
| `id`(=`policy_id`) | string | 系统生成 `pol_xxx` |
| `member_id` | string | 被保人 join key（指向 `members.member_id`） |
| `insurance_category` | string | OCR·AI（险种：重疾险/医疗险/意外险/寿险/年金/其他） |
| `insurance_type` | string | OCR·AI |
| `product_name` | string | OCR·AI |
| `sum_assured` / `annual_premium` | number | OCR·AI |
| `insured_name` / `policyholder_name` / `beneficiary_name` | string | OCR·AI |
| `insurer` / `policy_number` / `effective_date` / `insurance_period` / `payment_method` / `payment_period` | string | OCR |
| `confidence` / `field_confidence` | 0-1/object | 综合/逐字段 |
| `auto_confirmed` | bool | ≥95% |
| `special_agreement` | string | OCR（入库前脱敏） |
| `source` | 'ocr'\|'manual'\|'dialog' | |

### Fact（三元组，独立 `facts` 集合文档）
| 字段 | 类型 | 说明 |
|------|------|------|
| `subject_type` | string | member/family/policy |
| `subject_id` | string | 指向 `members.member_id` 或 family/policy `_id` |
| `predicate` | string | 配偶/子女/父母/购买了/角色/缺少/有缺口/建议/有偏好/有特征/... |
| `object_type` | string | member/policy/literal |
| `object_id` | string | 对象为 member 时指向 `member_id` |
| `object_value` | string | 字面值或冗余名称 |
| `confidence` / `source` / `status` | 0-1 / ai\|agent\|system / active\|superseded | |
| `reasoning` | string | 推理追溯 |

> 结构化数据（收入/负债/职业/健康/年龄）不走 facts，直接存 `finances`/`members`；facts 仅存关系与推理结论。

### Note（非结构化笔记）
笔记以 fact 形式存储（`facts` 集合，`category:'note'`，含 `content`/`category`/`source`/`created_at`），非独立集合。

## 使用场景

| 场景 | 时机 | 行为 |
|------|------|------|
| 事前准备 | 见客户前 | 查看已有报告，了解缺口，准备话题 |
| 事后复盘 | 见客户后 | 上传新保单，补充信息，完善报告 |
