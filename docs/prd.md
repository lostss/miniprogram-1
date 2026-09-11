# 保小秘 —— 产品需求文档

> **上传保单，秒出报告**
> ——把复杂度留给自己，把简单交给用户。

---

## 一、产品概述

**保小秘** 面向保险代理人，拍照上传保单 → AI 生成家庭保障分析 → 对话追问。全链路云函数 + 微信 API。

**核心原则**：把操作留给后台，把结论留给用户。

## 二、技术架构

```
小程序前端（原生 WeChat）——AI 全部在云函数后端，前端无直连（v10 单通道）
└── 云函数（OCR / 报告 / 对话 / 数据管理）
    ├── 云数据库（NoSQL: families / members / finances / policies / facts / messages 等）
    └── 云存储（保单图片 jpg, 压缩 quality:80）
```

**数据主集合**：`families/members/finances/policies/products/facts`（6 集合）

**共享模块层**：ai-gateway.js / ai-client.js / guard.js / v2-context.js / ocr-core / ocr-extractor / ocr-confidence / member-matcher / completeness / memberRepo / calc-age / readiness / stageMachine / familyPortrait / writeSeam / logSeam 等。通过 `scripts/sync-shared.js` 闭包推导自动发现 + 同步到各云函数（仅复制各函数实际 require 的文件）。

### 端到端数据流

```
[拍照] → ocrService/ocrOnly（并发 OCR 无 AI）→ aiExtractParallel（AI 提取：1 张与 N 张统一走 DeepSeek 直连）
                                                ↓
                        dataWrite/writePoliciesBatch + matchPoliciesToMembers(成员匹配)
                                                ↓
                        reportAI（生成 portrait/review/plan/analysis/summary/conclusion/suggestions）
                                                ↓
                              [报告页渲染] ← dataQuery/getFamily
                                                ↓
                              [用户追问] → chat-panel 单通道对话
                                                ↓
                  1. conversationAI/chat（单通道 function calling + 写入确认卡/默认执行+撤销 + 审计 + 持久化）
                                                ↓
                  [工具触发] → triggerAnalysis
                                      ↓（异步 3-10s 后）
                              onRefreshReport 重新拉取数据
```

## 三、页面架构（3 页）

| 页面 | 路径 | 组成 |
|------|------|------|
| 首页 | pages/index | brand-header（内联）+ OCR 三态蒙层 + 最近服务 client-card ×N |
| 报告页 | pages/report | 结论卡片 + report-markdown(chapters) + 提示卡片 + chat-panel(FAB) |
| 客户列表 | pages/clients | 搜索 + client-card ×N |

**跳转**：首页点击客户/OCR完成 → 报告页 · 首页查看全部 → 客户列表

## 四、核心功能

### 4.1 保单上传与 OCR

| 项目 | 说明 |
|------|------|
| 输入 | 拍照/相册，最多 9 张，`compressImage(quality:80)` 预处理（<2MB 不压缩） |
| 分批 | 每批并发 OCR（ocrOnly，无 AI；9 张全并发安全） |
| 模型分流 | **1 张与 N 张统一 → `aiExtractParallel`（DeepSeek 直连，每张 1 次并发）**（2026-08-30 收敛：`aiExtractBatch`/hy3 单图路径已删除，批量拼接已弃用） |
| 字段 | 保单号、保险公司、生效日期、投保人、被保人、产品名、险种分类、保额、保费、缴费期、保障期、受益人、出生日期 |

**置信度分流**（`ocr-confidence.js` 单一真相源，`CONF_THRESHOLD=0.9` + 核心字段完整性双条件）：
- `autoConfirmed=true` → 自动入库（自动/手动确认路径）
- 需核对（`assessPolicy` 判定）→ 确认卡分「识别成功 / 待核对 / 识别异常」三组，暖金下划线标 AI 不确定字段

**OCR 后自动同步**：投保人/被保人/受益人 → 补充到家庭成员，写入 `birth_date` + 计算 `age`（统一由 `_shared/calc-age.js` `calcAgeYears` 权威源计算周岁）

**同步去重规则**：投保人=被保人时仅创建一条成员记录；member_id 生成规则为 `mem_{timestamp}_{random6}`；姓名相同但 role 不同视为不同成员。

**OCR 后清理**：识别完成后自动调 `wx.cloud.deleteFile` 清理云存储 temp 图片。

### 4.2 报告生成

| 项目 | 说明 |
|------|------|
| 触发 | 首次 OCR / 编辑保存后静默后台刷新（无 loading） / 对话工具 `triggerAnalysis` 异步触发（30s 节流，失败重试 1 次间隔 2s） |
| AI 产出 | `portrait/review/plan/analysis/summary/conclusion/suggestions`（REPORT_PROMPT 8 模块 + `core_insights`/`activated_dimensions`，字段契约见 `report-fields.js` 单一事实源）（合规审计 P0-1：`disclaimer` 不再由 AI 生成，展示层固定静态模板） |
| 前端聚合 | 数据概览/成员保障/缴费月历/里程碑/保单列表 + 保险常识(静态) |
| 渲染 | `report-markdown` 接收 `chapters[]`，WXML 原生元素逐类型渲染（h1n/h2/h3/table/p/ol/ul） |
| 反馈 | 编辑后 Toast「小秘记下了」，完成后顶部暖金条 3s 淡出 |

#### 报告生成流程

```
triggerAnalysis (对话工具) → conversationAI/_dispatch → cloud.callFunction('reportAI')
→ buildFamilyContext(mode:'report') → AI 生成 → 写 families.last_portrait/last_review/last_plan/last_suggestions
```

**节流**：`families.analysis_lock_at` 持久化（CAS 原子占用防双跑，30s 内重复触发跳过，成功生成后释放），跨冷启动有效。`last_analysis_at` 仅表示上次成功分析时间（供归档 version_at 使用）。

#### 深度分析呈现（reportAI 异步生成，2026-08-30 落地）

深度分析生成后，前端在 hero 结论后、基础版 7 章前插入**深度分析区**（纯展示无操作入口）：

| 段 | 数据源 | 内容 |
|----|--------|------|
| 核心洞察 | `core_insights` | 1-2 个「客户没想到」的洞察卡（高亮） |
| 现有保障点评 | `review` | 逐成员"现有保障管了什么/没管什么/后果" |
| 保障缺口分析 | `analysis` | 根因分析（为何有缺口/对家庭影响/修复优先级） |
| 配置建议 | `plan` | 配置顺序逻辑 + 预算框架 + 逐成员方案 |
| 行动清单 | `suggestions` | 按 `{{URGENT}}/{{NEAR}}/{{MID}}` 占位符替换为【立即/近期/中期】前缀 |

