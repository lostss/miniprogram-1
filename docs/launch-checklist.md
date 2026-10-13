# 上线检查清单（2026-09-22 全面审计产出）

> 本文是**上线前必须逐条勾掉**的清单，来源：2026-09-22 全面审计（4 个专项 + 主审计，只读取证 + 已修项回归）。
> 与 `README.md`（部署知识）互补：README 记"怎么部署"，本文记"上线前还差什么 + 怎么验证"。

---

## 一、上线阻断项（B 阶段前必须完成）

### 1. 【P0 安全】轮换已泄漏的 DeepSeek API Key

**事实（已独立复核）**：仓库 `lostss/miniprogram-1` 是 **public**（GitHub API 返回 `"private": false`）。
初始提交 `12f86d7` 中的 `.codebuddy/models.json` 含真实 `sk-...` key，至今仍可按 SHA 匿名取到：

```
GET https://api.github.com/repos/lostss/miniprogram-1/contents/.codebuddy/models.json?ref=12f86d7
→ HTTP 200, sha=b82b5d7799e8, 正文含 sk- 开头的 key
```

`.gitignore` 停止跟踪**不能**撤回已推送的对象（`git gc`/删 ref/本地重写均无效）。

**处置顺序**：
1. DeepSeek 控制台**吊销**该 key 并新建；
2. 同步更新两处：本地 `.codebuddy/models.json`、云函数 `ocrService`/`reportAI`/`conversationAI` 的 `DEEPSEEK_API_KEY` 环境变量；
3. （可后置）`git filter-repo` 清除历史 blob + force-push；不做这一步则该 key 的**历史值**永久可读（已吊销则危害归零）。

> 注：审计复核**修正**了 `docs/code-audit-2026-09-15.md` 的"三把密钥泄漏"结论——
> `git log --all -S` 搜腾讯 SecretId/SecretKey 与 `cloudbaserc.json` 里的 key **0 命中**，
> 实际泄漏面是 1 把（models.json 的 DeepSeek key）。

### 2. 【P0 安全】腾讯云永久密钥不得留在明文配置里

