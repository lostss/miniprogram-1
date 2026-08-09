# 对话记忆审计报告

> 审计时间：2026-08-08
> 审计范围：conversationAI 家庭记忆全链路（长期记忆 / 工作上下文 / 对话窗口 / 跨会话记忆）
> 审计依据：[CtxCache](../../cloudfunctions/conversationAI/ctx-cache.js)、[v2-context](../../cloudfunctions/conversationAI/_shared/v2-context.js)、[familyPortrait](../../cloudfunctions/conversationAI/_shared/familyPortrait.js)、[chat-panel](../../miniprogram/components/chat-panel/index.js)、[prompt-cache](../../miniprogram/utils/prompt-cache.js)、[history-store](../../miniprogram/utils/history-store.js)、[chat-source](../../miniprogram/utils/chat-source.js)

---

## 一、记忆架构概览

### 三层记忆模型

```
┌─────────────────────────────────────────────────┐
│ 长期记忆 · facts 知识图谱                         │
│ 持久化：facts 集合                                │
│ 职责：存储"是什么"事实和"想要什么"意图             │
│ 机制：versioned supersede / source 优先级 /        │
│       agent_confirmed 防覆盖 / 时间衰减            │
└─────────────────────────────────────────────────┘
                       ↑
┌─────────────────────────────────────────────────┐
│ 工作上下文 · CtxCache + v2-context                │
│ 持久化：内存（云函数实例级）                       │
│ 职责：每次对话时构建"当前家庭快照"                 │
│ 机制：buildFamilyContext('tool'/'conversation') +  │
│       CtxCache 5s TTL + LRU 20 条                 │
└─────────────────────────────────────────────────┘
                       ↑
┌─────────────────────────────────────────────────┐
│ 对话窗口 · messages + 前端截断                     │
│ 持久化：messages 集合（分页可查）                  │
│ 职责：短期对话历史                                 │
│ 机制：history-store 分页加载 +                     │
│       chat-panel slice(-15) + 1500 字符截断        │
└─────────────────────────────────────────────────┘
                       ↑
┌─────────────────────────────────────────────────┐
│ 跨会话记忆 · ❌ 缺失                               │
│ 持久化：无                                         │
│ 职责：用户跨天回来时"上次聊到哪"的上下文            │
└─────────────────────────────────────────────────┘
```

### 数据流链路

```
用户输入
  ↓
chat-panel.onSend
  ↓
prompt-cache.get(familyId)
  → 调 conversationAI(mode='getPrompt')
  → buildV2Context(db, familyId, openid, 'conversation')
  → 注入：画像 compact + 经济表 + 上次结论
  ↓
streamText（前端直连混元）
  ↓
若有工具意图 → postProcess
  → _buildToolContext(familyId, openid)
  → buildV2Context(db, familyId, openid, 'tool')
  → 注入：画像 + 成员表 + 财务表 + 报告结论 + 保单清单
  → CtxCache 5s 缓存
  ↓
orchestrate → 工具执行 → 结果回流（部分）→ 最终回复
  ↓
持久化到 messages 集合
```

---

## 二、各层审计

### ① 长期记忆 · facts 知识图谱

**评分：A-**

#### 已实现（设计亮点）

| 能力 | 实现位置 | 机制 |
|------|---------|------|
| 持久化 | facts 集合 | 谓词 enum 强约束（67个 L1 + L2 兜底） |
| 版本管理 | fact-write.js | versioned supersede：同 subject+predicate 旧 fact 标记 superseded |
| 冲突处理 | familyPortrait.js `_resolveOne` | 置信度优先，平手按 source 优先级（ocr > agent_confirmed > user_form > conversation） |
| 防覆盖 | fact-write.js | agent_confirmed 事实不被非 agent_confirmed 事实 supersede |
| 时间衰减 | familyPortrait.js `_decayedConfidence` | 超 DECAY_MONTHS 未更新且非 agent_confirmed → 降一级参与聚合（只读计算，不写回） |
| 孤儿保障降级 | familyPortrait.js | 对话补充保单无 policy 节点 → 降级为待确认 |
| 争议标记 | familyPortrait.js `_resolveOne` | 同 subject+predicate 多值 → disputed:true |

#### 缺口

| 级别 | 问题 | 影响 | 建议 |
|------|------|------|------|
| P1 | **缺失"认知校准"机制** | 用户更正"不对，我年收入是30万"时，旧 fact 被 supersede 但 AI 不显式确认"已更正（原20万→新30万）"，用户不知道旧记忆被替换 | supersede 时让 AI 回复"已更新（原：X → 新：Y）" |
| P1 | **采集时间戳未反馈** | 长对话中用户重复提供相同信息时，AI 无法回答"这条是您3月5日说的" | portrait 渲染时附 source 时间 |

---