深度分析生成中显示占位，无深度分析时整区隐藏。基础版报告 7 章（数据驱动）另见 chapter-builder.js。

**报告字段**（families 集合，`report-fields.js` 单一事实源）：`last_portrait` / `last_review` / `last_plan` / `last_suggestions` / `last_disclaimer` / `last_analysis` / `last_conclusion` / `last_summary` / `last_core_insights`

#### 深度分析前置检查（readiness 门禁，2026-08 设计）

深度分析为 AI 长任务（烧 token + 30s CAS 节流）。烧 token 前做**确定性规则检查**（非 AI、零成本），必填项缺失则拒绝并返回可跳转修复的清单，建议项缺失允许"跳过提醒"继续。

**架构**：单点门禁——前端**画像确认弹窗**（每次深度分析前弹出，2026-08-30 改造）→ 本地 `evaluateReadiness` 判定（`readiness.js` 经 sync-shared 契约同步前端，与后端同源）→ 画像摘要展示（成员/财务/保障 + 缺口高亮）→ 用户确认属实后才调 `reportAI`；后端 `reportAI` 入口在 `buildFamilyContext` 后、节流检查前仍保留 `422 + readiness 明细` 兜底（数据在弹窗期间被改等边界）。判定数据复用上下文，零额外查询；**不占 CAS 锁**（补全后可立即重试，不被 30s 锁卡住）。

> **活报告模型（2026-09-06）**：自动介入为主（数据变更 → `source:'auto'` 触发，沿用 30s CAS 节流，不设频率上限），手动「立即生成分析」保留为补算入口。BLOCK 收敛为**事实层缺失**（成员/年龄/保单）；**家庭年收入缺失不再 BLOCK**，降 `degraded` 档放行**定性分析**（不含量化额度/预算，见 specs/living-report-20260906/）。待澄清项由 readiness 缺失清单派生落库 `families.pending_clarifications`。

**规则**（BLOCK = 产出会误导 / WARN = 产出降质 / degraded = 降档不阻断）：

| 维度 | BLOCK（必填，无逃生口） | WARN（建议，可跳过） |
|------|------------------------|----------------------|
| 家庭成员 | 无成员；经济支柱（本人/经济支柱）缺可用年龄（birth_date 推导后仍空） | 非支柱成员缺年龄；缺性别/职业/健康 |
| 家庭财务 | —（收入缺失不再 BLOCK，2026-09 降 degraded 放行定性分析） | 家庭收入空且无成员收入可推导（degraded）；收入空但部分成员有收入（弱锚点）；缺负债/固定支出/年度保费预算 |
| 已有保障 | 无有效保单（loadActivePolicies 已滤软删） | 保单缺保额/被保人；状态待确认 |

**前端交互（画像确认，2026-08-30）**：点击深度分析 → **每次先弹画像确认**（显著提示"信息不完整或不真实将严重影响报告质量"）+ 家庭成员列表/财务摘要/保障摘要 + 缺口高亮（BLOCK 红/×、WARN 琥珀/!）→ 按钮：「信息属实，开始分析」（主）/「去补全」（缺口项，复用 edit-sheet mode: member/financials/policy/upload）/「取消」。后端 `422` 兜底时同一容器渲染（`onBlocked` 补齐画像）。补全后再次点击自然重查（无前端状态）。

### 4.3 AI 对话（单通道 v10，2026-08-29 改造）

> **改造动因（SDK 能力边界）**：小程序端 `wx.cloud.extend.AI` 的 streamText/generateText **不支持 tools 参数**（SDK 类型定义无此字段），"流式"与"原生 function calling"在小程序端不可兼得。v9 双通道以"前端流式 + `{TOOL_INTENT}` 文本标识"妥协，代价是 malformed（标识解析畸形）整类缺陷 + A 断言误导 B 不调工具（v9.0-v9.6 五轮修复）。v10 决定**放弃流式，单通道原生 function calling**。

| 项目 | 说明 |
|------|------|
| 入口 | 报告页 FAB 吸底通栏（白底 + 暖金圆按钮） |
| 面板 | 底部滑出 70vh，遮罩覆盖 + scroll-view 自由滚动 |
| 架构 | **单通道 v10**：前端一次调用 `conversationAI mode:'chat'` → 后端原生 function calling 一步到位（理解意图 + 提取参数 + 工具决策 + 生成回复）→ 写入类工具挂确认卡 → 统一持久化 + 审计 |
| 流式 | **已放弃**（SDK 无 tools 的硬约束）；纯问答/工具结果均为完整文本返回，处理中显示"正在处理…"占位 |
| 确认策略 | **保单/新建家庭（addPolicy/updatePolicy/createFamily）→ 前端确认卡（write_confirm）**，确认后二次调用执行；**成员/财务/事实（upsertMember/updateFinances/addFact）→ 默认执行 + 5 分钟撤销**；删除类（delete*）保留 409 挂确认卡；upsertMember 与历史矛盾时 409 覆盖确认 |
| 确认卡 | AI 调用后返回 `pending_confirms`（type:'write_confirm'，含 toolName/payload/summary/target）→ 前端卡片渲染（摘要 + 确认/取消）→ `{CONFIRM:xx}`/`{KEEP:xx}` 拦截二次执行 |
| 降级 | 429 指数退避重试×3 → 仍失败 `generateText`（无工具兜底）→ 兜底文本 |
| 持久化 | **chat 统一持久化** user + assistant 消息（确认卡随 assistant 消息挂载，历史可恢复）；网络/服务硬失败前端经 `dataWrite/writeMessage` 兜底 |
| 历史 | 加载最近 **15 条**（TTL 3 分钟本地缓存，SWR 秒开），换客户自动刷新 |

#### 单通道流程详解

```
前端 → conversationAI { mode: 'chat', familyId, userText, history, sessionId }
后端 → 1. sanitize → PII 脱敏 → 注入检测 → 内容安全 → 限流(60/60s)
       2. 预构建 tool context（CtxCache 30s TTL）→ 意图裁剪工具 schema（filterToolDefs）
       3. 原生 function calling（callChatWithTools，hy3，maxTokens 1200）
       4. 无 tool_calls → 纯问答文本
          有 tool_calls → 分类：
            ├─ 写入类（upsertMember/updateFinances/addPolicy/updatePolicy/createFamily）
            │    → 构造 write_confirm 确认卡返回（不执行）→ 前端确认后 {CONFIRM:xx} 二次调用执行 + 回流
            ├─ addFact → 免确认直接执行 + 回流
            ├─ delete* → dispatch 409 挂确认卡（现状保留）
            └─ query* / triggerAnalysis → 直接执行（查询回流 / trigger 不回流）
       5. 输出审计（禁止承诺 + PII 脱敏）+ 内容安全复核
       6. 统一持久化 user + assistant（确认卡/建议挂 assistant）
       7. 写 agent_logs 审计日志
返回 → { cleanText, suggestions, pending_confirms, toolResults, auditBlocked }
前端 → 渲染 cleanText + 确认卡（pending_confirms）→ 确认/取消按钮
```

