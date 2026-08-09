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

**基础版（已实现）**：纯规则引擎驱动。`gap-engine` 计算保障缺口/覆盖矩阵，`timeline-builder` 构建缴费时间轴，`buildReportView` 统一聚合 7 章（含家庭财务独立章），无 AI 参与。

**深度分析（已实现，手动触发）**：report 页「深度分析」按钮 → `api('generateReport')`（60s 超时）→ reportAI AI 生成画像/点评/规划/建议，写 `families.last_*` 并由前端渲染。缺口矩阵由系统预计算注入 AI（`report-context.buildGapSnapshot`）。PDF 导出待设计。

## 信息采集模式

**渐进式 + 断点续采**。一个家庭的信息很少一次性齐全。流程不是线性的：
```
拍照 → 系统发现信息缺口 → 引导业务员补充 → 业务员找客户确认（可能数小时/数天后）→ 回来录入 → 系统再评估 → 可能还有缺口 → 继续引导...
```

因此 LLM 承担双重角色（当前仅引导者已实现）：
- **引导者**（已实现，对话侧）：信息不足时，告诉业务员"还需要问客户什么"，给出具体的问题清单
- **分析者**（已实现，深度分析）：信息足够时，生成缺口清单和优先级推荐（reportAI）

系统需追踪每个家庭的**信息完备度**，允许随时断点恢复。

## 分析触发

- **基础版报告：纯数据驱动**。OCR/编辑入库后仅触发前端「缓冲（默认 500ms）→ 重读 → 应用」重算 7 章，不调用 AI；编辑保存走本地增量更新（`_applyLocalUpdate` 立即渲染 + `waitMs:0` 后台校验）
- **深度分析：手工触发（已实现）**。曾自动触发 reportAI，用户明确决策删除自动触发（2026-08），改为 report 页「深度分析」按钮手动触发（`generateReport`）
- **置信度标注**（OCR 侧）：`assessPolicy`（0.9 阈值单一真相源）+ `assessCoreCompleteness`（核心字段 ≥80% 非空才自动确认），低置信度走确认卡

## 报告结构（基础版 · 7 章单页长图）

由 `buildReportView` 统一聚合（规则引擎，无 AI），手机端已实现，PDF 导出待设计：

| # | 章节 | key | 内容 |
|---|------|-----|------|
| 1 | 家庭结构 | `family_structure` | 成员树（角色分组），可编辑 |
| 2 | 家庭财务 | `family_finance` | 收入/负债/支出（R2 从家庭结构拆出独立章），可编辑 |
| 3 | 保障汇总 | `coverage_summary` | 成员×险种保障矩阵 + 缺失提示 + 缺口警示 |
| 4 | 缴费月历 | `premium_calendar` | 12 格月度保费 + 峰值高亮 + 年总保费/占收入比 |
| 5 | 缴费年历和关键节点 | `premium_timeline` | 续保/到期/缴费期满时间轴 |
| 6 | 风险提示 | `risk_alerts` | 置信度告警 + 免责声明 |
| 7 | 附录：保单明细 | `appendix_policies` | 按被保人分组的保单卡片，点击弹明细 Sheet |

> 深度分析章节（保障规划/行动建议等）由扩展版承载，已实现（reportAI + 手动触发）。

## 输出结构

前端一次调用 `buildReportView(family, report)` 拿到全部视图数据：
```
{ chapters: [7章卡片], hero: { alerts, summary, topAdvice, conclusion },
  summaryCards: { premium, coverage, count }, gaps, hints }
```
- `hero` 为规则版覆盖检查（结论先行警示列表），AI conclusion 仅供分享标题
- 报告产物字段（families `last_*`）由 `report-fields.js` 单一契约：portrait / review / plan / suggestions / disclaimer / analysis / conclusion / summary + core_insights

## 交互模式

**报告为中心，对话为辅助**。每个客户的核心界面是一份动态保障报告（7 章单页长图），保单 OCR 后自动填入已知字段，缺失项提示待补。

```
┌─────────────────────────────────┐
│  📄 张三保障报告 · 7 章          │
├─────────────────────────────────┤
│  1. 家庭结构 ✅                  │
│  2. 家庭财务 ✅                  │
│  3. 保障汇总 ✅ (2份保单)        │
│  4. 缴费月历 ✅                  │
│  5. 缴费年历和关键节点 ⚠️        │
│  6. 风险提示 ⚠️ (置信度告警)     │
│  7. 附录：保单明细 ✅             │
├─────────────────────────────────┤
│   [📷 保单]      [💬 对话]       │  ← 底部 FAB
└─────────────────────────────────┘
```

- 报告是主界面，实时刷新；编辑保存本地增量更新（立即重算）+ 后台静默校验
- 底部 FAB：保单上传（ocr-flow 组件，选图 → OCR → 确认入库）/ 对话面板（chat-panel，三步流程）
- 对话内上传已移除（2026-08 核实无 upload 代码）
- 确认操作：弹出式卡片（确认/修改，不打断报告浏览）
- 客户切换：首页最近客户列表 / 客户列表页搜索
- **实时联动**：OCR/编辑入库 → `savedhome`/`onOcrFlowSaved` 事件触发报告页重读重算（不触发 AI）

