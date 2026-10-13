# 项目全面审计报告（代码逻辑 / 业务流程 / Bug）

- **日期**：2026-09-15
- **范围**：9 个云函数（dataQuery / dataWrite / login / cleanup / reportAI / conversationAI / ocrService / reportPdf / _shared）+ 前端 3 页面、6 组件、约 30 个 utils
- **方法**：4 个并行深审代理（数据层 / AI 层 / 前端报告与 OCR / 前端聊天与公共工具）+ 横切检查（_shared 副本同步、敏感信息扫描）+ 对全部关键发现逐条交叉验证（以下每条均有代码证据支撑）
- **性质**：只读审计，未改动任何业务代码

## 总体结论

架构成熟度高于典型小程序项目：writeSeam 写接缝、CAS 节流、三层缓存、观测补账设计到位，**未发现跨用户越权漏洞**。

但存在：

- 2 个 P0（密钥入库且历史清理不彻底；reportAI 解析失败重试致双计费 + 超函数时限）
- 8 个 P1 业务逻辑缺陷（原列 9 条；**P1-9 经复核为误报**，已标注推翻）
- 二十余项 P2 隐患（抽验 3/3 成立），其中一类系统性问题是**多处"项目约定"与实现已漂移，需产品裁定**
- ⚠️ **复核修正（2026-09-15）**：P0-2 / P1-3 的"违反【AI 严禁重试 maxAttempts=1】成本铁律"**查无此约定**——
  `CONTEXT.md` 与 `docs/` 全文均无此表述，且 `CONTEXT.md:121` 把「失败重试」列为 DeepSeek 直连的正当场景。
  两条的技术事实（二次计费 / 时限）成立，但定性应从"违规"改为"成本与可用性的产品权衡"。

---

## P0 — 立即处理（2 项）

### P0-1 密钥明文入库，已推到 GitHub（2026-09-17 复核修正）

- **位置**：`cloudbaserc.json` —— **当前未被跟踪**（`.gitignore` 已命中、`git ls-files` 不匹配），
  但**历史与远端仍含明文**。
- **证据（2026-09-17 实测）**：
  - `git rev-list origin/master --objects` 仍可达 **3 个** `cloudbaserc.json` blob：
    `6849db4d…` / `99f8c08c…` / `94a23914…`；
  - 这些 blob 由 **`refs/heads/master` 自身的历史**承载：`fdcf1a0`（初始提交）引入 → `135332e`/`c390dd6` 修改
    → `5bb604b` 删除（故 `git rev-parse 5bb604b:cloudbaserc.json` 取不到，容易误判为"已清理"）；
  - 远端 `origin = git@github.com:lostss/miniprogram-1.git`，其 `master` 与本地完全同步（左右差异 0/0）→
    **密钥就在 GitHub 上**；
  - 另 `refs/tags/v1-serial-ocr` 与 `refs/stash`（`0b658e7`「filter-branch-前暂存」）也承载旧对象。
- **修正前一版审计的两处不准确**：
  1. 原列"3 个提交（5bb604b / c390dd6 / 135332e）"——该哈希列表已不能代表当前泄漏面；
  2. 2026-09-17 中间结论"残留 ref 所致，删 ref + `git gc --prune=now` 即可"——**错误**：承载对象的是
     master 自身历史 + 远端，**本地 gc 对远端无效**。`refs/stash` 那个名字只说明"曾打算做 filter-branch"，
     **并未执行成功**。
- **影响**：任何能访问该 GitHub 仓库（含历史）的人可拿到三把密钥 → 直接调用 DeepSeek（扣费）与腾讯云 API（资源操作）。
- **唯一实质缓解**：在腾讯云 / DeepSeek 控制台**轮换三把密钥**。仓库一旦被 clone 过，任何历史清理都收不回密钥；
  清理只是**止损**（防未来 clone 者拿到）。
- **决策（2026-09-17）**：**用户决定暂不执行历史重写 + force-push**。本条转为**已知开放风险**，风险自担。
  若日后要做，顺序必须为：① 先轮换密钥 → ② `git filter-repo` 重写（含 tag）→ ③ `force-push origin/master`
  → ④ `git stash drop` + `git gc --prune=now` → ⑤ 用 `git rev-list --objects` 复核三个 blob 不可达。
