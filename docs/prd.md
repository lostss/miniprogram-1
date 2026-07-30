# 保小秘 —— 产品需求文档

> **上传保单，秒出报告**
> ——把复杂度留给自己，把简单交给用户。

---

## 一、产品概述

**保小秘** 面向保险代理人，拍照上传保单 → AI 生成家庭保障分析 → 对话追问。全链路云函数 + 微信 API。

**核心原则**：把操作留给后台，把结论留给用户。

## 二、技术架构

```
小程序前端（原生 WeChat）
├── wx.cloud.extend.AI（真流式对话，前端直连混元）
└── 云函数（OCR / 报告 / 对话 / 数据管理）
    ├── 云数据库（NoSQL: families / members / finances / policies / facts / messages 等）
    └── 云存储（保单图片 jpg, 压缩 65%）
```

**数据主集合**：`families/members/finances/policies/facts`（5 集合）

**共享模块层**：ai-gateway.js / guard.js / v2-context.js / context-builder.js / dbAdapter / ocr-core / ocr-extractor / ocr-confidence / member-matcher / completeness / member-dimensions / stageMachine / conversationAgent 等。通过 `scripts/sync-shared.js` 自动发现 + 同步到各云函数。

### 端到端数据流

```
[拍照] → ocrService/ocrSingle → [置信度分流]
                                      ├─ ≥0.95 自动入库 ─┐
                                      └─ <0.95 用户确认 ─┘
                                                ↓
                        dataWrite/writePoliciesBatch + matchPoliciesToMembers(成员匹配)
                                                ↓
                        reportAI（生成 portrait/review/plan/suggestions）
                                                ↓
                              [报告页渲染] ← dataQuery/getCustomer
                                                ↓
                              [用户追问] → chat-panel 三步流程
                                                ↓
                  1. conversationAI/getPrompt（缓存 5min）
                  2. wx.cloud.extend.AI.streamText（前端直连，含指数退避重试）
                  3. conversationAI/postProcess（工具+审计+sug确认+持久化）
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
| 输入 | 拍照/相册，最多 9 张，`compressImage(quality:65)` 预处理 |
| 分批 | 每批 5 张并发 |
| 字段 | 保单号、保险公司、生效日期、投保人、被保人、产品名、险种分类、保额、保费、缴费期、保障期、受益人、出生日期 |

**置信度分流**：
- 全部 ≥ 0.95 → 自动入库，直接跳报告
- 存在 < 0.95 → 弹确认卡，暖金下划线标 AI 不确定字段，双按钮「确认」「修改」

**OCR 后自动同步**：投保人/被保人/受益人 → 补充到家庭成员，写入 `birth_date` + 计算 `age`（统一由 `_shared/calc-age.js` `calcAgeYears` 权威源计算周岁）

**同步去重规则**：投保人=被保人时仅创建一条成员记录；member_id 生成规则为 `mem_{timestamp}_{random6}`；姓名相同但 role 不同视为不同成员。

**OCR 后清理**：识别完成后自动调 `wx.cloud.deleteFile` 清理云存储 temp 图片。

### 4.2 报告生成

| 项目 | 说明 |
|------|------|
| 触发 | 首次 OCR / 编辑保存后静默后台刷新（无 loading） / 对话工具 `triggerAnalysis` 异步触发（60s 节流，失败重试 1 次间隔 2s） |
| AI 产出 | `conclusion`(纯文本) + `analysis`(Markdown) + `suggestions`(Markdown) + `disclaimer` |
| 前端聚合 | 数据概览/成员保障/缴费月历/里程碑/保单列表 + 保险常识(静态) |
| 渲染 | `report-markdown` 接收 `chapters[]`，WXML 原生元素逐类型渲染（h1n/h2/h3/table/p/ol/ul） |
| 反馈 | 编辑后 Toast「小秘记下了」，完成后顶部暖金条 3s 淡出 |

#### 报告生成流程

```
triggerAnalysis (对话工具) → conversationAI/_dispatch → cloud.callFunction('reportAI')
→ buildFamilyContext(mode:'report') → AI 生成 → 写 families.last_portrait/last_review/last_plan/last_suggestions
```

**节流**：`families.last_analysis_at` 持久化，60s 内重复触发跳过，跨冷启动有效。

#### 报告 5 章（结构化缺口矩阵 + AI 叙事）

| # | 标题 | key | 内容 | 来源 |
|---|------|-----|------|------|
| 1 | 家庭画像 | portrait | 家庭结构/经济特征/保障角色分工，千人千面 | **AI** |
| 2 | 现有保障点评 | review | 保障覆盖矩阵（成员×险种，充足/不足/缺失）+ AI 先总后分点评（好处+问题） | 矩阵：前端聚合 / 点评：**AI** |
| 3 | 保障规划 | plan | 缺口矩阵（成员×险种，缺口额+可信度：confirmed/estimated/blocked）+ AI 规划（展示分析过程：需求怎么算→现有多少→缺口多少→建议补什么） | 缺口矩阵：前端聚合 / 规划：**AI** |
| 4 | 行动建议 | suggestions | 补数据+补保障建议（做什么→不做后果→优先级依据） | **AI** |
| 5 | 附录 | appendix | 保障关键时点（时间轴）+ 缴费月历 + 过期保单 + 保单列表 + 引用说明 + 术语 + 免责 | 前端聚合 |

**报告字段**（families 集合）：`last_portrait` / `last_review` / `last_plan` / `last_suggestions` / `last_milestones` / `last_disclaimer`

### 4.3 AI 对话（三步流程架构）

| 项目 | 说明 |
|------|------|
| 入口 | 报告页 FAB 吸底通栏（白底 + 暖金圆按钮） |
| 面板 | 底部滑出 70vh，遮罩覆盖 + scroll-view 自由滚动 |
| 架构 | **三步流程**：getPrompt（缓存） → streamText（前端直连混元） → postProcess（后端工具+审计+持久化） |
| 流式技术 | `wx.cloud.extend.AI.createModel('cloudbase').streamText({模型: hy3})`，前端 setData 100ms 节流，定时器 detached 全清理 |
| 流式重试 | 429/超时 → 指数退避重试（最多 2 次：1s→2s→4s）→ 仍失败则降级 |
| 降级路径 | 流式失败 → `conversationAI/generateText`（无工具调用）→ 兜底文本 |
| 持久化 | **postProcess 统一持久化** user + assistant 消息 |
| 历史 | 加载最近 **20 条**，换客户自动刷新 |

#### 三步流程详解

```
步骤 1：getPrompt（5min 缓存）
  前端 → conversationAI { mode: 'getPrompt', familyId }
  后端 → 构建 systemPrompt + 精简上下文（含报告内容、家庭成员、保单）
  缓存 → 前端缓存 5 分钟，切换客户清缓存