#### AI 助理工具能力（14 工具，原生 function calling）

| 工具 | 用途 | 执行模式（v10 确认策略） |
|------|------|---------|
| `upsertMember` | 录入/更新成员属性（姓名/年龄/职业/健康/角色/性别） | **默认执行 + 撤销**（5 分钟内可撤销） |
| `updateFinances` | 录入/更新家庭财务（年收入/负债/固定支出） | **默认执行 + 撤销**（5 分钟内可撤销） |
| `addPolicy` | 录入保单（产品/险种/保额/保费/被保人等） | **前端确认卡**（保单信息） |
| `updatePolicy` | 修改已有保单字段 | **前端确认卡**（保单信息） |
| `createFamily` | 新建客户家庭档案 | **前端确认卡**（家庭结构） |
| `addFact` | 记录事实三元组（**66 谓词**，L1 分类 11 类：关系/保障/人况/经济依赖/风险敞口/现有保障/家庭资产/财富目标/关键时点/投保偏好/法律身份；enum 单一事实源 tools.js） | **免确认直接执行**（facts 写入；低置信度 sug 确认保留） |
| `deletePolicy` | 删除保单（sug 二次确认） | 确认后执行 |
| `deleteMember` | 删除成员（sug 二次确认） | 确认后执行 |
| `deleteFact` | 删除事实（sug 二次确认） | 确认后执行 |
| `queryPolicies` | 查询全量保单（仅上下文缺失时） | 同步 |
| `queryMembers` | 查询全量成员（仅上下文缺失时） | 同步 |
| `queryFacts` | 查询全量事实（可按成员过滤） | 同步 |
| `queryMemberProfile` | 查询单个成员精简画像（基础属性+健康人况+经济依赖+财富目标+保障清单） | 同步 |
| `triggerAnalysis` | 重新生成保障分析报告 | 异步（DB 30s 节流，失败静默重试 1 次） |

**调用机制**：单通道原生 OpenAI function calling（`callChatWithTools`）；工具定义由 `TOOL_DEFINITIONS` 单一事实源注册，dispatch 按 toolName 路由到 dataWrite / dataQuery / reportAI。三类执行模式（tool-orchestration.js 分流）：**① 确认卡类**（addPolicy/updatePolicy/createFamily）在 function calling 阶段**不执行**，构造 `write_confirm` 确认卡；确认后经 `{CONFIRM:xx}` 拦截 → confirm-handler `write_confirm` 策略 dispatch + 回流。**② 默认执行+撤销类**（upsertMember/updateFinances/addFact）直接 dispatch，落 undo_logs 供 5 分钟撤销。**③ 直接执行类**（query*/triggerAnalysis/delete*→409）。

**确认卡结构**：`{ pendingId, action:'CONFIRM', type:'write_confirm', toolName, payload, summary, target }`（summary 为中文参数摘要，前端直接展示）；取消走 `{KEEP:xx}` 保留原值不写入。确认卡随 assistant 消息持久化，历史恢复后可继续交互。

**信息澄清（sug 模式）**：AI 直接输出澄清文本 + 气泡下方建议回复（`suggestions`），用户点击即发送对应文本确认。覆盖三类场景：
- 成员信息矛盾 → "确认覆盖 / 保留原值"
- 删除操作 → "确认删除 / 取消"
- 低置信度事实 → "确认 + 内容摘要"

**提示卡片**：报告底部 2-4 条，从 `analysis` 关键词匹配（重疾/医疗/意外/寿险），点击展开对话并预填问题。

**提示卡片匹配规则**：
- 优先级：重疾 > 寿险（有负债时） > 医疗 > 意外
- 冲突处理：按优先级取前 2-4 条，同类只显示 1 条
- 无匹配兜底：显示「小秘已看完报告，有什么想问问的吗？」

### 4.4 客户管理

- 首次上传自动建档（以投保人命名）
- 首页 N 个最近客户（环形完成度 conic-gradient，client-card 组件内渲染，lib 3.15+；移除 canvas 2d 实例降低列表冷启动开销）
- 客户列表按姓名搜索
- OCR 后自动补充家庭成员（_syncMembersFromPolicies）

### 4.5 产品条款主数据（专家评审 · 手动上传条款，2026-08 定稿）

**定位**：保单分析从"保额维度"升级到"条款维度"。**专家评审 = 完整报告之上再进一层的按需高级功能**：代理人对特定保单**手动上传条款 PDF** → AI 概念化解析 → 代理人人工确认 → 产品主数据入库 → 家庭保单引用复用。一次解析、全局复用（成本按产品摊销）；评审主动触发、成本可控，可作增值付费点。**"人工上传 + 人工确认"构成显式人工介入，契合"8 号文"人工介入渠道要求**；数据源为客户保单自带条款（覆盖停售产品，100% 权威）。

**落地状态（2026-08-29 文档-代码一致性核验）**：建档管道已按**开发者后台 skill 管道**落地（`.codebuddy/skills/product-clause-import`）：官方条款直链下载 → pdf-parse 提取 → AI 概念化（schema-validate 校验 + 概念字典）→ 经 cloudbase MCP 写库。已建档 **8 个在售产品**（4 重疾 + 4 医疗，status=confirmed，source.url 留痕），全部来自官方渠道；数据源比本 PRD 原述多出"官方直链下载"一路。**尚未实现（规划态，下文中 ⏳ 标注）**：小程序端「专家评审」上传入口、productService 云函数、消费端条款注入。

**数据分层**（与 facts 层关系）：
- `products`（产品级主数据）：条款责任 `liability` + 增值服务 `benefits`，一次解析、跨家庭共享
- `facts`（家庭级）：仅存「投保产品」**引用边**（`predicate='投保产品'`、`object_type='product'`、`object_id=product_id`）——**不复制条款内容**，分析时沿边读 products（多跳）。`objectType` 不校验枚举，`'product'` 开箱可用（fact-write.js L102 默认 literal）；`policyToFacts.js` 已有 member→policy 引用边纯函数，扩展 policy→product 边即可
- `policies.product_id`：保单实例关联产品主数据

**触发入口**：⏳ 报告页「专家评审」按钮（深度分析旁）→ 选保单 → 上传条款 PDF → 云存储 → productService 解析。（未实现；当前建档走 skill 管道，见上文落地状态）