- **已闭环的部分**：文件已入 `.gitignore`（当前不再被跟踪）、仓库内提供 `cloudbaserc.template.json` 占位模板
  —— 即"不再新增泄漏"已闭环；**未闭环的是存量历史**。

### P0-2 reportAI 解析失败重试：双倍扣费 + 超时雪崩

- **位置**：`cloudfunctions/reportAI/index.js` L151-163（重试调用 L156），`_callAI` 超时 `timeoutMs: 40000`（L294）
- **证据**：首轮 AI 输出 JSON 解析失败后，发起**第二次全额 AI 调用**（更严格提示词）。两次调用各 40s 超时，最坏 80s 超过云函数 60s 上限——函数被杀时 catch 不执行、CAS 锁（`analysis_lock_at`）残留 30s，期间用户点重试直接命中节流返回空报告（提示"已是最新分析"）。
- **违反约定**：【AI 严禁重试 maxAttempts=1】成本铁律。首轮输出 token 已计费，重试再计一次＝双倍扣费。
- **修复**：删除二次调用，改为本地宽松解析（正则提取 JSON 体 / 兼容尾逗号等）；若必须保留重试，总时长需压入函数上限并保证所有路径锁释放。

---

## P1 — 核心业务逻辑缺陷（9 项）

### P1-1 login 历史文档登录死锁

- **位置**：`cloudfunctions/login/index.js` L19、L24
- **证据**：L19 按 `openid` 查询（为兼容历史缺 `_openid` 的 agents 文档），L24 经 `ws.silentUpdateDoc('agents', ...)` 更新。而 writeSeam 的 `safeUpdateDoc`（`_shared/writeSeam.js` L63-70）要求文档已有 `_openid` 且归属匹配——历史文档恰恰缺 `_openid` → 校验失败 → 抛错 → 500"登录失败"。
- **影响**：存量（缺 `_openid` 的 agents 文档）用户永久无法登录，无自愈路径。
- **修复**：login 内改用 db 直写（login 是身份入口，本就有权补 `_openid`），或先无条件 upsert 再更新。

### P1-2 chat-panel 跨家庭消息污染（隐私）

- **位置**：`miniprogram/components/chat-panel/index.js` L162、L168（配合 L33-41 observer）
- **证据**：`_postChat` 为 60s 长请求；响应回来仅检查 `this._disposed`，不校验发起时的 familyId。observer 在切换家庭时已 `setData({ messages: [] })` 清空数组，旧响应按发起时的 `lastIdx` patch 进**新家庭**的消息列表。
- **触发链**：A 家庭发送 → 切换到 B 家庭 → 旧响应到达 → A 家庭的财务/健康信息显示在 B 家庭。
- **修复**：请求发起时记录 `familyId` token，响应校验不一致则丢弃。

### P1-3 OCR ai_empty 重试双计费

- **位置**：`cloudfunctions/ocrService/_shared/ocr-extractor.js` L165-172
- **证据**：`maxAttempts: 2, retryOn: e.code === 'ai_empty'`。ai_empty 时服务端已计费，重试＝单图双倍扣费，违反成本铁律。注释自称有意设计（DeepSeek JSON Output 空响应已知问题），但与铁律冲突；另 L129-131 注释称 ai_format 由 retryOn 重试与实际不符（死注释）。
- **修复**：取消重试（maxAttempts: 1），空响应让用户手动重试；或经产品确认后修订约定并同步文档。

### P1-4 updatePolicy 金额 NaN 落库

- **位置**：`cloudfunctions/dataWrite/policy-write.js` L401（对比 writePolicy L89）
- **证据**：writePolicy 有 `isNaN(saYuan) ? 0 : saYuan` 兜底；updatePolicy 经 `_toYuanAmount` 转换后直接 `patch[k] = v`，无法解析的输入（如"三十万"）→ NaN → 序列化为 null 落库。L400 注释自称"与 writePolicy 同规则"，实际漏了 NaN 兜底。
- **影响**：保单编辑路径写入 null 金额，报告侧展示异常。
- **修复**：updatePolicy 补同款 `isNaN ? 0`（或拒绝 400）兜底。

### P1-5 保单并发双写