步骤 2：streamText（前端直连混元）
  前端 → wx.cloud.extend.AI.streamText
  流式 → onText 逐字渲染，onFinish 完成
  失败 → 自动降级到 conversationAI/generateText

步骤 3：postProcess（关键）
  前端 → conversationAI { mode: 'postProcess', familyId, userText, text, sessionId }
  后端 → 1. 输出审计（禁止承诺 + PII 脱敏）
         2. 原生 function calling（工具定义由 _TOOL_DEFINITIONS 数组注册）
         3. 执行工具（同步写库/异步报告），结果回传 AI 生成最终回复
         4. 检测待确认项 → 生成 suggestions + pending_confirms（sug 模式）
         5. 清理标记
         6. 统一持久化 user + assistant 消息（含 suggestions）
         7. 写 agent_logs 审计日志
  返回 → { cleanText, cards, suggestions, pending_confirms, toolResults, auditBlocked }
```

#### AI 助理工具能力（13 工具，原生 function calling）

| 工具 | 用途 | 执行模式 |
|------|------|---------|
| `upsertMember` | 录入/更新成员属性（姓名/年龄/职业/健康/角色/性别） | 同步，冲突时 sug 确认 |
| `updateFinances` | 录入/更新家庭财务（年收入/负债/固定支出） | 同步 |
| `addPolicy` | 录入保单（产品/险种/保额/保费/被保人等） | 同步 |
| `addFact` | 记录事实三元组（26 谓词：配偶/子女/父母/拥有保障/公司提供保障/职业/个人年收入/健康异常/负债/持有资产/未来计划/有偏好/有特征/备注/保额/年缴保费/险种/生效日/承保公司/保障期间/缴费期/缴费方式/特殊条款/固定支出/年保费预算/保单号/投保） | 同步（经 addFact 统一入口：dedup/versioned/syncFactToMember），低置信度 sug 确认 |
| `updatePolicy` | 修改已有保单字段 | 同步 |
| `deletePolicy` | 删除保单（sug 二次确认） | 确认后执行 |
| `deleteMember` | 删除成员（sug 二次确认） | 确认后执行 |
| `deleteFact` | 删除事实（sug 二次确认） | 确认后执行 |
| `queryPolicies` | 查询全量保单（仅上下文缺失时） | 同步 |
| `queryMembers` | 查询全量成员（仅上下文缺失时） | 同步 |
| `queryFacts` | 查询全量事实（可按成员过滤） | 同步 |
| `triggerAnalysis` | 重新生成保障分析报告 | 异步（DB 60s 节流，失败静默重试 1 次） |
| `createFamily` | 新建客户家庭档案 | 同步 |

**调用机制**：原生 OpenAI function calling（`callChatWithTools`），非文本 `[TOOL]` 标记解析。工具定义由 `_TOOL_DEFINITIONS` 数组注册，dispatch 按 toolName 路由到 dataWrite / dataQuery / reportAI。

**信息澄清（sug 模式）**：不再使用内联 `[CARD]` 标记卡片。AI 直接输出澄清文本 + 气泡下方建议回复（`suggestions`），用户点击即发送对应文本确认。覆盖三类场景：
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
- 首页 N 个最近客户（环形完成度 canvas，client-card 组件内渲染）
- 客户列表按姓名搜索
- OCR 后自动补充家庭成员（_syncMembersFromPolicies）

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

## 六、数据库设计（5 集合架构）

### 核心原则
- **基础层（结构化覆盖更新）**：members / finances / policies
- **推理层（追加更新）**：facts（三元组）
- 结构化数据不走 facts，facts 只存关系与推理结论

### families — 家庭容器
```
_id, _openid, name, status:'active'|'archived',
last_portrait, last_review, last_plan, last_suggestions, last_disclaimer, last_milestones,
completeness_score, last_analysis_at, insight_stale, engagement_stage, updated_at
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
insurer, policy_number, policyholder, status:'active'|'expired'|'cancelled',
confidence, need_review, created_at, updated_at
```

### facts — 三元组关系表
```
_id, family_id, subject_type:'member'|'family'|'policy', subject_id, subject_name,
predicate（26 谓词全量：配偶/子女/父母/拥有保障/公司提供保障/职业/个人年收入/健康异常/负债/持有资产/未来计划/有偏好/有特征/备注/保额/年缴保费/险种/生效日/承保公司/保障期间/缴费期/缴费方式/特殊条款/固定支出/年保费预算/保单号/投保）,
object_type:'member'|'policy'|'literal', object_id, object_value, object_value_type,
confidence, source:'ocr'|'ai'|'user_form'|'agent_confirmed'|'agent_edit', status:'active'|'superseded',
reasoning, created_at
```

**写入策略**：`FACT_STRATEGIES` 26 谓词全覆盖（dedup 9 + versioned 17），5 条入口统一经 `addFact` 单点写入。`versioned` 策略自动 supersede 旧事实 → 写入新事实。**零物理删除**（包括 `deleteFamily`）——全部标记 `superseded` 保留审计轨迹。

**去重策略**：`dedup` 谓词（关系、备注等）按 subject+predicate+object_value 查重，已存在则跳过；`versioned` 谓词（保单字段、个人特征等）先 supersede 旧事实再写入新事实，保留版本历史。

### 其他集合
`messages`(对话) / `agents`(登录) / `agent_logs`(审计) / `operation_logs`(操作日志)

**数据同步**：结构化字段写入 members/finances/policies，自由文本/关系/推理结论写入 facts。保单关联事实由 writePolicy 自动写入 policyToFacts 模块。

## 七、云函数

| 函数 | handlers 数 | 用途 |
|------|-----------|------|
| dataQuery | 14 | queryFamily/queryMessages/queryHomeList/queryBrief/queryInsight/markRead/queryFacts/queryPolicies/queryMembers/queryFamiliesForMatch/readMemory/getCustomer/listCustomers/searchCustomers |
| dataWrite | 18 | recordField/writeNote/updateMember/writePolicy/writePoliciesBatch/addFact/updateFactConfidence/deletePolicy/deleteMember/updatePolicy/deleteFact/createFamily/updateFamily/deleteFamily/writeMessage/writeOpLog/setStage/submitProfiling |
| reportAI | 1 | 报告生成（portrait/review/plan/suggestions/milestones/disclaimer），由 conversationAI 的 triggerAnalysis 工具触发 |
| ocrService | 2 | ocrSingle（单图同步）/ matchPolicies |
| conversationAI | 3 mode + 13 工具路由 | getPrompt / generateText / postProcess；_dispatch 按工具定义数组路由 → 复用 dataWrite + dataQuery + reportAI；postProcess 内置 sug 确认拦截；addFact 工具谓词为自由字符串（非 enum 约束），后端 `FACT_STRATEGIES` 兜底未知谓词为 dedup |
| login | 1 | 手机号登录；dev 登录仅限非 prod 环境 |

## 八、架构决策

| 决策 | 方案 | 理由 |
|------|------|------|
| 数据主集合 | 5 集合（families/members/finances/policies/facts） | 基础层 + 推理层，facts 保留回溯链 |
| AI 范围 | portrait/review/plan/suggestions | 数据聚合和静态内容不浪费 token |
| 报告渲染 | WXML 原生元素（逐类型条件渲染） | 避免 rich-text 的 rpx 和 CSS 限制 |
| 对话流式 | `wx.cloud.extend.AI.streamText` 前端直连 | 真流式零依赖；工具能力通过 postProcess 补回 |
| 对话持久化 | postProcess 统一写 user+assistant | 单点持久化，避免双写 |
| 模型分组 | `cloudbase` group + `hy3` model | TokenHub 托管资源池，换模型改一处常量 |
| 工具执行 | 同步（writeFact/updateMember/updateFinances）/ 异步（refreshReport/triggerAnalysis） | 长耗时工具异步避免阻塞对话 |
| 降级策略 | 流式重试(指数退避×2: 1s→2s→4s) → generateText → 兜底文本 | 三级降级保证可用性 |
| 上下文构建 | v2-context.js buildFamilyContext (3 模式: conversation/report/analysis) | 统一上下文构建，各云函数共用 |
| 三元组写入 | addFact 单入口，FACT_STRATEGIES 26 谓词全覆盖 | 5 条产线（OCR/对话/表单/备注/编辑）统一策略 |
| 数据不可变 | facts+policies 全量 supersede 无物理删除 | 保留审计轨迹，deleteFamily 同步 |
| 流式节流 | chat-panel setData 100ms 节流 + scrollToBottom 合并 | 减少 UI 线程阻塞，提升流式体验 |
| 定时器管理 | chat-panel detached 生命周期全量清理 | 避免内存泄漏 |
| 年龄计算 | calc-age.js 单一权威源 | 消除 memberRepo/dataQuery/report-builder 三份重复实现 |
| 超时控制 | callCloud Promise.race 30s | 从形同虚设改为生效 |

## 九、优先级

| 模块 | 状态 |
|------|------|
| OCR + 置信度分流 | ✅ 含双源融合+低 birth_date 拦截+temp 清理+部分失败错误保留 |
| 报告（4 章 8 子节） | ✅ _runReport 失败重试 1 次 |
| AI 对话三步流程 + 工具能力（13 工具） | ✅ addFact 谓词自由字符串，100ms 流式节流，定时器全清理 |
| 客户管理 + 成员同步 | ✅ |
| 架构统一（共享模块抽取 + 统一上下文） | ✅ |
| 安全设计（注入/限流/审计/脱敏） | ✅ 空 catch 全量加日志 |
| 测试体系（35 套件 / 261 测试） | ✅ 全部通过 |
| N+1 查询→Promise.all 并行 | ✅ 8 处全部修复 |
| 重复查询消除 | ✅ reportAI/conversationAI 合并并行 |
| 三元组单入口写入 | ✅ 5 条产线统一经 addFact |
| 年龄计算统一 | ✅ calc-age.js 为单一权威源 |
| CSS 工程化 | ✅ OCR 样式去重/间距令牌/--warn token/sk-card 冲突修复 |
| 定时器泄漏 | ✅ chat-panel detached 全清理 |
| 云存储 temp 清理 | ✅ OCR 完成后自动 deleteFile |
| callCloud 超时 | ✅ Promise.race 实现真实超时控制 |
| 分享 H5/PDF | ⬜ |
| 模拟测算 | ⬜ 待定 |
| US-6 OCR 后自动刷新报告 | ⬜ 暂不实现（用户明确决策） |

## 十、成功指标

| 指标 | 目标 | 测量方法 | 数据源 | 基线 |
|------|------|---------|--------|------|
| 首次出报告用时 | ≤3 分钟 | OCR 完成到 reportAI 返回的端到端时间 | agent_logs.action='report_generate' | 待测 |
| AI 对话使用率 | ≥60% | 打开报告页用户中触发至少 1 次对话的比例 | agent_logs.action='conversation_postprocess' / 报告页 PV | 待测 |
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

**实现位置**：`guard.auditOutput`，在 postProcess 第 1 步执行。

### 11.4 审计日志

| 集合 | 记录内容 |
|------|---------|
| agent_logs | 每轮对话：openid/familyId/sessionId/action/model/userText(200字)/replyText(800字)/tools[]/metrics/promptVersion |
| operation_logs | OCR/编辑等操作：action/openid/family_id/result{status,summary,error}/meta |

## 十二、错误处理与降级

### 12.1 对话链路降级

```
[streamText 失败]
    ↓ 指数退避重试（最多 2 次，429/超时触发）