### ② 工作上下文 · CtxCache + v2-context

**评分：B**

#### conversation 场景（流式阶段）注入的信息

| 段 | 来源 | 内容 |
|----|------|------|
| 标题 | v2-context.js:142 | `# 家庭保障档案` |
| 上次结论 | v2-context.js:143 | `> {family.last_conclusion}`（如有） |
| 经济状况表 | v2-context.js:146-147 | 年收入/总负债/固定支出/负债类型 |
| 家庭保障画像（compact） | familyPortrait.js | 每个成员的职业/健康/收入/负债/资产/保障覆盖（8类险种:有/缺/待确认）+ **保单摘要（本次修复新增）** |

#### tool 场景（postProcess 阶段）注入的信息

| 段 | 来源 | 内容 |
|----|------|------|
| 画像 compact | v2-context.js:194-196 | 同上 |
| 成员数据表（冲突检测用） | v2-context.js:199-200 | memberId/姓名/角色/年龄/性别/健康/职业/个人年收入 |
| 报告结论（供引用，禁止照抄） | v2-context.js:202-207 | last_summary + last_conclusion |
| 保单清单（定位用） | index.js:178-181 | buildPolicyTable + AI_LOCATOR_COLUMNS（updatePolicy/deletePolicy 定位用） |

#### CtxCache 配置

| 配置项 | 值 | 评估 |
|--------|-----|------|
| TTL | 5 秒 | ⚠️ 偏短，连续追问重复重建上下文 |
| maxSize | 20 条 | ✅ 合理 |
| 隔离维度 | familyId + openid | ✅ 多租户正确隔离 |
| 失效策略 | 仅 TTL 自然过期 | ❌ 写后不主动失效（P0） |
| LRU 实现 | Map 命中即刷新到队尾 | ✅ 真 LRU（已修复 FIFO 问题） |

#### 缺口

| 级别 | 问题 | 影响 | 建议 |
|------|------|------|------|
| **P0** | **写入后缓存不主动失效** | addFact/writePolicy 成功后，5s 内 CtxCache 仍持有旧画像。用户"刚说完年收入30万"立即问"我年收入多少"，AI 可能答"20万"（旧缓存） | 写工具成功后调 `_ctxCache.invalidate(familyId+openid)` |
| **P0** | **compact 画像缺保单明细（本次已修复）** | AI 流式阶段只看到"寿险:有 重疾险:缺"，看不到保单名称/保额/状态，无法回答"我家有什么保单" | ✅ 已修复：compact 模式追加保单摘要行 |
| P1 | **conversation 场景缺意图类字段** | v2-context 的 conversation 分支只注入 portrait + finance，未注入"传承意图/资产隔离/教育规划"等 L1 新增谓词。familyPortrait 的 extraInfo 只认"未来计划/有特征/有偏好"三个旧谓词，新谓词变孤儿 | 扩展 extraInfo 白名单或按维度归组 |
| P1 | **无 token 长度控制** | v2-context 注入全量画像 + 全量 facts，大家庭（5+成员/10+保单）可能超 8K token | 按成员数动态裁剪 compact 模式 |
| P1 | **5s TTL 偏短** | 连续追问场景（10秒内问3个问题）每次都重建上下文，DB 查询浪费 | 延长到 30s，配合主动失效 |

#### 本次修复