- **位置**：`cloudfunctions/dataWrite/policy-write.js` L108-119
- **证据**：去重查询（按 policy_number+product_name）与写入非原子，同保单并发提交（如双端同时确认 OCR 批次）各自通过查询 → 各自 add → 双文档。
- **修复**：policies 集合对 (family_id, policy_number, product_name) 建唯一索引，或写入前二次确认。

### P1-6 deleteMember 清理不完整

> ⚠️ **2026-09-28 状态更正（勿按本条修改）**：本条的两个论断均已被推翻/已闭环，**不得据此重开删除语义**。
> ① 「不处理 `policies.member_id` 悬挂 … 修复：**解挂**该成员保单」✗ —— 与
> `docs/data-model-v2.md`「删除规则」（`policies.member_id` **保留原值不清空**）正面冲突。
> 该"解链"实现曾于 2026-09-20 落地、2026-09-22 因**对报告是 no-op 且违反数据模型规则**被回退
> （证据见 README 2026-09-22「D2 撤销」行）。悬挂是**有意保留的 join key**，不是缺陷。
> ② 「反向关系清理仅覆盖 配偶/子女/父母」✓ 已闭环：反向边清理已抽到
> `cloudfunctions/dataWrite/member-facts.js`，`deleteMember` 与 `_syncMembers` 共用同一实现。
> 现状由 `tests/crud-gaps.test.js`、`tests/updateFamily.test.js` 各一条断言钉住「member_id 保留原值」。

- **位置**：`cloudfunctions/dataWrite/member-write.js` L142-147
- **证据（原始，2026-09-15 快照）**：删除成员时不处理 `policies.member_id` 悬挂（保单继续指向已删成员）；反向关系清理仅覆盖 配偶/子女/父母 三种谓词，其他关系谓词遗漏。
- **修复（原始建议，第①半已作废）**：删除时同步软删或解挂该成员保单；反向谓词清单与成员关系模型对齐。

### P1-7 ocr-flow 纯现价表分支遮罩滞留

- **位置**：`miniprogram/components/ocr-flow/index.js` L190-194
- **证据**：纯现价表分支在无 activeFid 时 `wx.showModal(...)` 后直接 `return`，未调 `flow.hide()`，"正在处理"遮罩永久停留（有取消按钮可手动退出，非硬卡死）。
- **修复**：return 前补 `flow.hide()`。

### P1-8 history-store SWR 缓存命中后翻页游标缺失

- **位置**：`miniprogram/utils/history-store.js` L122-135（游标仅 L143 网络路径设置）
- **证据**：缓存命中路径（TTL 3 分钟）提前 `return { replace: cached }`，`oldestMsgTime` 保持 null；后台静默刷新的 `.then` 只写缓存不回写游标。用户下拉加载更多时 L117 `if (!oldestMsgTime) return 0` → 误报"没有更多了"。
- **影响**：3 分钟 TTL 内每次打开会话都无法翻看更早历史。
- **修复**：缓存命中时从缓存消息恢复游标（如随缓存存 `oldestCreatedAt`），后台刷新成功后同步更新。
- **状态（2026-09-17 核验）**：✅ **已闭环**。`history-store.js` L130-131 命中缓存时恢复 `oldestMsgTime`，
  `_writeCache(familyId, ms, oldestCreatedAt)` 把游标随缓存落盘。实现后又引入一处 SWR 游标竞态回归
  （后台刷新回写游标会覆盖用户已走深的游标 → 下一次"加载更多"重复 prepend），
  已由 `docs/ai-chat-audit-2026-09-17.md` 的 `cursorAdvanced` 标志修掉并补了测试。

### P1-9 OCR 成本口径错配 —— **已复核，判定为误报（勿按原结论改动）**

- **位置**：`cloudfunctions/ocrService/_shared/ocr-core.js` L245 + `ocr-extractor.js` L152 + `config.js` L25-27
- **原结论**：`USE_DIRECT: true` → 实际调用 `callChatDirect`（deepseek-flash）；日志记 `AI.OCR_MODEL`（'hy3'）→ cost 高估约一个量级；建议把 model 改为 `AI.DIRECT_MODEL`。
- **2026-09-15 复核（推翻）**：`USE_DIRECT` **不是** `callChat` 的分支开关。实证 `cloudfunctions/_shared/ai-client.js`：
  - `callChat`（L105-137）走 SDK 通道 `_createModel()` + `model.generateText`，`model: modelOverride || CHAT_MODEL`（='hy3'），**全程未读 `USE_DIRECT`**；
  - `callChatDirect`（L264-352）是**另一个函数**（内部 `model: AI.DIRECT_MODEL` 并注释"强制使用 DIRECT_MODEL"），OCR 路径未调用它。
  故 OCR 真实通道 = hy3，日志 `model: AI.OCR_MODEL`（='hy3'）**与真实调用一致、记法正确**，不存在高估。