**进入逻辑**：打开小程序 → 首页最近客户列表 → 点击进入报告 → 静止展示。

## 系统架构

- **前端**：微信小程序（原生），报告为主 + 底部 FAB，3 页（index/report/clients）
- **后端**：CloudBase 云函数，共享模块经 `scripts/sync-shared.js` 同步至各函数 `_shared/` 副本：
  - `dataQuery`：查询聚合（getFamily / queryMessages / listFamilies / searchFamilies / queryPolicies / queryMembers / queryFacts）
  - `dataWrite`：写入聚合（家庭/成员/事实/保单/消息，`ingestPolicies` 批量入库 step 化）
  - `reportAI`：深度分析报告生成（已停止自动触发，待手工入口）
  - `conversationAI`：对话三步流程（getPrompt / generateText / postProcess）+ 13 工具路由
  - `ocrService`：OCR 全链路（ocrOnly / aiExtractBatch / aiExtractParallel / matchPolicies）
  - `login`：手机号登录；`cleanup`：定时清理
- **数据库**：CloudBase NoSQL（文档型，5 集合：families / members / finances / policies / facts，灵活适配渐进式录入）
- **AI**：对话/单图 OCR 提取经混元 `hy3`（`hunyuan-exp` 分组，TokenHub）；批量 OCR 提取（>1 张）走 DeepSeek 直连（`deepseek-v4-flash`，key 仅配置于 ocrService）；云函数侧 AI 全链经 `ai-gateway.js` → `safeCallChat`（审查链：sanitize → PII 脱敏 → 注入检测 → 内容安全 → 限流 60/60s → 输出审计 → agent_logs）

原则：**轻量化，单一服务，零分布式复杂度**。

## 顾问人格

系统必须以一个**具名的、人格化的资深保险顾问**形象出现在产品中。所有对话围绕着"如何让这份报告更完整、更精准"展开。

核心会话场景：

| 场景 | 示例 |
|------|------|
| 信息收集引导 | "保障汇总还缺收入数据，建议下次见客户时确认——这直接影响重疾保额精度" |
| 保障检视提醒 | "张三的医疗险下个月到期，建议在第 4 章缴费年历标注续保提醒" |
| 分析结果解读 | "保障汇总的缺口矩阵显示，家庭经济支柱的重疾保障完全缺失——这是最优先要解决的" |
| 报告完成度提示 | "目前完成度 60%，第 2/4 章待补——需要我帮你优先处理哪一块？" |

## 数据模型

### 集合总览（5 集合架构）

| 集合 | 定位 | 变更 | 量级 |
|------|------|------|------|
| `families` | 家庭容器（标识+状态+报告产物） | 低频 | 100-500 |
| `members` | 成员主数据（展示+推理输入） | 低频覆盖 | 2-20/家庭 |
| `finances` | 财务主数据（推理输入） | 低频覆盖 | 1/家庭 |
| `policies` | 保单事实表（推理输入） | 高频追加 | 5-30/家庭 |
| `facts` | 三元组关系+推理结论 | 高频追加 | 20-80/家庭 |

> **去冗余（Plan A）**：`members` / `finances` 为独立集合，成员与财务的**唯一真相源**；`families.members` 内嵌字段已废弃。`families.financial_snapshot` **仍活跃**：由 `memberRepo.getFinance` 聚合 finances 集合（元键 annual_income/total_debt/fixed_annual_expense ÷10000 转万；旧万键 income/debt/fixed_expense fallback），供表单回显与报告上下文使用。关联键统一为 `members.member_id`（形如 `mem_xxx`）：`policies.member_id` 与 `facts.subject_id` 均指向它。读写经 `_shared/memberRepo.js`（`loadFamilyView` / `getMembers` / `upsertMember` / `getFinance` 等）。

### families — 家庭容器
| 字段 | 类型 | 说明 |
|------|------|------|
| `_openid` | string | 业务员 |
| `family_name` | string | 家庭名称 |
| `family_structure` | object | `{ roles[], member_count, created_with_roles[] }` |
| `engagement_stage` | string | onboarding/...（stageMachine 推导） |
| `completeness_score` | 0-100 | 完备度（每次分析后评估） |
| `insight_stale` | bool | 洞察是否过期（写入即置 true） |
| `last_analysis_at` | timestamp | 上次分析成功时间（供归档 version_at 使用） |
| `analysis_lock_at` | timestamp | 分析进行中 CAS 锁（30s 节流，成功生成后释放；旧数据无此字段时回退 last_analysis_at） |
| `last_portrait` / `last_review` / `last_plan` / `last_suggestions` / `last_disclaimer` / `last_analysis` / `last_conclusion` / `last_summary` / `last_core_insights` | string/array | 报告产物（AI 生成，契约见 `report-fields.js`；基础版不消费，待深度分析） |
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
| `auto_confirmed` | bool | ≥0.9（`CONF_THRESHOLD`，且核心字段 ≥80% 非空，见 `ocr-confidence.js`） |
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
