---
name: product-clause-import
description: Use when 需要为保险产品建档（获取条款 PDF → 提取 → AI 概念化 → 入库 products）、批量补录待建档产品（查库盘点差异 → 官方源搜索直链 → 批量下载提取入库）、或验证条款解析管道。触发场景：用户说"给 XX 产品建档"、"录入 XX 条款"、"从官方获取条款并录入"、"看下有哪些产品没建档/没数据直接补录"、"获取 XX 产品条款"、"跑一下条款管道"
---

# 产品条款导入（product-clause-import）

## 定位

开发者后台技能。把"获取条款 PDF → 提取文本 → AI 概念化提取（liability + benefits）→ 人工确认 → 写入 products 集合"固化为可重复 SOP。产物供报告深度分析引用条款（见 `docs/prd.md` 4.5 消费端：权益卡 + 责任覆盖维度 + 条款差异分析，均为人工确认后的数据）。

**范围**：仅文本型 PDF；本技能是后台建档工具，不含小程序前端集成。

## 核心流程（六步）

```
1. 获取 → 2. 提取 → 3. 概念化 → 4. 展示确认 → 5. 入库 → 6. 回归
```

## 纪律约束（硬规则）

1. **null 不编造**：概念未在条款中找到必须留空，禁止凭产品常识补值——条款解读必须可审计
2. **人工确认必做**：未确认不写 `confirmed`；确认/修改记 `confirm_log`（`[{field,value,by,at}]`）
3. **官方源优先**：官网/监管库直链；第三方转载拒绝；官网 404 → 请用户提供条款文件，不自行换源
4. **扫描件拒绝**：提取文本空/过短即判定扫描件，提示"请上传文本型 PDF"，不逐页 OCR

## 命令

```powershell
# 依赖安装（skill 目录内）
cd .codebuddy/skills/product-clause-import; npm install

# 1. 获取（直链下载，校验 %PDF 魔数）——AI 执行
node scripts/fetch-clause.js "<条款PDF直链>" out/clause.pdf

# 2. 提取（pdf-parse，扫描件判定 <100 字符拒绝）——AI 执行
node scripts/extract-pdf.js out/clause.pdf --out out/clause.txt

# 3. 概念化 —— AI 直接完成（不依赖外部 API）
#    AI 读 out/clause.txt + lib/concept-dict.js → 输出 liability + benefits（null 不编造）
#    备用替代（无 AI 助手时）：node scripts/parse-product.js out/clause.txt --name X --category 重疾（需 DEEPSEEK_API_KEY）

# 4. 展示 → 用户逐项确认（liability + benefits）
# 5. 入库 —— AI 经 cloudbase MCP 写 products（status=confirmed + confirm_log + source.url）
#    _openid 取自当前会话/agents（建档人维度，与项目隔离一致）
# 6. 回归（防管道退化，改脚本/换依赖后必跑）
node scripts/extract-pdf.js fixtures/clause.pdf
```

## 批量建档（盘点 → 官方源 → 批量入库）

适用：对已有保单产品批量补录条款数据（已验证：8 产品端到端成功，2026-08-27）。

**1. 盘点待补录**（MCP）：
- 查 `products`（全部）与 `policies`（投影 product_name/insurer/category）→ 差异 = 待补录清单
- products 集合不存在时先 `writeNoSqlDatabaseStructure createCollection`

**2. 官方源搜索**（web_search）：
- query 格式：`产品名 利益条款 pdf site:官方域名`（如 `site:static-cdn.newchinalife.com`）
- **只认"利益条款"，拒绝"产品说明书"**（说明书无完整责任定义；搜不到时补搜 `产品名 利益条款 官方域名`）
- 官方 CDN 直链（static-cdn.*.com/ncl/pdf/...）最优；第三方转载（book118/doc88）一律拒绝
- 中文路径 URL 在 Node `fetch()` 自动编码；个别站点 404（站点差异），换官方域名重搜

**3. 批量下载+提取**：
- `node scripts/batch-fetch.js`：清单内联在脚本 `LIST` 数组（含 8 产品样本）→ 批量下载（%PDF 魔数校验，输出 out/clauses/）→ `node scripts/extract-pdf.js out/clauses/<name>.pdf --out out/clauses/<name>.txt` 逐份提取
- 新增产品 → 向 `LIST` 追加 `{ name, url }`（url 须为官方利益条款直链）
- 同产品线不同计划（如"华贵B款"与"(计划二)"）共用同一利益条款，只下载一份、分别建档注明

**4. AI 概念化**：对每份条款文本用 `search_content` 定位概念关键词（等待期/免赔额/续保/轻症中症/特药/津贴等，带 context）取证据 → 按 `lib/concept-dict.js` 组装 liability（**null 不编造**：条款未提及即 null，如增值服务未写即 `special_services:null`）。

**5. MCP 写库（关键经验）**：
- `writeNoSqlDatabaseContent` `action=update`，query 按 `product_name` 精确匹配
- **必须逐个串行调用**：并行 update 同集合导致 `arguments must be a valid JSON string` 参数解析失败
- **标点用半角**（`(` `,` `:`），全角字符在参数序列化中易出错
- update 内容：`$set`（status:'confirmed' + liability + benefits + source.url/fetched_at + updated_at）+ `$push` confirm_log（by: product-clause-import）
- **必须手动带 `_openid`**（服务端写入不含，从 agents 集合查建档人）

**6. 验证**：`readNoSqlDatabaseContent` 投影确认全部 `status='confirmed'` + liability 关键字段（等待期/免赔额）。

## 概念字典（lib/concept-dict.js）

第一版覆盖四类险种：重疾 / 医疗 / 寿险 / 意外。新险种建档时 `unrecognized` 概念上报 → 人工补录回写字典 → `schema_version` 递增。AI 输出经 `lib/schema-validate.js` 校验（未知键收集、类型检查、null 合法）。

## 验收标准

- 端到端一次建档：给定条款直链 → 产出 `products` 文档（confirmed + 留痕完整）
- `fixtures/clause.pdf` 回归通过（提取 ≥9000 字符、章节可识别）
- 负例：扫描件 PDF → 明确拒绝并提示

## 技术细节

- **pdf-parse 锁定 1.1.1**：v2（2026 版）依赖 pdfjs-dist 34MB 不可用；1.1.1 完整包 31MB（后台本地无包限制，无需裁剪）
- **概念化由 AI 直接完成**：AI 读条款文本 + `lib/concept-dict.js`，按硬纪律输出 liability/benefits——不依赖外部 AI API（`DEEPSEEK_API_KEY` 失效不再阻塞）；`parse-product.js` 保留为无 AI 助手时的替代（需有效 key）
- **写库由 AI 经 cloudbase MCP 完成**：`writeNoSqlDatabaseContent` 新增 products 文档（`_openid` 取自当前会话/agents，建档人维度）；`status='confirmed'` + `confirm_log` + `source.url` 留痕；`products` schema 见 `docs/prd.md`
- **报告消费**：仅 `confirmed` 的 products 注入深度分析上下文（每产品 ~200-400 tokens）；责任对比仅代理人版，客户版只展示权益卡