- **附带纠正**：原结论称 `ocr-extractor.js` L148-151 的 2026-09-12 注释"方向写反"。该注释记载的是**上一版**的真实缺陷——
  曾写作 `USE_DIRECT ? DIRECT_MODEL : OCR_MODEL` 且 `USE_DIRECT` 恒真 → 把 hy3 记成 deepseek-flash 而**低估一个量级**，已于 2026-09-12 改正。
  即注释方向正确，是本次审计误读了历史。
- **风险提示**：若按原结论把 model 改成 `AI.DIRECT_MODEL`，会**重新引入** 2026-09-12 刚修掉的低估缺陷。改动前须先确认通道。

---

## P2 — 隐患与约定漂移（按域分组）

### 约定-实现漂移（需产品裁定，非运行时 bug）

| 约定 | 实现现状 | 位置 |
|------|----------|------|
| OCR 批量 ≤6 张 | 前后端一致为 9 张 | ocrService/handlers.js L75/154/351 + ocr-flow `count: 9` |
| OCR_BATCH_TIMEOUT=90000ms | 常量已不存在；现 `AI_TIMEOUT.OCR=15000`（有实测依据注释：avg 4.7s / max 8.2s） | ocrService/_shared/config.js L34 |
| OCR_BATCH_MAX_TOKENS=16000 | 16000 实为 `MAX_INPUT` 字符截断；maxTokens 现为 3000（多产品 JSON 防截断） | config.js L20/L38 |
| conversationAI 超 15 条截断（前段摘要+最近 10 条） | 未实现：实际 300 条/50K 字符预算触发压缩 + phase1 `slice(-6)` | conversationAI/_shared/config.js L72-76 |
| CtxCache 写后失效 | 改为版本校验（families.updated_at）+ state 权威块；自愈前提是 markMutated 必然成功（writeSeam 失败仅 warn） | conversationAI/index.js L152 |

### 并发与协议（AI 层）

- reportAI 四处锁释放（L178/227/250/263）无所有权校验：迟到请求可删新请求的锁 → 节流失效、双请求并发双跑（双计费）
- reportAI L100-112 脏值路径：CAS 失败且 lock 值非法时不 return，两并发可同时执行全流程
- tool-orchestration L504-512 失败回流违反 tool 协议：tool 消息未紧邻含对应 tool_calls 的 assistant 消息（成功路径 L283-291 正确）
- tool-orchestration L165-209 phase1 重试 2-3 次（429 指数退避）：429 不计费可豁免成本，但字面违反约定，且 2×30s+退避≈61.5s 逼近函数超时
- tool-orchestration L474 只读 query 成功也失效 state 缓存：无谓重渲染 + 多一次全量读库
- phase1 直连绕过注入检测（L77-84，文档化权衡：防 sanitize 截断损坏工具决策），用户输入仅过脱敏未过 detectInjection

### 注入与校验

- `_authOpenid` 客户端可控兜底出现在 createHandler.js L22 **和 reportPdf/index.js L450**——Event 函数下不可利用，但**开通 HTTP 访问前必须加固**
- injection-guard.js L13 `/你是.*AI/` 误杀"你是AI吗"这类正常提问
- apiClient.js L82 写操作重试豁免（retries=0）白名单漏 `linkCashValue`：超时重发可双写

### 数据质量