**生命周期状态机**（条款格式**统一 PDF**）：

```
报告页选保单 → 上传条款 PDF（wx.chooseMessageFile，extension:['pdf']）
  → upload     云存储落库（关联待建档 product）
  → extract    pdf-parse 提取文本（文本型 PDF）
  → parsing    AI 概念化提取（liability + benefits 同一次产出）
  → confirmed  代理人逐项人工确认（责任 + 权益同卡核对，合规底线：AI 解读必须人工把关）→ 写入 products 复用
  → failed     重试 / 放弃
```

**提取契约（概念字典）**：AI 不"决定"提取什么——概念清单由人工预设（险种类别/保险期间/等待期/重疾种类数/轻症中症/特定疾病额外赔/恶性肿瘤重度额外赔/特药责任/免赔额/报销比例/续保条款/免责要点/增值服务权益[]），AI 从**任意格式**条款中定位填充；未找到输出 `null` 不编造（schema-validate 校验 + 提示词硬约束）；新险种扩展概念字典（`schema_version` 递增，旧档按版本读取、缺失概念回 null）。

**消费端：报告深度分析引用条款**（2026-08 定稿）：（⏳ 以下消费端均未实现，规划态）
- **数据接入**：reportAI 在 buildFamilyContext 后，从 `policies.product_id` 批量读 `products`（仅 `status='confirmed'`）→ 生成「产品条款画像」摘要（每产品 ~200-400 tokens：liability 关键项 + benefits 清单）→ 注入分析上下文。未建档产品不注入，报告标注"条款待补充"（不阻断分析）。token 预算：5 产品 ≈ 1-2K，可控
- **多跳分析**：facts「投保产品」引用边（policy→product_id）→ products.liability/benefits——分析时沿边聚合，不复制条款内容
- **消费形态三处**：① 权益卡（按成员聚合 benefits，**客户版也展示**，中性表述）；② 保障矩阵责任覆盖徽标（含轻症/特药/免赔额，仅代理人版）；③ plan 章节条款差异建议（同险种对比 + 与家庭缺口对齐，仅代理人版）
- **对话消费**：⏳ conversationAI 增 `readProductClause` 工具（读 confirmed products，回答"这个产品保什么/有什么服务"）
- **合规**：注入上下文的条款数据全部来自**人工确认后的 products**，AI 不做条款自由解读；责任差异/对比仅代理人版，客户版只展示权益卡

**解析工程约束**：
- **统一 PDF（文本型）**：条款格式收敛为 PDF 单一入口。`pdf-parse` 云函数可行性为**管道唯一入口依赖——S0 优先 PoC**（包体积 ≤10MB 限制 + 解析正确率）
- **扫描件边界**：pdf-parse 提取为空/过短 → 判定为扫描件 → 明确提示"请上传文本型 PDF"（本版不支持扫描件逐页 OCR，成本收益不成立）
- **条款超长**：数十页（5-10 万 token）超单次 AI 窗口——parsing 按章节分块 → 多轮提取 → 概念聚合，独立 token 预算
- **产品名匹配归一化**：复用 insurer-normalize，同产品异名 → 规范 product_name；低置信度人工确认（防引用错条款）
- **概念缺失闭环**：parsing 输出 unrecognized → 确认卡提示 → 代理人补录 → 概念字典演进（schema_version 递增）

**消费端视图区分**（合规边界）：客户版（isShared）只展示增值服务权益卡（感知价值、中性表述）；条款责任差异与对比**仅代理人版展示**——责任解读不进入客户分享视图。

## 五、UI 设计规范

| 元素 | 规格 |
|------|------|
| 主背景 | `#F5F0EB` |
| 强调色 | `#C9A96E` |
| 深色 | `#1A1A2E` |
| 正文 | `#2D2D2D` / `#8B7355` |
| 圆角 | 卡片 20-24rpx，按钮 16-20rpx |
| 布局 | 紧凑优先 |

**Markdown 样式**（WXML 原生）：一级标题 42rpx 金色数字 + 32rpx 标题 · 二级 28rpx + 左金竖线 · 三级 26rpx · 正文 28rpx · 表格暖金表头 · 统计卡暖金微底

## 六、数据库设计（6 集合架构）

### 核心原则
- **基础层（结构化覆盖更新）**：members / finances / policies
- **推理层（追加更新）**：facts（三元组）
- 结构化数据不走 facts，facts 只存关系与推理结论
- **金额单位契约**：DB 一律存**元**（`annual_income`/`sum_assured`/`annual_premium` 等元键）；前端展示 ≥1 万元时经 `utils/amount.js` `fmtYuan` 转「x.x万」（2 位精度）。权威源 `cloudfunctions/_shared/amount.js`（`yuanToWan`/`wanToYuan`/`fmtYuan`），前端镜像由 sync-shared 同步。禁止 10000× 塌缩/膨胀

### families — 家庭容器
```
_id, _openid, name, status:'active'|'archived',
last_portrait, last_review, last_plan, last_suggestions, last_disclaimer,
last_analysis, last_conclusion, last_summary, last_core_insights,
completeness_score, last_analysis_at, analysis_lock_at, insight_stale, engagement_stage, updated_at
```

### members — 成员主数据
```
_id, family_id, member_id（mem_xxx，join key）, name, role（本人/配偶/子女/父母）, gender, birth_date（YYYY-MM-DD）,
age（冗余，由 birth_date 推导）, occupation, health, income（万元）, status:'active'|'deleted', created_at, updated_at
```
**唯一性**：`member_id` 主键；`name+role` 做 UX 拦挡。

### finances — 财务主数据
```
_id, family_id, annual_income（元）, total_debt（元）, fixed_annual_expense（元）, debt_type, updated_at
```
**唯一索引**：`family_id`

### policies — 保单事实表
```
_id, family_id, member_id, product_name, insurance_category（重疾险/医疗险/意外险/寿险/年金/其他）,
sum_assured（元）, annual_premium（元）, effective_date, expiry_date,
insurer, policy_number, policyholder, status:'active'|'lapsed'|'surrendered'|'claim_terminated'|'cancelled'|'expired'|'suspicious'|'deleted',
status_effective_date, status_reason, confidence, need_review, created_at, updated_at
```
**状态规则（2026-08-30 决策）**：识别/表单入库一律默认 `active`（不做自动判断）；状态仅由用户编辑变更（`updatePolicy`/`changePolicyStatus`），从有效改为失效/退保/理赔终止**必须填写失效日期**（`status_effective_date`）。
**扩展**：新增 `product_id`（关联 products 主数据，可空）。