`cloudbaserc.json`（已 gitignore，未入库）含 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`——
账号级凭证，可读写全部用户集合。建议：控制台环境变量托管 + 轮换一次（它虽未泄漏，但与已泄漏的 key 同处一个文件，误分享/误打包即全量数据泄漏）。

### 3. 【P0 合规】微信后台「用户隐私保护指引」必须声明相册/相机

代码用了 `wx.chooseMedia`（`miniprogram/components/ocr-flow/index.js`），自 2023-09 起属**必须声明**的隐私接口。
未声明时：开发工具**不报错**（`project.config.json` 未开 `__usePrivacyCheck__`），**真机发布版直接 fail** → 上传保单按钮点了没反应。

**动作**：小程序后台 → 设置 → 服务内容声明 → 用户隐私保护指引，勾选「选中的照片或视频信息」「摄像头」；
建议同时在 `project.config.json` 打开 `"__usePrivacyCheck__": true` 让开发工具提前暴露同类问题。

### 4. 【已修，需重新部署】share token NoSQL 操作符注入

`dataQuery getSharedFamily` 的 `token` 原先只判真值，客户端可传 `{$exists:true}` 对象 →
序列化后与 `_.exists(true)` **字节等价** → 无需 token 即命中某个已开启分享的家庭、返回其完整客户视图（跨用户读取）。
已修为「48 位小写 hex 字符串」强校验（`cloudfunctions/dataQuery/share.js`）。**必须重新部署 dataQuery 才生效。**

---

## 二、云侧控制台必做（代码里没有 IaC）

| # | 项 | 现状 | 动作 |
|---|---|---|---|
| 5 | `cleanup` 定时触发器 | `cloudbaserc.json` **无 `triggers` 段**，函数级 `config.json` 也没有 | 控制台建定时触发器（建议每日一次）；否则 cleanup 恒返回 401（业务错误码，冒烟测试抓不到）→ 日志不清理、PDF 永不过期 |
| 6 | `NODE_ENV=production` | 只在 `cloudbaserc.json` 声明，但 `tcb fn deploy` 可能覆盖环境变量 | 部署后 `tcb fn detail cleanup` 核对 |
| 7 | `agents.openid` **唯一索引** | `login/index.js` 注释写"见部署说明"，全仓无该说明；`docs/data-model-v2.md` 索引表也没有 agents 行 | 建唯一索引；并核查存量重复档案（见下方脚本） |
| 8 | `reports/` 云存储安全规则 | `reportPdf` 上传的 PDF 无 owner，fileID 泄漏即任何人可下载（含完整家庭财务画像，TTL 30 天） | 自定义规则设 `{"read": false, "write": false}`（仅云函数读写），前端改走短时效 `getTempFileURL` |
| 9 | 索引补齐 | `docs/data-model-v2.md:7-15` 实测表：`finances` 缺 `family_id`、`undo_logs` 缺 `expires_at`/`family_id` | 数据量起来前补建 |
| 10 | 环境变量核对 | 部署可能清空 | `reportAI`/`conversationAI`/`ocrService` 的 `DEEPSEEK_API_KEY`；`ocrService` 两个腾讯云密钥；`cleanup` 的 `NODE_ENV` |
| 11 | `reportPdf` 字体 | `cloudfunctions/reportPdf/fonts/NotoSansSC-Regular.otf`（8.3MB）**被 gitignore** | 本机部署会带上；**换机/新克隆/CI 必然缺** → 所有 PDF 导出失败且只有通用 500。恢复步骤写进部署清单（`docs/worklog/2026-09-11.md:36` 有来源） |

**存量 agents 档案核查（只读）**：
```js
// 云函数控制台或临时函数中执行
db.collection('agents').where({ _openid: _.exists(false) }).count()   // 缺 _openid 的历史档案
db.collection('agents').aggregate().group({ _id: '$openid', n: $.sum(1) }).match({ n: _.gt(1) }).end()  // 重复档案
```

---

## 三、本次审计已修（重新部署后生效）

| 级别 | 问题 | 位置 |
|---|---|---|
| P0 | share token 操作符注入（无需 token 跨用户读客户视图） | `dataQuery/share.js` |
| P0 | `recordField` 引用块级作用域外的 `memberField` → 必抛 ReferenceError：事实已落库、钩子未触发、用户看到 500，重试即重复写 | `dataWrite/member-write.js` |
| P1 | 首页成员批量查询 `.limit(500)` 超平台硬上限 100 → 静默截断：成员总数 >100 的代理人首页显示「0 名成员/经济支柱为空」（搜索路径 `.limit(200)` 同理） | `dataQuery/family-list.js` |
| P1 | 历史 agents 文档缺 `_openid` → 登录恒 500，用户永远进不来（"补写 _openid"的修复前提恰是 _openid 已匹配） | `login/index.js` |
| P1 | 月度配额只加不减、全仓无重置 → trial 用户用满 30000 token 后**永久**被拒（提示"本月"却永不到来） | `_shared/guard.js`、`_shared/ai-accounting.js` |
| P1 | 配额双档：`{openid,_openid}` 定位对历史文档命中 0 条 → 补建第二份 agents 档案（无 limit）→ 配额失效 | 同上 |
| P1 | 对话主通道绕过 gateway → 无注入检测、无配额预检（最高频路径可无限消耗；粘贴注入文本可驱动免确认写工具） | `conversationAI/index.js` |
| P1 | 删除类工具的确认门可被模型参数 `confirmed:true` 绕过；参数校验用裁剪后的工具表（未命中即全放行） | `conversationAI/tool-orchestration.js` |
| P1 | 自动保障分析打 60s 的 reportAI 却用默认 30s 超时 → 必然先放弃、用户看不到自动更新 | `pages/report/index.js` |
| P1 | 上传"纯现价表"成功后组件漏发 `busychange` → 首页两个上传入口同时消失，只能杀进程 | `components/ocr-flow/index.js` |
| P1 | `wx.chooseMedia` 无 fail 回调 → 拒绝权限/未声明隐私协议时点击无任何反馈 | 同上 |
| P2 | 分享响应下发代理人内部字段（memo 私密备注、成交标记、软画像、待澄清线索等） | `dataQuery/share.js` |
| P2 | `injection-guard` 的 `ZERO_WIDTH` 是死常量 → 零宽穿插可绕过全部注入规则 | `_shared/injection-guard.js` |
| P2 | OCR 实走 DeepSeek 直连却按 hy3 记账（USD，约 16 倍高估） | `ocrService/_shared/ocr-extractor.js` |
| P2 | 报告锁脏值时不清不占 → `_releaseLock` 永不匹配，该家庭并发节流永久失效（双跑双计费） | `reportAI/index.js` |
| P2 | `operation_logs.meta` 明文落保单号/被保人姓名（保留 90 天） | `dataWrite/cash-value-matcher.js` |
| P2 | 计费型只读 action（OCR 提取等）默认 `retries=1` → 网络失败整批重发 = 双份 OCR+AI 计费 | `utils/apiClient.js` |
| P2 | `shareFamily` 未列入写操作（重发可能生成两个 token → 前端拿到 A、库里是 B，链接失效） | 同上 |
| P2 | 本地超时错误无机器可读标志 → 既不重试、又被归类成 UNKNOWN（用户看到"操作失败"而非"操作超时"） | `utils/callCloud.js`、`utils/errorHandler.js` |
| P2 | `chat_history_*` 过期缓存只判不删 → storage 逼近 10MB 后所有写入静默失败（OCR 批次快照首当其冲） | `utils/history-store.js` |
| P3 | 调试残留 `tests/_probe.test.js`（无断言、恒绿）已删除；`insurer-normalize.js` 重复键已清 | — |

回归：`npm test` → **109 suites / 1262 tests 全绿**（新增 5 条契约测试：零宽注入、跨月配额重置、confirmed 剥离等）。

---

## 四、已知未修（按风险排序，含建议方案）

1. **【P1 加固】dataWrite 有 7 个 handler 不校验 familyId 归属**
   `writeMessage`/`writeOpLog`/`upsertMember`/`upsertFinances`/`recordField`/`addFact`/`writeCashValue`——
   读路径全部注入 `_openid`，**不构成跨用户读取**；但持有他人 `familyId` 者可向其名下注入孤儿文档。
   `familyId` 是高熵 `_id`（不可枚举），但**分享查看者会拿到 `family._id`**（客户版响应里用于埋点）→
   拿到分享链接的客户可向代理人档案写入事实（污染报告上下文）。
   建议：抽 `_shared/assertFamilyOwned(db, familyId, openid)`（`families.where({_id, _openid}).count()===0 → 404`），
   在 `dataWrite/handlers.js` 路由层对带 familyId 的 action 统一前置；**需同步给相关测试补 families seed**
   （当前多数用例只 seed members/facts，属"桩替生产放水"）。
   备选（一行、零测试改动）：客户版响应不再返回 `_id`，代价是 shared 埋点失去 familyId 归因。

2. **【P1】撤销按整份 before 快照覆盖写** → 会静默回滚撤销点之后的其它写入
   （5min 窗口内先改收入、再改负债，点第一条的撤销 → 负债修改消失）。建议 undo 记录 `changedKeys` 只回滚相关键。

3. **【P1】确认卡无服务端一次性消费**：重复投递 `{CONFIRM:id}` 会重复执行（无 policy_number 时不去重 → 保额/保费翻倍）；
   同一条消息挂 2 张卡时，确认第 1 张后第 2 张必 404。建议 pendingId 加消费标记/CAS。

4. **【P2】hy3 回落通道无单次超时**（`callChatWithTools` 不消费 `timeoutMs`）+ 3 次尝试 → 理论最坏 >200s vs 函数 60s。

5. **【P2】`ocrService.timeout` 写 100s**：若平台上限 60s，该配置或被拒或被静默收敛；
   `utils/ocr-flow.js` 注释、`docs/prd.md`、README 三处都按 100s 复述。**上线前在控制台核对实际值并统一口径。**
   （前端 70s timer 在两种情形下都安全：真实值 60s 时服务端先返回真实错误码。）

6. **【P2】`_authOpenid` 兜底口径不一致**：`reportPdf` 有、`reportAI`/`conversationAI` 无。
   当前所有函数都是 Event 类型（小程序 callFunction 恒带 OPENID），不可利用；若将来开 HTTP 访问必须先加调用方校验。

7. **【P2】打包配置全默认**：`cloudbaserc.json` 未声明 `runtime`/`memorySize`/`ignore`；
   5 个函数的 `ws` 是**死依赖**（全仓 0 次 `require('ws')`）。

8. **【P2】`sitemap.json` 全量 allow**：私有代理人工具，3 个页面可被微信索引。建议改 `disallow`。

9. **【P2】`libVersion: 3.15.1` 未能离线证实**：开发者工具「详情→本地设置」确认可下载，否则真机与模拟器表现可能不一致。

10. **【P3】文档滞后**：`docs/process-audit-2026-09-18.md` 记的 reportAI 重试预算问题**已修**；
    `docs/data-model-v2.md` 集合表缺 `report_files`（2026-09-20 新增）。

---

## 五、仓库卫生（上线前收口）

1. **工作区有 200+ 未提交改动**（含 67 个未跟踪的**源文件与测试**）——上线版本必须可复现，先提交/打 tag。
2. **`README.md` 与 `docs/ops-notes.md` 未入库**：全部部署知识（函数清单/超时/环境变量/部署后核对/密钥恢复）
   只存在于本机未跟踪文件里。必须 `git add`。
3. `cloudbaserc.json`（含真实密钥）与 `cloudfunctions/reportPdf/fonts/`（8MB 字体）保持 gitignore——但恢复步骤要写进清单（见第 11 项）。

---

## 六、部署后冒烟（每次发版必做）

README「验证部署真的生效」一节的血泪教训：`updateFunctionCode` 返回 success **不等于**生效。逐项做：

1. `tcb fn list` 核对 8 个函数的 `ModTime` 已更新到本次部署时间；
2. 小程序端（不能用 MCP 直调，无 openid 会 401）：
   - 首页列表：确认 `deal_status` 字段存在、成员数与经济支柱正确（覆盖本次 family-list 分页修复）；
   - 上传 1 张保单 → OCR 识别 → 保存 → 报告刷新（覆盖 ocr-flow 的 busychange 修复：保存后回首页，**上传入口必须还在**）；
   - 对话发一句"帮我把家庭收入改成 30 万" → 免确认执行 + 出现撤销按钮；
   - 报告页导出 PDF → 能下载且中文正常（覆盖字体依赖）；
   - 生成分享链接 → 用另一个微信号打开 → 客户版正常渲染，且响应里**不含** memo/deal_status；
   - 拒绝相册权限后再点上传 → 必须出现权限引导弹窗（覆盖 chooseMedia fail 修复）。
3. `cleanup`：控制台手动触发一次定时事件，确认返回 `code:200`（**不是 401**）。

---

## 七、上线后 7 天观察项

- `operation_logs`（`logAction:'ai_call'`）的 `currency` 分布：出现 `USD` 即说明又有路径按 hy3 记账（OCR 归因回归）。
- `agent_logs` 里 `action:'conversation_blocked'`：INJECTION 命中率异常升高说明误伤（收紧/放宽规则要看真实样本）。
- `agents.token_used_monthly` 与 `quota_period` 是否按月翻新（跨月重置是否生效）。
- `report_files` 记录数是否随 TTL 下降（触发器是否真的在跑）。

---

## 八、PDF 报告生成审计（2026-09-25）

审计方式：把 `cloudfunctions/reportPdf/index.js` 接上内存 DB + 真实字体**本地跑通**，
再用 PyMuPDF 逐页出图 + 提取文本坐标（`span bbox`）做客户视角核对——
结论全部基于**真实渲染产物**，不是读码推断。共 3 类缺陷：布局重叠、内容错账、文案污染。

### 第一批：布局重叠 / 内容错账 / 文案污染（2026-09-25，需重新部署 reportPdf）

| 级别 | 问题（客户视角看到的） | 根因 |
|---|---|---|
| **P0 布局** | 保单明细里长产品名/长保单号的格子**换行后压在下方的「公司/保险期间」行上，两段文字重叠成乱码** | pdfkit 的 `ellipsis: true` 只在**同时传 `height`** 时生效，本文件从不传 → 该参数是死参数，超宽文本直接换行；而主行行高恒为 20pt |
| **P1 内容** | 「缴费月历」把**趸交**保单列成每年固定支出（实测 3.5 万/年）、把**已缴满期**的保单继续列出、月交保单显示**年**保费（放大 12 倍） | `buildPayMonths` 只看生效月，不看缴费频次与缴费是否结束；算好的月度合计从未渲染 |
| **P1 内容** | AI 正文里的「80 万**→**需要补充寿险」被渲染成「80 万需要补充寿险」，两侧词被粘连、语义改变 | `mdPlain` 把 `[\u2190-\u2712]` 箭头/数学符号**删除**而非替换为空格 |
| **P1 内容** | 「保障缺口分析」标题在同一页**连印两次** | AI 正文自带 markdown 标题，PDF 又印了一遍小节标题 |
| **P1 内容** | 客户拿到的每一页页脚都印着内部构建标记「· r4」 | 部署校验标记写在了页脚（已移入 PDF 元数据 `Keywords`） |
| **P2 内容** | 3 张未匹配到被保人的保单显示「保障人数 1」，与明细表 3 行「—」矛盾 | `new Set(map(p => p.insured_name \|\| ''))` 把空串当成同一个人 |
| **P2 内容** | 无被保人姓名时保障节点显示「产品名(--)」 | `insured_name \|\| '--'` 直接拼进括号 |
| **P2 布局** | 单段超过一整页时 pdfkit 自行分页、**该页无页脚且后续页码错乱** | 已改为绘制前按高度切块（`_splitByHeight`），保证任何段落不超单页 |
| **P2 布局** | 「保障节点」等小节标题孤立在页面最底部、正文全在下一页 | `_sec` 只预留 30pt（现 62pt） |
| **P2 一致性** | 日期区间形态的一年期保单：进「一年期短险」汇总、缴费期却显示「—」 | 文件内自建了一份只认文本形态的 `_isOneYearPolicy`，未走契约 `policy-status.isOneYearPolicy` |

顺带：产品名列宽 170→198（原列宽合计 454，白空 37pt），产品名允许两行显示（不再截成「…重大疾…」）。


### 第二批：客户视角文案与版面（2026-09-25 同日，按「除代理人联系方式外全部修」执行）

| 项 | 改前（客户看到） | 改后 |
|---|---|---|
| 封面标题 | 代理人的内部档案名，实测「**李姐-转介绍（老客户）** · 家庭保障检视报告」 | 按成员推导「**王强家庭** · 家庭保障检视报告」（优先 role 含本人/经济支柱且有姓名的成员；取不到姓名才回退 family_name）。小程序内仍用 family_name，只改对外纸面 |
| 免责声明可读性 | 8pt `#999999`（对比度约 2.9:1，低于 WCAG AA），法律上最该被读到的一行却最浅最小 | 9pt `#666666`；AI 自带免责声明同步 8pt→8.5pt / `#777777` |
| 免责声明措辞 | 「基于 **OCR 识别结果** 自动生成」——手工/对话录入的保单不成立，等于虚报数据来源 | 「依据**代理人录入及保单识别结果**自动生成」；三条必备表述（仅供参考 / 不构成投保建议 / 以保单原件为准）原样保留 |
| 一年期过期提醒 | 「**按保证续保默认仍有效**，请确认是否已正常续保」——判据只认「1 年/一年/区间约一年」，**判不出是否保证续保**，对意外险等是不成立的承诺 | 「请确认是否已正常续保（一年期通常按年续保，**是否保证续保以条款为准**）」——产品决策本意（D3：默认续保 + 文中提醒）不变，只把断言交还条款 |
| 页脚 | 只有「第 N 页」 | 「第 N / **总页数** 页」——改为渲染结束后逐页回填（`bufferPages` + `switchToPage`），pdfkit 自作分页带出的页也一定被补上页脚 |
| 首页 | 无目录 | 新增**目录**（7 个小节 + 页码），页码按 pdfkit 缓冲页数回填，与各节实际落页逐项核对一致（两个夹具 0 处不符） |
| 长段落分页 | 单段超过一整页时整段被推到下一页，前面留一大片空白 | 先按**当前页剩余空间**切块填满，余下按整页切（递归收敛，已用 3428 字单段实测：90/90 片段与结束标记全在，无丢字） |

