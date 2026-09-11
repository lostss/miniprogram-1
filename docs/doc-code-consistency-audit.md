# 文档-代码一致性审计记录（2026-08-29）

> 触发：评估《保小秘·对话AI架构设计方案》时核验现状，发现方案主张与已落地 v9.6 双通道存在大量偏差；进一步对 `docs/prd.md` / `CONTEXT.md` 与代码做逐项比对，完成本轮一致性修正。

## 审计范围

| 文档 | 对比基准 |
|------|---------|
| `docs/prd.md` | `conversationAI/`（index/tools/prompts/tool-orchestration）、`dataWrite/`（handlers/fact-write）、`_shared/`（ai-gateway/config）、`miniprogram/`（chat-panel/chat-source/history-store） |
| `CONTEXT.md` | 同上 |

## 一、PRD 滞后于代码（已修正）

| # | 位置 | 原值（过时） | 现值（对齐代码） | 代码依据 |
|---|------|-------------|----------------|---------|
| 1 | 4.3 / 14.2 / 14.3 | 对话历史"最近 20 条" | **15 条** | `chat-panel` `slice(-15)`、`history-store` `PAGE_SIZE=15` |
| 2 | 4.3 / 7 章 / 9 章 | "13 工具" | **14 工具**（补 `queryMemberProfile`） | `tools.js` `TOOL_DEFINITIONS` 14 个可见工具 |
| 3 | 4.3 / 6 章 | addFact "26 谓词" | **66 谓词**（L1/L2 11 类） | `tools.js` enum |
| 4 | 6 章 / 8 章 | `FACT_STRATEGIES` "26 谓词（dedup 9 + versioned 17）" | **66 谓词（dedup 12 + versioned 54）**，未知谓词默认 dedup | `fact-write.js` `FACT_STRATEGIES` |
| 5 | 14.2 | streamText maxTokens 1200 | **1500** | `chat-source.js` `max_tokens: 1500` |
| 6 | 13 章 postProcess | 入参仅 `userText/text/sessionId` | 补 `aText/history/intent/usage`；出参删已下线 `cards?: []` | `index.js` `_handlePostProcess` |
| 7 | 13 章 | 无 record 模式定义 | **补 record 接口定义** | `index.js` `_handleRecord` |
| 8 | 14.3 | 缺工具上下文新演进 | 补：工具 schema 意图裁剪（token 成本审计 P2）、policyFactSplitter 规则预提取 | `tool-orchestration.js` `filterToolDefs` / `coverageHint` |
| 9 | 6 章 / 8 章 | "5 集合架构" | **6 集合架构**（含 products） | `products` 集合已落地 |

## 二、PRD 超前于代码（规划态已标注 ⏳，防"写了=做了"）

4.5 产品条款主数据章节新增**「落地状态」**段，并标注以下未实现项：

- 小程序端「专家评审」入口（报告页按钮 + `wx.chooseMessageFile` 上传 PDF）——**未实现**（搜索 0 结果）
- `productService` 云函数——**不存在**
- 消费端整节：reportAI 注入「产品条款画像」、权益卡 / 保障矩阵责任徽标 / plan 条款对比——**未实现**（reportAI 无 products 引用）
- 对话消费 `readProductClause` 工具——**未实现**（conversationAI 无此工具）

**已落地但 PRD 原述缺失**：建档管道实际走**开发者后台 skill 管道**（`.codebuddy/skills/product-clause-import`：官方条款直链下载 → pdf-parse 提取 → AI 概念化 → cloudbase MCP 写库），8 个在售产品已建档（4 重疾 + 4 医疗，status=confirmed，source.url 留痕）。

## 三、联动修正

`CONTEXT.md` 同类滞后同步修正：

| # | 位置 | 修正 |
|---|------|------|
| 1 | 系统架构 | conversationAI "13 工具路由" → **14 工具路由**（补 record 模式） |
| 2 | 数据库 | "5 集合" → **6 集合**（含 products 产品条款主数据） |
| 3 | 集合总览 | 加 `products` 行（定位/变更频率/量级） |

## 四、遗留项（本次未改，待后续）