### products — 产品主数据（2026-08 设计）
```
_id, _openid, product_name, insurer, category,
status:'upload'|'extract'|'parsing'|'confirmed'|'failed',
schema_version:1, liability:{...}, benefits:['...'],
source:{url, fetched_at}, confirm_log:[{field,value,by,at}],
created_at, updated_at
```
- `liability` 为**概念化字段**（公司无关，缺失=null 不编造），`benefits` 为增值服务权益数组
- `source.url` + `confirm_log` 保证每个概念值可回溯（合规审计）
- `_openid` 隔离（个人主体单代理人，产品数据归建档人；多代理人共享为后话）

### facts — 三元组关系表
```
_id, family_id, subject_type:'member'|'family'|'policy', subject_id, subject_name,
predicate（66 谓词 L1/L2 全维度：关系/保障/人况/经济依赖/风险敞口/现有保障/家庭资产/财富目标/关键时点/投保偏好/法律身份；enum 单一事实源 tools.js，策略单一事实源 fact-write.js）,
object_type:'member'|'policy'|'literal', object_id, object_value, object_value_type,
confidence, source:'ocr'|'ai'|'user_form'|'agent_confirmed'|'agent_edit', status:'active'|'superseded',
reasoning, created_at
```

**写入策略**：`FACT_STRATEGIES` 66 谓词全覆盖（dedup 12 + versioned 54），未知谓词默认 dedup 兜底；5 条入口统一经 `addFact` 单点写入。`versioned` 策略自动 supersede 旧事实 → 写入新事实。**facts/policies 更新走 supersede 保留审计轨迹，不物理删除**；例外：`deleteFamily`（整家庭删除）为物理删除——先 batchTx 清空关联集合（policies/facts/messages/operation_logs 等），全部成功后才删除 family 文档（部分失败保留 family 返回 207 可重试）。

**去重策略**：`dedup` 谓词（关系、备注等）按 subject+predicate+object_value 查重，已存在则跳过；`versioned` 谓词（保单字段、个人特征等）先 supersede 旧事实再写入新事实，保留版本历史。

### 其他集合
`messages`(对话) / `agents`(登录) / `agent_logs`(审计) / `operation_logs`(操作日志)

**数据同步**：结构化字段写入 members/finances/policies，自由文本/关系/推理结论写入 facts。保单关联事实由 writePolicy 自动写入 policyToFacts 模块。

## 七、云函数

| 函数 | handlers 数 | 用途 |
|------|-----------|------|
| dataQuery | 8 | listFamilies / searchFamilies / getFamily（报告页详情）/ queryMessages / queryPolicies / queryMembers / queryFacts / queryMemberProfile（queryLogs 已下线） |
| dataWrite | 19 | createFamily / updateFamily / deleteFamily / upsertMember / updateFinances / recordField / updateMember / deleteMember / addFact / updateFactConfidence / deleteFact / writePolicy / writePoliciesBatch / deletePolicy / updatePolicy / changePolicyStatus / writeCashValue / writeMessage / writeOpLog（setStage/submitProfiling 已删） |
| reportAI | 1 | 报告生成（portrait/review/plan/analysis/summary/conclusion/suggestions + core_insights），前端注册名 `generateReport`（apiClient），对话侧由 triggerAnalysis 工具触发（fire-and-forget，DB 30s 节流） |
| ocrService | 2 | ocrOnly（OCR 并发识别）/ aiExtractParallel（AI 提取，DeepSeek 直连，1 张与 N 张统一；aiExtractBatch 已收敛删除）；环境变量含 DEEPSEEK_API_KEY/TENCENT_SECRET_ID/TENCENT_SECRET_KEY（DeepSeek 直连） |
| conversationAI | 2 mode + 14 工具路由 | chat / generateText；_dispatch 按工具定义数组路由 → 复用 dataWrite + dataQuery + reportAI；chat 内置 sug/CONFIRM/KEEP 拦截（确认卡二次执行）；写入类工具（成员/财务/保单/新建家庭）挂 write_confirm 确认卡，addFact 免确认；addFact 工具谓词为自由字符串（非 enum 约束），后端 `FACT_STRATEGIES` 兜底未知谓词为 dedup |
| login | 1 | openid 静默登录（方案 A：个人主体下微信唯一身份即账号，无需手机号授权；writeSeam 建档/更新 agents） |
| productService | 3（规划） | 产品条款主数据·专家评审（2026-08 定稿）：matchProductByName（OCR 产品名匹配 products）/ extractClausePdf（云存储取 PDF + pdf-parse 提取文本，扫描件判定）/ parseProductClause（AI 概念化提取 liability+benefits）；条款统一 PDF 上传，独立超时预算；写入 products，人工确认走 dataWrite.confirmProduct |
| cleanup | 2 mode | prune（生产 TTL 清理，NODE_ENV=production 守卫，cron `daily-log-prune` 每日 3:00，按集合区分时间字段 agent_logs.timestamp/operation_logs.created_at）/ clear（开发全清，需 openid + development） |

## 八、架构决策

| 决策 | 方案 | 理由 |
|------|------|------|
| 数据主集合 | 6 集合（families/members/finances/policies/products/facts） | 基础层 + 推理层 + 产品条款主数据，facts 保留回溯链 |
| AI 范围 | portrait/review/plan/analysis/summary/conclusion/suggestions（+ core_insights） | 数据聚合和静态内容不浪费 token |
| 报告渲染 | WXML 原生元素（逐类型条件渲染） | 避免 rich-text 的 rpx 和 CSS 限制 |
| 对话流式 | **已放弃**（v10 单通道） | SDK 无 tools，流式与原生 function calling 不可兼得；换取 malformed 与断言误导两类缺陷从根消除 |
| 对话持久化 | chat 统一写 user+assistant | 单点持久化，避免双写 |
| 模型分组 | `hunyuan-exp` group + `hy3` model（对话/报告/画像）；**OCR 统一 `aiExtractParallel` DeepSeek 直连**（`deepseek-v4-flash`，并发 2500） | TokenHub 托管资源池 + DeepSeek 直连绕过限流；换模型改 config 一处 |
| 工具执行 | 三类：确认卡（addPolicy/updatePolicy/createFamily）/ 默认执行+撤销（upsertMember/updateFinances/addFact）/ 直接执行（query*/triggerAnalysis） | 写入策略按数据敏感度分流 |
| 降级策略 | 对话后端 function calling 429 指数退避重试（orchestrate withRetry）→ generateText（无工具兜底）→ 兜底文本 | 多级降级保证可用性 |
| 上下文构建 | v2-context.js buildFamilyContext (5 场景: list/conversation/report/tool/analysis) | 统一上下文构建，各云函数共用 |
| 三元组写入 | addFact 单入口，FACT_STRATEGIES 谓词全覆盖 | 5 条产线（OCR/对话/表单/备注/编辑）统一策略 |
| 数据不可变 | facts+policies 更新走 supersede 保留审计轨迹 | 保留审计轨迹；deleteFamily 例外：物理删除（batchTx 清关联 → 删 family） |
| 对话渲染 | 已删除流式节流（v10 无流式，完整文本返回） | 单通道无流式渲染 |
| 定时器管理 | chat-panel detached 生命周期全量清理 | 避免内存泄漏 |
| 年龄计算 | calc-age.js 单一权威源 | 消除 memberRepo/dataQuery/report-builder 三份重复实现 |
| 超时控制 | callCloud Promise.race 30s 默认；对话 60s、OCR AI 提取 70s 显式覆盖 | 前端 timer < 平台超时，避免 race 先拿 timeout 丢真实错误码 |
| 期限解析 | parse-expiry.js 前后端共用权威源（至N岁/至日期/终身/N年/至YYYY） | 消除政策状态判定（calcStatus/时间轴）多份解析实现 |
| 金额单位 | DB 元、展示万，amount.js 契约 | 防 10000× 塌缩/膨胀，前后端镜像同步 |