[streamText 仍失败]
    ↓
[conversationAI/generateText]  ← 后端调混元，无工具调用
    ↓（仍失败）
[兜底文本]：「抱歉，小秘遇到了点问题，请重试。」
```

**消息持久化降级**：postProcess 失败时，前端直接调 `dataWrite/writeMessage` 兜底持久化原始文本（无工具/无审计）。

### 12.2 OCR 失败

| 失败点 | 处理 |
|--------|------|
| 图片上传失败 | Toast 提示重试 |
| OCR 识别失败 | aiRetryIfFailed 重试 1 次，仍失败则跳过该张 |
| AI 提取失败 | 返回原始 OCR 文本，confidence=0.5，强制走确认卡 |
| 入库失败 | Toast 提示，保留识别结果供重试 |

#### 报告生成与 triggerAnalysis

| 失败点 | 处理 |
|--------|------|
| triggerAnalysis 60s 内重复 | conversationAI DB 节流，返回 `skipped: true` |
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

#### mode: getPrompt
```js
// 入参
{ mode: 'getPrompt', familyId: string }
// 出参
{ code: 200, data: { systemPrompt: string, context: string, promptVersion: string } }
```

#### mode: generateText
```js
// 入参
{ mode: 'generateText', familyId: string, systemPrompt: string, messages: [{role,content}], text: string, sessionId?: string }
// 出参
{ code: 200, data: { content: string, logId: string } }
```

#### mode: postProcess
```js
// 入参
{ mode: 'postProcess', familyId: string, userText: string, text: string, sessionId?: string }
// 出参
{ code: 200, data: { cleanText: string, cards?: [], suggestions?: string[], pending_confirms?: [], toolResults: [{tool,success,result?}], auditBlocked: boolean, userWritten: boolean, assistantWritten: boolean } }
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
// 入参
{ customerId: string }
// 出参
{ code: 200, data: { portrait, review, plan, suggestions, milestones, disclaimer } }
// 流程：查 families+policies+members+finances → buildFamilyContext(mode:'report') → AI 调用 → 写 families.last_*
```

### dataQuery（selected）

#### queryFamily
```js
// 入参
{ action: 'queryFamily', familyId, scene?: 'full'|'basic'|'list'|'report'|'insight'|'mark_read' }
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

