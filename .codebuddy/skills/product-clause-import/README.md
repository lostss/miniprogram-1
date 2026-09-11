# product-clause-import — 产品条款导入

开发者后台技能：**获取条款 PDF → 提取文本 → AI 概念化提取（liability + benefits）→ 人工确认 → 入库 products**。

- SOP 与纪律约束见 `SKILL.md`
- 概念字典 v1：`lib/concept-dict.js`（重疾/医疗/寿险/意外）
- 校验：`lib/schema-validate.js`（null 合法、未知键收集、类型检查）
- 回归样本：`fixtures/clause.pdf`（新华人寿条款，7 页，已验证提取 ≥9000 字符）

## 快速开始

```powershell
# 1. 安装依赖（pdf-parse@1.1.1，锁定版本——v2 依赖 pdfjs-dist 34MB 不可用）
cd .codebuddy/skills/product-clause-import
npm install

# 2. 设置 API key（AI 概念化用）
$env:DEEPSEEK_API_KEY = "sk-..."

# 3. 全链路示例
node scripts/fetch-clause.js "https://.../条款.pdf" --out out/clause.pdf
node scripts/extract-pdf.js out/clause.pdf --out out/clause.txt
node scripts/parse-product.js out/clause.txt --name "康宁终身" --category 重疾 --out out/product.json
# 4. 展示 out/product.json → 用户逐项确认
# 5. 经 cloudbase MCP/CLI 写 products（status=confirmed + confirm_log + source.url）
```

## 验收

- 端到端建档一次：条款直链 → `products` 文档（confirmed + 留痕完整）
- 回归：`node scripts/extract-pdf.js fixtures/clause.pdf` → OK（≥9000 字符）
- 负例：扫描件 PDF → exit 2 + 明确提示

## 批量建档

```powershell
# 批量下载官方条款（LIST 内含 8 产品样本，新增产品追加 {name,url}）
node scripts/batch-fetch.js
# 逐份提取
node scripts/extract-pdf.js out/clauses/<产品名>.pdf --out out/clauses/<产品名>.txt
# 概念化 + MCP 写库见 SKILL.md「批量建档」章节（MCP update 须逐个串行 + 半角标点 + 手动带 _openid）
```

## 技术要点

- **pdf-parse 锁定 1.1.1**（函数 API；npm 包含多版本 pdf.js + sourcemap 共 31MB，本地后台无包限制，无需裁剪）
- **仅文本型 PDF**：扫描件（提取 <100 字符）拒绝，不逐页 OCR
- **AI 调用**：DeepSeek `deepseek-v4-flash`，`DEEPSEEK_API_KEY` 环境变量；temperature=0（提取确定性）
- **长条款**：v1 取前 20000 字符（分块聚合为后续版本）
- **报告消费**：仅 `confirmed` 的 products 注入深度分析上下文（见 docs/prd.md 4.5 消费端）；责任对比仅代理人版，客户版只展示权益卡