## 九、优先级

| 模块 | 状态 |
|------|------|
| OCR + 置信度分流 | ✅ 含双源融合+低 birth_date 拦截+temp 清理+部分失败错误保留 |
| 报告（7 章） | ✅ _runReport 失败重试 1 次（章节：家庭结构/家庭财务/保障汇总/缴费月历/关键节点/风险提示/附录保单明细） |
| AI 对话单通道 v10 + 工具能力（14 工具） | ✅ 三类执行模式（确认卡/默认执行+撤销/直接执行），addFact 谓词自由字符串，定时器全清理 |
| 客户管理 + 成员同步 | ✅ |
| 架构统一（共享模块抽取 + 统一上下文） | ✅ sync-shared 闭包同步 |
| 安全设计（注入/限流/审计/脱敏） | ✅ 空 catch 全量加日志；P1 修复（detectInjection 字段/dedup 作用域）已落地 |
| 测试体系（77 套件 / 843 测试） | ✅ 全部通过 |
| 金额单位契约 | ✅ amount.js 权威源，云端 8 处 + 前端 11 处换算收敛 |
| 登录体系（openid） | ✅ login/upsertAgent（openid 静默登录）+ writeSeam 建档/更新 agents；全环境统一，无需手机号授权 |
| 对话单通道 v10 | ✅ 前端一次调用 + 原生 function calling + 写入确认卡（addFact 免确认） |
| 上线审计（四道门） | ✅ 合规/安全/实测/发布四轮核验：隐私协议与 API key 换新为后台必做项，代码侧无阻断 |
| N+1 查询→Promise.all 并行 | ✅ 8 处全部修复 |
| 重复查询消除 | ✅ reportAI/conversationAI 合并并行 |
| 三元组单入口写入 | ✅ 5 条产线统一经 addFact |
| 年龄计算统一 | ✅ calc-age.js 为单一权威源 |
| CSS 工程化 | ✅ OCR 样式去重/间距令牌/--warn token/sk-card 冲突修复 |
| 定时器泄漏 | ✅ chat-panel detached 全清理 |
| 云存储 temp 清理 | ✅ OCR 完成后自动 deleteFile |
| callCloud 超时 | ✅ Promise.race 实现真实超时控制 |
| OCR 收敛（aiExtractBatch 删除，统一 aiExtractParallel） | ✅ 批量提示词已归档清理（2026-09-04），原实现见 git 历史 |
| 深度分析呈现（4 段式 + 行动清单分级） | ✅ hero 后深度分析区 |
| 画像确认（分析前强制核对家庭信息） | ✅ 每次弹 + 本地 readiness 判定 + 后端 422 兜底 |
| 保单状态决策（入库 active，失效需日期） | ✅ status_effective_date 必填校验 |
| 提示词统一（严禁输出项目内部信息） | ✅ 3 处（对话/报告/OCR） |
| 分享 H5/PDF | ⬜ |
| 模拟测算 | ⬜ 待定 |
| US-6 OCR 后自动刷新报告 | ⬜ 暂不实现（用户明确决策） |

## 十、成功指标

| 指标 | 目标 | 测量方法 | 数据源 | 基线 |
|------|------|---------|--------|------|
| 首次出报告用时 | ≤3 分钟 | OCR 完成到 reportAI 返回的端到端时间 | agent_logs.action='report_generate' | 待测 |
| AI 对话使用率 | ≥60% | 打开报告页用户中触发至少 1 次对话的比例 | agent_logs.action='conversation_chat' / 报告页 PV | 待测 |
| 用户次日留存 | ≥30% | 首次使用后次日出现在的用户比例 | agents 集合 + login 日志 | 待测 |
| 工具调用成功率 | ≥95% | 工具执行成功数 / 工具调用总数 | agent_logs.tools[].success | 待测 |
| 流式降级率 | ≤10% | 走 generateText 的次数 / 总对话次数 | agent_logs.action='conversation_generate' | 待测 |

## 十一、安全设计

### 11.1 输入安全

| 防护 | 实现 | 位置 |
|------|------|------|
| 输入清洗 | NFKC 归一化 + 零宽字符过滤 + 长度截断（16K） | `guard.sanitize` |
| 注入检测 | 12 条规则（忽略指令/角色扮演/system prompt 泄露等） + Unicode 同形字符检测（≥3 个触发） | `guard.detectInjection` |
| 字段白名单 | writeFact dimension / updateMember field / updateFinances field 三白名单 | handlers.js |
| 值校验 | age/income 数字校验、gender/role 枚举校验、文本字段长度限制（≤100） | handlers.js |

### 11.2 限流

| 项 | 值 |
|----|-----|
| 窗口 | 60 秒 |
| 上限 | 60 次/openid |
| 计数源 | agent_logs 集合 |
| 超限响应 | `{ allowed: false, reason: '请求过于频繁，请稍后重试' }` |

### 11.3 输出审计

| 拦截类型 | 规则 | 处理 |
|---------|------|------|
| 禁止承诺 | 6 条正则（保证赔付/承诺收益/年化收益率/稳赚保本等） | 整条拦截，返回固定话术 |
| PII 脱敏 | 身份证号/手机号/银行卡号 | 首尾保留 + 中间 `****` |

**实现位置**：`guard.auditOutput`，在 chat 输出阶段执行（orchestrate 返回后、内容安全复核前）。

### 11.4 审计日志

| 集合 | 记录内容 |
|------|---------|
| agent_logs | 每轮对话：openid/familyId/sessionId/action/model/userText(200字)/replyText(800字)/tools[]/metrics/promptVersion；时间字段 `timestamp` |
| operation_logs | OCR/编辑等操作：action/openid/family_id/result{status,summary,error}/meta；时间字段 `created_at` |