| 项 | 说明 | 建议 |
|----|------|------|
| PRD 4.5 状态机（upload→extract→parsing→confirmed）仍描述"手动上传 PDF"路径 | 与 skill 管道并存：skill 是现状，UI 上传是规划 | 消费端实现时再统一两路径表述 |
| CONTEXT.md Fact predicate 示例仍为旧值（"购买了/缺少/有缺口/建议"） | 与 66 谓词 enum 不一致 | 下次架构文档修订时对齐 |
| CONTEXT.md 云函数清单缺 `products` 相关（productService 未实现故暂缺） | 与 4.5 ⏳ 标注一致 | productService 落地时补充 |
| 快照缓存（families.snapshot） | 未实施（2026-08-29 单通道改造完成） | 当前 CtxCache 30s TTL 够用；若做，快照收益按 hy3 实际计费重算 |

## 五、单通道 v10 改造实施记录（2026-08-29）

**决策链**：方案评审（单通道 tools 化）→ 与 Agent UI 对比（审计链/确认卡/测试/schema 单一源四方面自建胜出）→ 实施。SDK 硬约束：小程序端 `wx.cloud.extend.AI` 无 tools 参数，流式与原生 function calling 不可兼得。

**后端（cloudfunctions/conversationAI/）**
- `prompts.js`：删 `STREAMING_PROMPT`/`buildStreamingPrompt`（A 通道协议），新增 `CHAT_PROMPT`（基础角色 + 工具协议 + 确认规则 + 最终答复一体化）+ `buildSystemPrompt`
- `index.js`：v6.0——mode 收敛为 `chat`/`generateText`（删 getPrompt/record/postProcess）；chat 内单通道 function calling → 写入类挂确认卡 / addFact 免确认 / delete* 保留 409
- `tool-orchestration.js`：删 intent/aText 协议（v9.0-v9.6 五轮修复根因消除）；新增 `CONFIRM_TOOLS`（upsertMember/updateFinances/addPolicy/updatePolicy/createFamily）分类，需确认工具不 dispatch 直接构造确认卡；`_reflowWithResults` 回退优先 phase1 文本
- `suggestion-builder.js`：新增 `buildWriteConfirms`（write_confirm 确认卡 + 中文参数摘要 + target）
- `confirm-handler.js`：STRATEGIES 新增 `write_confirm`（dispatch 工具名 + payload + confirmed:true）

**前端（miniprogram/）**
- `chat-panel`：删流式（chat-source/prompt-cache/onStopGenerate/streaming 节流），单次调 `chat` mode；新增确认卡渲染（WXML + WXSS）+ `onCardConfirm/onCardCancel`（`{CONFIRM:xx}`/`{KEEP:xx}` 拦截）
- 删除 `utils/chat-source.js`、`utils/prompt-cache.js`、`tests/chat-source.test.js`
- `history-store.js`：`pending_confirms` 随消息恢复（历史确认卡可继续交互）

**测试**：`tool-orchestration.test.js` 重写（确认卡用例 + addFact 免确认 + 混合场景），`confirm-handler.test.js` 补 write_confirm，`walkthrough.test.js` 提示词断言更新。**845/845 通过**。

**文档**：PRD 4.3/调用流程/mode 列表/架构决策/验收清单/SLA/token 限额/配额/上下文构建/缓存策略全部更新为单通道 v10；12.1 降级链路同步。

**未做（后续项）**：确认卡"修改参数"（v1 仅确认/取消）；纯问答超时 UX 打磨（5-20s 全等待可接受性实测）。

## 六、审计结论

- `docs/prd.md` 对已落地架构（单通道 v10、配额、降级、成本模型）描述**已对齐**：前轮修正 9 类滞后 + 4 处规划态标注，本轮同步 v10 改造。
- 主要风险点：**4.5 消费端"写了=做了"**——已通过 ⏳ 标注消除歧义；后续任何消费端开发完成后需同步移除 ⏳。
- 维护建议：文档-代码一致性宜纳入 PRD 变更流程（每次 PRD 更新后跑一次对比检查，或依赖 `scripts/sync-shared.js --check` 类机制扩展到文档）。