**未做（按你的指示跳过）**：封面加代理人姓名/联系方式。

**验证**：`cloudfunctions/reportPdf/index.js` 本地跑通 → PyMuPDF 逐页出图 + 文本坐标核对；
两个夹具（富数据 3 页 / 边界数据 4 页）任意两行 bbox 无异常重叠、每页有页脚、目录页码与实际落页 0 处不符；
`npm test` → **109 suites / 1308 tests 全绿**（本批新增 12 条：`_displayName` / `DISCLAIMER` / 目录接线 / finalize 顺序）。
⚠️ 需**重新部署 reportPdf** 才生效（小程序端无需发版）。

### 未修（唯一一项，按指示跳过）

1. **封面无代理人姓名/联系方式**：客户拿到的是没有出处的报告（只有「保小秘生成」）。
   建议将来补封面署名（`agents.nickname` 已有字段，无需新字段）。

> 另有一项**需你确认口径**（本次未擅自改）：一年期过期提醒现在写「一年期通常按年续保，是否保证
> 续保以条款为准」。若某张保单条款确认是保证续保（如「每 3 个保险期间为保证续保期间」），
> 纸质提醒可以更强；但判据 `isOneYearPolicy` 判不出这一点，要么按险种白名单、要么人工标注。

### 复现方式（回归用）

本次审计的 harness 在系统临时目录（未入库）：`%TEMP%\dsh-pdf-audit\gen.js`（内存 DB 夹具 → 真实
`exports.main` → 落盘 PDF）、`render.py` / `spans2.py`（PyMuPDF 出图 + 文本坐标重叠检测）。
建议把「重叠检测」固化成一条单测（对固定夹具断言任意两行 bbox 不重叠），防止此类问题回归。