### 11.5 登录鉴权与越权防护

| 防护 | 实现 |
|------|------|
| 登录 | `login` openid 静默登录：微信唯一身份即账号（个人主体无法用手机号快速验证组件），writeSeam 建档/更新 agents |
| 越权防护 | 查询/写入全部含 `_openid` 过滤；cleanup 鉴权 + openid 过滤 + NODE_ENV 环境守卫（prune 仅 production，clear 仅 development） |
| OCR fileId IDOR | `ocrService/handlers` 校验 fileId 归属当前 openid 前缀 |
| TTL 清理 | cleanup cron 每日 3:00 按保留期（默认 90 天）删旧日志，生产守卫防误清全量 |

## 十二、错误处理与降级

### 12.1 对话链路降级

```
[chat function calling 失败]
    ↓ 指数退避重试（最多 3 次，429 触发，orchestrate 内置 withRetry）
[chat 仍失败]
    ↓
[conversationAI/generateText]  ← 后端调混元，无工具调用
    ↓（仍失败）
[兜底文本]：「抱歉，小秘遇到了点问题，请重试。」
```

**消息持久化降级**：chat 调用失败时，前端直接调 `dataWrite/writeMessage` 兜底持久化原始文本（无工具/无审计）；前端 60s 超时 ≠ 后端失败（后端可能最终落库），超时场景不补写防双份（P2-3 教训保留）。

### 12.2 OCR 失败

| 失败点 | 处理 |
|--------|------|
| 图片上传失败 | Toast 提示重试 |
| OCR 识别失败 | ocrRecognize 内部重试，仍失败跳过该张（error_code 区分 ocr_service_error/ocr_empty） |
| AI 提取失败 | 按 error_code 映射文案（429/超时/格式/异常），失败卡片保留可重试 |
| 入库失败 | Toast 提示，保留识别结果供重试 |

#### 报告生成与 triggerAnalysis

| 失败点 | 处理 |
|--------|------|
| triggerAnalysis 30s 内重复 | conversationAI DB 节流，返回 `skipped: true` |
| reportAI 失败 | 静默重试 1 次（间隔 2s），仍失败则记录错误不阻塞 |
| AI 返回非 JSON | safeCallChat 兜底纯文本，降级为单段 conclusion |

### 12.4 工具执行失败

| 工具 | 失败处理 |
|------|---------|
| writeFact | 记录到 toolResults.success=false，AI 已告知用户"已记录"（不回滚） |
| updateMember | 同上，且不修改 families 字段 |
| refreshReport | 异步触发，失败不影响对话；前端 onRefreshReport 3s 后拉取，若报告未更新则静默 |
| triggerAnalysis | 同 refreshReport |

## 十三、API 接口规范

### conversationAI

#### mode: chat（单通道主入口，v10）
```js
// 入参
{ mode: 'chat', familyId: string, userText: string, history?: [{role,content}], sessionId?: string }
//   - history: 最近对话历史（≤15 条），AI 决策上下文（确认动作传 []，直接拦截不走 AI）
// 出参
{ code: 200, data: { cleanText: string, suggestions?: string[], pending_confirms?: [{pendingId, action, type, toolName?, payload?, summary?, target?}], toolResults: [{tool,success,result?}], auditBlocked: boolean, userWritten: boolean, assistantWritten: boolean } }
// 语义：一次 function calling 一步到位。
//   - 无 tool_calls → 纯问答文本（cleanText）
//   - 写入类工具（upsertMember/updateFinances/addPolicy/updatePolicy/createFamily）→ 不执行，
//     返回 pending_confirms（type:'write_confirm'）→ 前端确认卡 → {CONFIRM:xx} 二次调用执行
//   - addFact → 免确认直接执行 + 回流
//   - delete* → dispatch 409 挂确认卡（type:'delete_confirm'）
//   - query* / triggerAnalysis → 直接执行
// 确认/取消动作：userText 传 {CONFIRM:pendingId} 或 {KEEP:pendingId}，后端直接拦截执行（不走 AI）
```

#### mode: generateText（降级路径）
```js
// 入参
{ mode: 'generateText', familyId: string, systemPrompt: string, messages: [{role,content}], text: string, sessionId?: string }
// 出参
{ code: 200, data: { content: string, logId: string } }
```

### dataWrite（关键 action）

#### addFact
```js
// 入参
{ action: 'addFact', familyId, subjectName: string, predicate: string, objectValue: string, confidence?: number, reasoning?: string, source?: string }
// 出参
{ code: 200, data: { factId: string } }
// 错误码：400 缺参数；500 写入失败
```

#### writePoliciesBatch
```js
// 入参
{ action: 'writePoliciesBatch', familyId, policies: [{insured_name,product_name,insurance_category,sum_assured,...}] }
// 出参
{ code: 200, data: { written: N, total: N, results: [{policyId, ok}] } }
// 注意：入库后自动调 matchPoliciesToMembers 统一成员匹配；special_agreement 入库前 desensitize
```

#### createFamily
```js
// 入参
{ action: 'createFamily', family_name, members: [{name, role, age?, gender?}] }
// 出参
{ code: 200, data: { _id, family_name, members, family_structure } }
// 错误码：409 同名家庭已存在
```

#### deleteFamily
```js
// 入参
{ action: 'deleteFamily', familyId }
// 出参
{ code: 200, msg: '删除成功' }
// 注意：级联清理 messages/insights/reports/operation_logs/agent_logs；facts+policies → _batchSupersede（保留审计轨迹）
```

### reportAI
```js
// 入参（文档-代码一致性审计修正：原记录 customerId，实际为 familyId）
{ familyId: string, _authOpenid: string }
// 出参（milestones 已移除：report-fields.js 不持久化、前端无消费，契约不再包含）
{ code: 200, data: { portrait, review, plan, suggestions, disclaimer } }
// 前置检查拒绝（深度分析 readiness 门禁，2026-08）：不烧 token、不占 CAS 锁，前端渲染补全清单
{ code: 422, data: { ready: false, blockers: [string], warnings: [string], hasBlockers: bool, dimensions: [{ key, label, status: 'ok'|'warn'|'block', items: [{ label, severity, fix: { mode: 'member'|'financials'|'policy', id?: string } }] }] } }
// 前端注册名：generateReport（apiClient DIRECT_FN，30s 默认超时；深度分析页显式 60s 超时）
// 流程：查 families+policies+members+finances → readiness 门禁（buildFamilyContext 后、节流前，blockers 非空即 422）→ buildFamilyContext(mode:'report') → AI 调用 → 写 families.last_*（成功后释放 analysis_lock_at）
```