**修复内容**：[familyPortrait.js:210-218](../../cloudfunctions/conversationAI/_shared/familyPortrait.js#L210-L218) compact 模式追加保单摘要行：

```
- 保障覆盖：寿险:有 重疾险:缺 医疗险:有...
- 已有保障：平安福(重疾险,50万,有效) 百万医疗(医疗险,300万,有效)
```

**修复效果**：AI 流式阶段能看到保单明细，无需调 queryPolicies，REFLOW_SKIP 的设计前提（"上下文画像已注入"）成立。

---

### ③ 对话窗口 · messages + 前端截断

**评分：B-**

#### 配置

| 配置项 | 值 | 评估 |
|--------|-----|------|
| 窗口大小 | 15 条（最后15条） | ⚠️ 无摘要兜底 |
| 单条上限 | 1500 字符 | ⚠️ 破坏 markdown |
| 持久化 | messages 集合 | ✅ 分页可查 |
| 摘要压缩 | ❌ 未实现 | ❌ 长对话失忆 |

#### 截断策略

```javascript
// chat-panel/index.js:171-173
const streamHist = ms.slice(-15).map(m => ({ 
  role: m.role, 
  content: (m.content || '').substring(0, 1500) 
}))
const genHist = ms.slice(-15, -1).map(m => ({ 
  role: m.role, 
  content: (m.content || '').substring(0, 1500) 
}))
```

#### 缺口

| 级别 | 问题 | 影响 | 建议 |
|------|------|------|------|
| **P0** | **15 条窗口无摘要兜底** | 长对话（>15轮）直接丢弃前段，AI 失去早期上下文 | 超15条时对前段生成摘要，摘要 + 最近10条注入 |
| P1 | **1500 字符截断破坏 markdown** | 长报告型回复（含表格）被截断在表格中间，AI 下一轮看到残缺表格可能误解 | 按段落边界截断 |
| P1 | **无跨会话记忆** | 用户昨天聊过、今天再开对话，AI 只能靠 facts 长期记忆，不记得"昨天讨论过的方案" | 会话结束时存 session_summary 到 family |
| P1 | **用户消息和 AI 消息同等截断** | 用户消息通常短但关键（"我女儿要结婚了"），AI 消息长但可压缩 | 用户消息不截断或更长上限（3000），AI 消息保持 1500 |

---

### ④ 跨会话记忆 · 缺失

**评分：C**

#### 完全未实现

当前只有"事实记忆"（facts）和"对话窗口"（15条），缺"会话记忆"。用户跨天/跨会话回来，AI 不知道"上次聊到哪了"。

#### 缺口

| 级别 | 问题 | 影响 | 建议 |
|------|------|------|------|
| P1 | **无 session_summary 机制** | 每次对话结束（onCollapse/页面卸载）不生成会话摘要。用户跨天回来 AI 不知道上次讨论内容 | 会话≥5轮时，结束时调一次 AI 生成摘要存入 family.session_summaries（保留最近3条） |
| P1 | **无"未决事项"承载** | 用户说"我回去问问老婆再决定"，AI 记不住这个 pending | facts 增加"待办"谓词，或单独 pending_items 集合 |
| P1 | **last_conclusion 未主动引用** | familyMeta 已暴露 last_summary/last_conclusion，但 prompt 未引导 AI 主动引用。用户问"上次分析怎么说"，AI 还得查一次 | prompt 加"用户问及历史分析时引用 last_conclusion" |

---

## 三、记忆能力矩阵

| 能力 | 当前状态 | 应有状态 | 差距 |
|------|---------|---------|------|
| 事实记忆 | ✅ facts + versioned | ✅ | 已达标 |
| 冲突处理 | ✅ 置信度 + source 优先级 | ✅ | 已达标 |
| 时间衰减 | ✅ 读时计算 | ✅ | 已达标 |
| 孤儿保障降级 | ✅ 待确认标记 | ✅ | 已达标 |
| 工作上下文 | ⚠️ 5s TTL + 写后不失效 | 30s TTL + 写后失效 | **P0** |
| compact 画像保单明细 | ✅ 本次已修复 | ✅ | 已修复 |
| 对话窗口 | ⚠️ 15条硬截断 | 摘要 + 最近10条 | **P0** |
| 跨会话记忆 | ❌ 无 | session_summary | P1 |
| 认知校准 | ❌ 无显式确认 | "已更正（原X→新Y）" | P1 |
| 主动引用历史 | ❌ 不主动 | 引导引用 last_conclusion | P1 |
| 意图类字段注入 | ❌ extraInfo 白名单过期 | 扩展新谓词 | P1 |
| token 长度控制 | ❌ 无 | 动态裁剪 | P1 |

---

## 四、严重问题清单

### P0 严重（2项）

1. **CtxCache 写后不失效**
   - 文件：[ctx-cache.js](../../cloudfunctions/conversationAI/ctx-cache.js) + [index.js:165](../../cloudfunctions/conversationAI/index.js#L165)
   - 现象：addFact/writePolicy 成功后，5s 内 CtxCache 仍持有旧画像
   - 影响：用户"刚说完年收入30万"立即问"我年收入多少"，AI 可能答"20万"（旧缓存）
   - 修复：写工具成功后调 `_ctxCache.invalidate(familyId+openid)`

2. **15条对话窗口无摘要兜底**
   - 文件：[chat-panel/index.js:171](../../miniprogram/components/chat-panel/index.js#L171)
   - 现象：长对话（>15轮）直接丢弃前段
   - 影响：AI 失去早期上下文，长对话失忆
   - 修复：超15条时对前段生成摘要，摘要 + 最近10条注入上下文

### P1 重要（7项）

1. **familyPortrait extraInfo 谓词白名单过期**
   - 文件：[familyPortrait.js:131](../../cloudfunctions/conversationAI/_shared/familyPortrait.js#L131)
   - 现象：只认"未来计划/有特征/有偏好"，不认 P0 新增的"传承意图/资产隔离需求/教育规划/婚嫁规划/退休规划"等
   - 影响：新谓词 fact 写入了但不进画像，AI 看不到 → 等于没采

2. **无跨会话记忆（session_summary）**
   - 影响：用户跨天回来，AI 不知道"上次聊到哪"

3. **last_conclusion 未主动引用**
   - 影响：用户问"上次分析"AI 还得查一次

4. **v2-context 无 token 控制**
   - 影响：大家庭（5+成员/10+保单）可能超 8K token

5. **CtxCache 5s TTL 偏短**
   - 影响：连续追问重复重建上下文，DB 浪费

6. **1500 字符截断破坏 markdown**
   - 影响：长表格被截断在中间，AI 下一轮看到残缺表格

7. **无"未决事项"承载**
   - 影响：用户说"我回去问问老婆"AI 记不住

---

## 五、本次修复记录

### 修复项：compact 画像缺保单明细

**根因**：conversation 场景的 compact 画像只输出覆盖矩阵（`寿险:有 重疾险:缺`），跳过了保单明细渲染。AI 在流式阶段看不到保单名称、保额、状态，无法回答"我家有什么保单"。

**修复**：[familyPortrait.js:210-218](../../cloudfunctions/conversationAI/_shared/familyPortrait.js#L210-L218) compact 模式追加保单摘要行：

```javascript
// 保单摘要：让 AI 在流式阶段（compact 画像）也能看到保单明细，无需调 queryPolicies
// 格式：产品名(险种,保额,状态)，如"平安福(重疾险,50万,有效)"
if (mp.policies && mp.policies.length) {
  const polSum = mp.policies.map(p => {
    const st = p.status === 'active' ? '有效' : p.status === 'expired' ? '已失效' : '待确认'
    return `${p.name || '未知'}(${p.category || '待确认'},${p.amount || '?'},${st})`
  }).join(' ')
  lines.push(`- 已有保障：${polSum}`)
}
```

**影响范围**：
- conversation 场景（getPrompt 流式）— ✅ 修复，AI 能看到保单明细
- tool 场景（postProcess）— 不受影响，已有独立的 buildPolicyTable 注入完整保单清单
- report 场景 — 不受影响，用 compact:false 走完整表格渲染

**同步状态**：3 个 _shared 副本已同步（conversationAI/reportAI/_shared）

---

## 六、设计亮点（保留勿动）

1. **facts versioned supersede + agent_confirmed 防覆盖**：长期记忆正确处理冲突，用户确认的事实不被自动事实覆盖
2. **时间衰减只读计算**：不写回存储，避免污染原始数据，agent_confirmed 不衰减
3. **source 优先级**（ocr > agent_confirmed > user_form > conversation）：多源数据正确归并
4. **孤儿保障降级**：对话补充保单无 policy 节点时降级为待确认
5. **CtxCache LRU + openid 隔离**：多租户正确隔离，命中即刷新到队尾（真 LRU）
6. **history-store reverse 转正序**：首次加载正确处理 desc 数组，避免历史倒序和游标错误
7. **v2-context 场景化裁剪**：list/conversation/tool/report 四场景按需注入，避免全量上下文
8. **datasets 显式契约**：不暴露原始集合记录，调用方只消费显式契约字段

---

## 七、修复优先级建议

| 优先级 | 修复项 | 文件 | 工作量 |
|--------|--------|------|--------|
| P0 | CtxCache 写后主动失效 | ctx-cache.js + index.js postProcess 工具执行后 | 小 |
| P0 | 15条窗口摘要兜底 | chat-panel + 复用 reportAI 能力 | 中 |
| P1 | extraInfo 谓词白名单扩展 | familyPortrait.js | 小 |
| P1 | CtxCache TTL 5s → 30s | index.js 配置 | 小 |
| P1 | 跨会话记忆 session_summary | chat-panel onCollapse + family 字段 | 中 |
| P1 | last_conclusion 主动引用 | prompts.js | 小 |
| P1 | token 长度控制 | v2-context.js | 中 |
| P1 | 1500 字符按段落截断 | chat-panel | 小 |

---

## 八、审计结论

**整体评价**：长期记忆设计扎实（versioned supersede / source 优先级 / 时间衰减 / 孤儿降级），是整个记忆体系的稳定锚点。工作上下文基线合理但有两个关键缺口：**写后不失效**和**compact 画像信息不足**（后者已修复）。对话窗口无摘要兜底导致长对话失忆。跨会话记忆完全缺失是下一个要补的能力。

**核心风险**：用户感知最强的两个问题是"刚说的信息 AI 不记得"（CtxCache 写后不失效）和"长对话失忆"（15条硬截断无摘要）。这两个 P0 问题直接影响用户对 AI 的信任度，建议优先修复。

**一句话总结**：长期记忆 A-，工作上下文 B（P0 已修一项），对话窗口 B-，跨会话记忆 C。下一步重点是补齐 CtxCache 写后失效和对话窗口摘要兜底两个 P0，以及扩展 familyPortrait 新谓词渲染收尾谓词收敛工作。