- 软删成员挂载保单（5 处）：成员删除后保单仍指向其 member_id
- family-write.js L141 `Number(m[f]) || 0`：age/income 非纯数字（"1万"/"45岁"）静默归 0
- data-normalizer.js L21 `parseInt` 截断小数
- readiness.js L21 `m.age || ...`：age=0 婴儿因 falsy 被误判缺年龄
- readiness.js L77-78 收入 0 值语义矛盾：家庭收入 0 算"已填"（作量化锚点），成员收入 0 算"无收入"
- amount.js L23-26 `fmtYuan(undefined)` → 字符串 "undefined" 展示给用户
- updatePolicy L415-419 被保人重挂取首个同名命中：重名成员错配（edit-form.js L124 同源问题）
- policy-status.js L83 到期判定 off-by-one：到期日当天 00:00 即判过期（保单应至当日 24 时有效）
- parse-expiry.js L70 `setMonth` 溢出：1月31日 +1个月 → 3月3日（应为 2月28日）
- report/index.js L489-491 非法 `last_analysis_at` 使 NaN 比较恒 false，绕过 30s 节流

### 存储与隐私

- family-actions.js L55-56 删除家庭后未清 `chat_history_<familyId>` 本地缓存：含 PII 的聊天记录永久残留
- history-store.js L29-41 过期缓存键只读不删：`chat_history_*` 无限累积
- reportPdf/index.js L464 时间戳文件名（`familyId_Date.now().pdf`）每次生成新文件，孤儿 PDF 无限堆积，无清理
- reportPdf/index.js L115-121 `_statusTxt` 状态文案映射不全：suspicious / unknown / 退保等均显示"待确认"
- history-store.js L45-57 fmtTime 对脏数据产出"NaN月NaN日"

---

## 合规确认（抽查通过）

- **无跨用户越权**：writeSeam 全路径 `_openid` 注入，safeUpdateDoc 先校验归属再更新
- 30s 报告节流 + 3 版保留 + 清理边界正确；429 传播且带 usage；`thinking: disabled`；tone 白名单
- _shared 副本经 scripts/sync-shared.js 同步，全部一致无漂移
- reportAI 锁在成功 / 解析失败 / 双层 catch 四路径均释放（但均无所有权校验，见 P2）
- 报告输出拒绝硬拦截已改 warn 模式（避免 2026-09-10 整份 JSON 被替换的线上事故复现）
- parse-ai-json 兼容对象/数组返回；成功路径 tool 协议正确；conversationAI 已 await reportAI

---

## 修复优先级建议

> **2026-09-15 逐条复核后的修正**（见各条内标注）：P1-9 已判定为**误报，不再排期**（按原结论改动会重新引入缺陷）；
> P0-2 / P1-3 的**技术事实成立**，但"违反成本铁律"的定性**不成立**——`CONTEXT.md` / `docs/` 全文均无此约定，
> 且 `CONTEXT.md:121` 明确把「失败重试」列为 DeepSeek 直连的正当场景。故这两条应走**产品裁定**（成本 vs 可用性），
> 而非按"铁律"直接删除重试。

1. **今天**：
   - P0-1 三把密钥**轮换**（唯一实质缓解，仅用户可在控制台执行）+ 历史重写。
     **2026-09-17 用户决定暂不执行历史重写 / force-push** → 本条转为已知开放风险。
     技术要点见 P0-1 条目：承载明文对象的是 **master 自身历史 + 远端 origin**（`git gc` 无效），
     且 `refs/stash` 里的「filter-branch-前暂存」表明早前的清理尝试并未执行成功。
   - P0-2 reportAI 解析失败重试：技术面成立（二次全额调用；`timeoutMs:40000` × 2 = 80s > 函数 60s 上限）。
     建议改为**本地宽松解析**（不新增计费、不占时限），而非"因铁律删重试"。
2. **本周**：
   - P1-1 login 死锁自愈（db 直写或先补 `_openid`）
   - P1-2 chat-panel 响应校验 familyId（跨家庭串数据，隐私级）
   - P1-3 OCR `ai_empty` 重试：**与 P0-2 合并裁定**（同为"重试 vs 成本/可用性"权衡，DeepSeek JSON 空响应是官方已知问题）
3. **排期**：P1-4 ~ P1-8 逐项修复（复核确认全部成立，行号精确）
4. **产品裁定后统一**：约定漂移五项（6 张 / 90s / 16000 / 15 条 / CtxCache）——先定以约定还是实现为准，再批量改代码或改文档
5. **随 P0 一并收口**：锁所有权校验 + 脏值路径（低概率并发缺陷，改动集中在 reportAI/index.js）