### dataQuery（selected）

#### getFamily
```js
// 入参（文档-代码一致性审计修正：对外 action 名 getFamily，原文档误写 queryFamily）
{ action: 'getFamily', familyId, scene?: 'full'|'basic'|'list'|'report'|'insight'|'mark_read' }
// 出参
{ code: 200, data: familyDoc (含 policies[] 列表) }
```

#### queryMessages
```js
// 入参
{ action: 'queryMessages', familyId, mode?: 'latest'|'before', limit?: number, before?: string }
// 出参
{ code: 200, data: { messages: [{role, content, cards, suggestions, pending_confirms, created_at}] } }
```

#### listFamilies / searchFamilies
```js
// 入参（文档-代码一致性审计修正：首页列表 action 名 listFamilies，搜索 searchFamilies，原文档误写 queryHomeList）
{ action: 'listFamilies', limit?: number, before?: string }   // 首页家庭列表（含 agent 信息）
{ action: 'searchFamilies', keyword: string }                 // 按名称搜索（搜索审计 #7：家庭名 + 成员名双路，命中成员名返回所属家庭，软删成员不参与）
// 出参
{ code: 200, data: { agent, families: [{family_name,member_count,completeness_score,...}] } }
```

### 通用错误码

| code | 含义 |
|------|------|
| 200 | 成功 |
| 400 | 参数错误 |
| 401 | 未登录 |
| 404 | 资源不存在 |
| 422 | 前置检查未通过（深度分析 readiness 门禁，data 含明细） |
| 500 | 服务端错误 |

## 十四、性能与成本

### 14.1 响应 SLA

| 操作 | 目标 | 超时处理 |
|------|------|---------|
| chat | ≤5s（纯问答）/ ≤10s（含工具执行+回流） | 前端 60s 超时 + retries:0（对齐 P2-3：超时≠后端失败） |
| generateText | ≤8s | safeCallChat 超时兜底 |
| ocrOnly（单张） | ≤15s | ocrService 平台超时 100s（实测生效）；前端 AI 提取 timer 70s（有意 < 平台，防 race 丢错误码） |
| reportAI | ≤60s | 云函数超时 60s；对话侧 fire-and-forget 不阻塞 |
| conversationAI | ≤60s | 云函数超时 60s；前端对话调用 timer 60s |

### 14.2 Token 限额

| 场景 | 上下文长度 | maxTokens | 备注 |
|------|-----------|-----------|------|
| 对话 chat（工具决策） | system+history ≤8K tokens | 1200 | history 取最近 15 条，每条截断 1500 字；写入类确认卡不执行工具 |
| 对话 chat（结果回流） | 同上 | 800 | 工具执行后回流生成最终回复 |
| generateText | 同上 | 1200 | 同上 |
| reportAI | ≤12K tokens | 2000 | 含家庭数据 + 历史洞察 |
| OCR AI 提取 | ≤4K tokens | 2000 | 单张保单（DeepSeek 直连） |

**月度用户配额**（2026-08 落地，配额审计 P0-2 修订）：`agents.token_used_monthly/token_used_total` 由 ai-gateway 在每次 AI 调用成功后按 total tokens 原子累加（`db.command.inc`）；`_pipelineGuard` 在调用前经 `checkMonthlyQuota` 预检（used ≥ token_monthly_limit → QUOTA_LIMIT 阻断）。DB 不可用/未建档默认放行，累加失败不阻断主流程。单通道（v10）下用量由后端 `safeCallChatWithTools/safeCallChat` 返回的 usage 统一计量（`calcTokenUsage + bumpAgentTokens`），前端无需回传；generateText 降级路径同步计量。

**配额公式与 trial 值**（登录建档默认 `token_monthly_limit: 30000`）：

| 场景 | 典型消耗（tokens） | 依据 |
|------|-------------------|------|
| 一次完整报告 | ~8K（输入 3-8K + 输出 0.8-1.5K） | 家庭数据量中等；上限 12K+2K |
| 一轮对话 | ~5K（system+历史 3-6K + 输出 1.2K） | history 15 条截断 1500 字 |
| 单张保单 OCR | ~3K（≤4K + 2000） | 批量 9 张 ≈ 27K |

trial 30000 ≈ **1 次完整报告 + 4 轮对话 + 2 张保单 OCR**（最低可用体验）。旧值 10000 < 单次 reportAI 上下文上限 12K——新用户首次完整报告即触发 QUOTA_LIMIT，配置即劝退，故上调。

**月成本模型**（hy3-preview $0.004/1K tokens，config.COST_PER_1K）：单用户满载 30000 ≈ **$0.12/月**；100 活跃用户 ≈ $12/月。成本上限与配额同构，可作为商业化定价下限依据。

### 14.3 上下文长度控制

**对话上下文构建**（v2-context.js buildFamilyContext mode:'conversation'）：
1. 经济状况表（家庭级年收入/负债）
2. **家庭画像**（`buildPortrait(members, facts)` 聚合全部 active facts → 精简 Markdown）——facts 以画像形式注入，非原始三元组回流，记忆语义全保留且上下文不膨胀
3. 报告结论带标签注入：`## 报告结论（上次检视，回答缺口类问题可引用）`（`family.last_conclusion`）
4. tool 场景（chat 工具上下文）额外注入：原始成员表（冲突检测用）+ `## 报告结论（供引用，禁止照抄）`（last_summary + last_conclusion）
5. **工具 schema 意图裁剪**（token 成本审计 P2）：chat 不每轮注入全部 14 工具 schema（固定 9-12K tokens），按关键词裁剪——4 个查询工具常驻（queryPolicies/queryMembers/queryFacts/queryMemberProfile），写/管理工具按意图关键词追加；意图无法判断或用户明确"全部"时回退全量（保能力优先）
6. **规则预提取提示**（tool-orchestration）：policyFactSplitter 对用户文本做规则级保障/事实预提取（confidence 0.9），作为 `coverageHint` 注入 AI 决策参考（仅供 addFact 确认后写入，不直接照抄）

**对话历史窗口**：最近 **15 条**消息，每条截断 1500 字，超出由模型自行摘要。

### 14.4 缓存策略

| 缓存 | 位置 | TTL | 失效条件 |
|------|------|-----|---------|
| 对话上下文（tool context） | 后端 CtxCache | 30min（TOOL_CTX_TTL） | 写工具后仅失效 state 块（保 DeepSeek context caching 前缀命中）；query 缓存按 familyId+openid 前缀失效 |
| OCR 识别结果 | - | 不缓存 | - |
| 报告内容 | families 集合 | 持久 | 编辑/refreshReport 触发更新 |