#### queryHomeList
```js
// 入参
{ action: 'queryHomeList', limit?: number, before?: string }
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
| 500 | 服务端错误 |

## 十四、性能与成本

### 14.1 响应 SLA

| 操作 | 目标 | 超时处理 |
|------|------|---------|
| getPrompt | ≤800ms（含上下文构建） | 前端用兜底 prompt |
| streamText 首字 | ≤1.5s | 用户感知不到延迟 |
| generateText | ≤8s | safeCallChat 55s 超时 |
| postProcess | ≤2s（无工具）/ ≤5s（含同步工具） | 前端兜底持久化 |
| ocrSingle（单张） | ≤15s | 重试 1 次 |
| reportAI | ≤30s | 后台重试 |

### 14.2 Token 限额

| 场景 | 上下文长度 | maxTokens | 备注 |
|------|-----------|-----------|------|
| 对话 streamText | system+history ≤8K tokens | 1200 | history 取最近 20 条，每条截断 1500 字 |
| generateText | 同上 | 1200 | 同上 |
| reportAI | ≤12K tokens | 2000 | 含家庭数据 + 历史洞察 |
| OCR AI 提取 | ≤4K tokens | 800 | 单张保单 |

### 14.3 上下文长度控制

**对话上下文构建**（v2-context.js buildFamilyContext mode:'conversation'）：
1. 报告内容：conclusion(500字) + analysis(2500字) + suggestions(800字) = ~3800字
2. 家庭成员：精简字段（memberId/name/role/age/gender/health/occupation），表格形式
3. 保单：最多 20 条，精简字段
4. **不加载 facts 表**（避免上下文膨胀）

**对话历史窗口**：最近 **20 条**消息，每条截断 1500 字，超出由模型自行摘要。

### 14.4 缓存策略

| 缓存 | 位置 | TTL | 失效条件 |
|------|------|-----|---------|
| systemPrompt + 上下文 | 前端 chat-panel | 5 分钟 | 切换客户 / 手动清缓存 |
| OCR 识别结果 | - | 不缓存 | - |
| 报告内容 | families 集合 | 持久 | 编辑/refreshReport 触发更新 |


