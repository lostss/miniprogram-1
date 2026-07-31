# OCR 批量拼接提取实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `aiExtractBatch` action，将 N 张图 OCR 结果拼接为 1 次 AI 调用，超限时对半拆分降级，前端通过 `OCR_BATCH_MODE` 开关切换新旧方案。

**Architecture:** 云函数侧新增 `buildBatchExtractionPrompt`（prompt 构建）+ `aiExtractBatchPhase`（编排层，含拆分降级）+ `aiExtractBatch` handler。前端 `ocr-flow.js` 新增 `batchOCR_merged` 函数，与原 `batchOCR` 并存，通过顶部 `OCR_BATCH_MODE` 变量切换。阶段1 `ocrOnly` 完全复用。

**Tech Stack:** Node.js（云函数）+ JavaScript（小程序前端）+ Jest（单元测试）+ wx-server-sdk（云开发）

## Global Constraints

- 测试框架：Jest，测试文件位于 `tests/`，mock `wx-server-sdk` 用 `tests/__mocks__/cloudSDKMock.js`
- 共享模块：`cloudfunctions/_shared/` 是源目录，修改后必须运行 `node scripts/sync-shared.js --prune` 同步到各云函数
- 路由约定：handler 通过 `module.exports = { action1, action2 }` 注册，`createHandler` 按 `event.action` 分发
- AI 调用：统一走 `safeCallChat(messages, callChat, ctx, opts)`，返回 `{ text, usage, logId }`
- 数据库字段：snake_case（如 `policy_number`、`family_id`）
- 当前代码状态：git commit `12f86d7`（首个可用版本），**无** DeepSeek 直连代码，AI 走 TokenHub `callChat`
- 不修改范围：`ocrPhase`、`ocrRecognize`、`ocrOnly`、`buildExtractionPrompt`、`aiExtract` handler、`buildPolicyFromExtract`、`calcConfidence`

---

## File Structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `cloudfunctions/_shared/config.js` | 新增 OCR_BATCH_* 配置 | 修改 |
| `cloudfunctions/ocrService/prompts.js` | 新增 `buildBatchExtractionPrompt` | 修改 |
| `cloudfunctions/_shared/ocr-core.js` | 新增 `aiExtractBatchPhase` + 辅助函数 | 修改 |
| `cloudfunctions/ocrService/handlers.js` | 新增 `aiExtractBatch` handler | 修改 |
| `miniprogram/utils/ocr-flow.js` | 新增 `batchOCR_merged` + `OCR_BATCH_MODE` 开关 | 修改 |
| `tests/batchPrompt.test.js` | `buildBatchExtractionPrompt` 单元测试 | 新建 |
| `tests/batchExtractPhase.test.js` | `aiExtractBatchPhase` 单元测试 | 新建 |
| `tests/batchHandler.test.js` | `aiExtractBatch` handler 单元测试 | 新建 |

---

### Task 1: 新增 config 配置项

**Files:**
- Modify: `cloudfunctions/_shared/config.js`

**Interfaces:**
- Produces: `AI.OCR_BATCH_MAX_CHARS`（84000）、`AI.OCR_BATCH_MAX_TOKENS`（4000）、`AI.OCR_BATCH_TIMEOUT`（30000）、`AI.OCR_BATCH_TEMPERATURE`（0）

- [ ] **Step 1: 修改 config.js，在 AI 对象内新增批量配置**

读取 `cloudfunctions/_shared/config.js`，定位到 `AI: {` 块，在 `OCR_TEMPERATURE: 0,` 之后新增 4 个配置项。

修改后的 AI 块应为：

```js
  AI: {
    GROUP: 'cloudbase',
    THINK_MODEL: 'hy3',
    CHAT_MODEL: 'hy3',
    OCR_MODEL: 'hy3',
    SDK_TIMEOUT: 60000,
    THINK_TIMEOUT: 55000,
    MAX_RETRIES: 2,
    OCR_MAX_TOKENS: 1200,
    OCR_TEMPERATURE: 0,
    // 批量拼接提取（aiExtractBatch）
    OCR_BATCH_MAX_CHARS: 84000,       // 拼接上限字符数（约 56K input token）
    OCR_BATCH_MAX_TOKENS: 4000,       // 批量模式输出 token 上限
    OCR_BATCH_TIMEOUT: 30000,         // 批量模式 AI 超时
    OCR_BATCH_TEMPERATURE: 0
  },
```

- [ ] **Step 2: 同步到各云函数**

Run: `node scripts/sync-shared.js --prune`
Expected: 输出 `Done: 0 created, X updated, Y unchanged, 0 pruned`，ocrService/_shared/config.js 被更新

- [ ] **Step 3: 验证同步结果**

读取 `cloudfunctions/ocrService/_shared/config.js`，确认 `OCR_BATCH_MAX_CHARS: 84000` 存在。

- [ ] **Step 4: Commit**

```bash
git add cloudfunctions/_shared/config.js cloudfunctions/ocrService/_shared/config.js
git commit -m "feat(config): 新增 OCR 批量拼接提取配置项"
```

---

### Task 2: 实现 buildBatchExtractionPrompt（prompt 构建）

**Files:**
- Modify: `cloudfunctions/ocrService/prompts.js`
- Test: `tests/batchPrompt.test.js`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `buildBatchExtractionPrompt(ocrResults) → { systemPrompt, userPrompt }`
  - `ocrResults`: `[{ fileId, ocrText, ocrConfInfo, t0, t1, t2 }, ...]`
  - `systemPrompt`: string（含批量输出契约约束）
  - `userPrompt`: string（含 `【图片_N】` 标记拼接 + 置信度独立标注）

- [ ] **Step 1: 写失败测试**

创建 `tests/batchPrompt.test.js`：

```js
/**
 * buildBatchExtractionPrompt 单元测试
 */
const { buildBatchExtractionPrompt, BATCH_SYSTEM_PROMPT } = require('../cloudfunctions/ocrService/prompts')

describe('buildBatchExtractionPrompt', () => {
  test('单张图：拼接格式正确，含【图片_1】标记', () => {
    const ocrResults = [
      { fileId: 'cloud://f1', ocrText: '投保人李阳勇', ocrConfInfo: [{ text: '投保人李阳勇', ocr_conf: 98 }] }
    ]
    const { systemPrompt, userPrompt } = buildBatchExtractionPrompt(ocrResults)
    expect(systemPrompt).toContain('JSON 数组')
    expect(systemPrompt).toContain('idx')
    expect(userPrompt).toContain('【图片_1】')
    expect(userPrompt).toContain('投保人李阳勇')
  })

  test('多张图：每张图都有独立的【图片_N】标记', () => {
    const ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '保单B', ocrConfInfo: [] },
      { fileId: 'cloud://f3', ocrText: '现价表C', ocrConfInfo: [] }
    ]
    const { userPrompt } = buildBatchExtractionPrompt(ocrResults)
    expect(userPrompt).toContain('【图片_1】')
    expect(userPrompt).toContain('【图片_2】')
    expect(userPrompt).toContain('【图片_3】')
    expect(userPrompt).toContain('保单A')
    expect(userPrompt).toContain('保单B')
    expect(userPrompt).toContain('现价表C')
  })

  test('置信度独立标注：每张图的置信度附在该图块下方', () => {
    const ocrResults = [
      { fileId: 'cloud://f1', ocrText: 'text1', ocrConfInfo: [{ text: '张三', ocr_conf: 95 }] },
      { fileId: 'cloud://f2', ocrText: 'text2', ocrConfInfo: [{ text: '李四', ocr_conf: 88 }] }
    ]
    const { userPrompt } = buildBatchExtractionPrompt(ocrResults)
    expect(userPrompt).toContain('[图片_1 字符级置信度参考]')
    expect(userPrompt).toContain('[图片_2 字符级置信度参考]')
    expect(userPrompt).toContain('张三')
    expect(userPrompt).toContain('李四')
  })

  test('空 ocrConfInfo：显示无置信度信息', () => {
    const ocrResults = [
      { fileId: 'cloud://f1', ocrText: 'text', ocrConfInfo: [] }
    ]
    const { userPrompt } = buildBatchExtractionPrompt(ocrResults)
    expect(userPrompt).toContain('无字符级置信度信息')
  })

  test('systemPrompt 包含批量输出契约关键约束', () => {
    const { systemPrompt } = buildBatchExtractionPrompt([])
    expect(systemPrompt).toContain('JSON 数组')
    expect(systemPrompt).toContain('idx')
    expect(systemPrompt).toContain('单张图失败不影响其他图')
  })

  test('OCR 文本超长截断：单张图 ocrText 截断到 4000 字符', () => {
    const longText = 'A'.repeat(5000)
    const ocrResults = [
      { fileId: 'cloud://f1', ocrText: longText, ocrConfInfo: [] }
    ]
    const { userPrompt } = buildBatchExtractionPrompt(ocrResults)
    // 截断后【图片_1】块内不应超过 4000 字符的 A
    const aCount = (userPrompt.match(/A/g) || []).length
    expect(aCount).toBeLessThanOrEqual(4000)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/batchPrompt.test.js --verbose`
Expected: FAIL，`buildBatchExtractionPrompt is not a function`

- [ ] **Step 3: 实现 buildBatchExtractionPrompt**

在 `cloudfunctions/ocrService/prompts.js` 末尾（`module.exports` 之前）新增：

```js
// ======================== 批量提取系统提示词 ========================
const BATCH_SYSTEM_PROMPT = `你是保单信息批量提取 AI。输入包含多张图片的 OCR 文本，每张图以【图片_N】标记分隔。你需要为每张图独立提取保单信息，输出严格 JSON 数组。

【单图文档类型判断】
对每张图独立判断 document_type：
- "policy" → 保单，按保单格式输出
- "cash_value" → 纯现价表，按现价表格式输出
- "mixed" → 一张图同时含保单 + 现价表，两者都输出
- "unknown" → 无法识别，该图 result="fail"

【输出格式 — JSON 数组】
顶层必须是 JSON 数组，长度严格等于输入图片数 N。每个元素结构：
[
  {
    "idx": 1,
    "document_type": "policy" | "cash_value" | "mixed" | "unknown",
    "result": "success" | "fail",
    "message": "失败原因（fail 时必填）",
    "data": {
      "contract_basic": {
        "policy_number": "", "insurance_company": "", "contract_effective_date": "",
        "policyholder_name": "", "insured_name": "", "beneficiary_name": "",
        "special_agreement": "", "insured_birth_date": "",
        "policyholder_birth_date": "", "beneficiary_birth_date": ""
      },
      "products": [
        { "product_name": "", "insurance_category": "", "insurance_type": "",
          "insurance_period": "", "sum_assured": 0, "payment_method": "",
          "payment_period": "", "annual_premium": 0 }
      ],
      "field_confidence": {
        "policy_number": 0.0, "insurance_company": 0.0,
        "policyholder_name": 0.0, "insured_name": 0.0,
        "sum_assured": 0.0, "annual_premium": 0.0
      },
      "overall_confidence": 0.0
    },
    "cash_value_data": {
      "header_info": { "product_name": "", "insured_name": "", "policy_number": "", "insurance_type": "" },
      "cash_values": [ { "y": 1, "v": 0, "n": "可选标注" } ],
      "overall_confidence": 0.0
    }
  }
]

document_type 为 "policy" 时只输出 data；"cash_value" 时只输出 cash_value_data；"mixed" 时两者都输出；"unknown" 时 data 和 cash_value_data 都省略。

【不可变更的核心约束】
1. 顶层必须是 JSON 数组，长度严格等于输入图片数 N
2. 数组每个元素的 idx 必须从 1 递增到 N，与输入【图片_N】一一对应
3. 每张图独立判断 document_type 和 result，单张图失败不影响其他图
4. 仅输出 JSON，不输出任何解释、markdown、注释
5. 字段必须使用上述名称，禁止臆造字段名
6. 字段值缺失返回空字符串 ""，数字字段缺失返回 0
7. field_confidence 取值 0.0-1.0，overall_confidence = field_confidence 各字段平均值
8. 日期格式 YYYY-MM-DD；金额数字（单位元，不带"元"字）
9. insurance_category 白名单：寿险/重疾/医疗/意外/年金/养老/教育/投连/万能/其他
10. payment_method 白名单：趸交/年交/半年交/季交/月交
11. 投保人=被保人：若保单未明确区分且仅出现一个姓名，同时填入 policyholder_name 和 insured_name
12. cash_values 中 y=保单年度（整数），v=现金价值（元，纯数字），n=可选特殊标注
13. special_agreement 含身份证号/银行卡号/手机号原样提取，由后端脱敏`

/**
 * 构建批量提取提示词
 * @param {Array<{fileId:string, ocrText:string, ocrConfInfo:Array, t0:number, t1:number, t2:number}>} ocrResults
 * @returns {{systemPrompt: string, userPrompt: string}}
 */
function buildBatchExtractionPrompt(ocrResults) {
  const systemPrompt = BATCH_SYSTEM_PROMPT

  const blocks = ocrResults.map(function(item, i) {
    var idx = i + 1
    var ocrText = (item.ocrText || '').substring(0, 4000)
    var confs = (item.ocrConfInfo || [])
      .filter(function(c) { return c && typeof c.ocr_conf === 'number' })
      .slice(0, 30)
    var confLines = confs.length > 0
      ? confs.map(function(c) { return '  "' + c.text + '" ' + c.ocr_conf + '%' }).join('\n')
      : '  无字符级置信度信息'

    return '【图片_' + idx + '】\n' + ocrText + '\n\n[图片_' + idx + ' 字符级置信度参考]\n' + confLines
  })

  var userPrompt = '请从以下多张图片的 OCR 文本中独立提取每张图的保单信息，按系统提示词约定的 JSON 数组格式返回。每张图独立判断 document_type 和 result。\n\n' + blocks.join('\n\n')

  return { systemPrompt: systemPrompt, userPrompt: userPrompt }
}
```

更新 `module.exports`：

```js
module.exports = { buildExtractionPrompt, SYSTEM_PROMPT, buildBatchExtractionPrompt, BATCH_SYSTEM_PROMPT }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/batchPrompt.test.js --verbose`
Expected: PASS，6 个测试全部通过

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/ocrService/prompts.js tests/batchPrompt.test.js
git commit -m "feat(prompt): 实现 buildBatchExtractionPrompt 批量拼接提示词"
```

---

### Task 3: 实现 aiExtractBatchPhase（编排层，含拆分降级）

**Files:**
- Modify: `cloudfunctions/_shared/ocr-core.js`
- Test: `tests/batchExtractPhase.test.js`

**Interfaces:**
- Consumes: `buildBatchExtractionPrompt`（Task 2）、`buildPolicyFromExtract`、`calcConfidence`、`safeCallChat`、`callChat`、`AI_TIMEOUT`、`AI`（config）
- Produces: `aiExtractBatchPhase(ocrResults, deps) → { results, totalDurationMs, splitUsed, aiCallCount, tokens, successCount, failCount }`
  - `deps`: `{ cloud, db, openid, familyId, buildBatchExtractionPrompt, safeCallChat, callChat, AI_TIMEOUT }`
  - `results`: `[{ idx, fileId, success, policies?, cashValueData?, documentType?, error?, errorCode? }, ...]`

- [ ] **Step 1: 写失败测试**

创建 `tests/batchExtractPhase.test.js`：

```js
/**
 * aiExtractBatchPhase 单元测试
 * mock safeCallChat + callChat，验证编排逻辑
 */
jest.mock('wx-server-sdk', () => require('./__mocks__/cloudSDKMock'))

const { aiExtractBatchPhase } = require('../cloudfunctions/_shared/ocr-core')

// mock buildBatchExtractionPrompt
function mockBuildPrompt(ocrResults) {
  return { systemPrompt: 'SYS', userPrompt: 'USER ' + ocrResults.length }
}

// 构造 mock safeCallChat，返回指定的 JSON 数组
function makeSafeCallChat(aiResponseArray) {
  return async function(messages, callChat, ctx, opts) {
    return {
      text: JSON.stringify(aiResponseArray),
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 }
    }
  }
}

//  noop callChat（实际由 safeCallChat mock 接管）
var noopCallChat = async function() { return { text: '', usage: {} } }

var mockDeps = {
  cloud: {}, db: { collection: function() { return { add: function() { return Promise.resolve({}) } } } },
  openid: 'o1', familyId: 'f1',
  buildBatchExtractionPrompt: mockBuildPrompt,
  safeCallChat: makeSafeCallChat([]),
  callChat: noopCallChat,
  AI_TIMEOUT: { OCR: 15000 }
}

describe('aiExtractBatchPhase', () => {
  test('单次调用：3张图全部成功，返回3个 policies 结果', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '保单B', ocrConfInfo: [] },
      { fileId: 'cloud://f3', ocrText: '保单C', ocrConfInfo: [] }
    ]
    var aiResp = [
      { idx: 1, document_type: 'policy', result: 'success', data: { contract_basic: { policy_number: 'P001', policyholder_name: '张三', insured_name: '张三' }, products: [{ product_name: '重疾险', sum_assured: 500000, annual_premium: 5000 }], field_confidence: { policy_number: 0.9, insurance_company: 0.9, policyholder_name: 0.9, insured_name: 0.9, sum_assured: 0.9, annual_premium: 0.9 }, overall_confidence: 0.9 } },
      { idx: 2, document_type: 'policy', result: 'success', data: { contract_basic: { policy_number: 'P002' }, products: [{ product_name: '医疗险' }], field_confidence: {}, overall_confidence: 0.8 } },
      { idx: 3, document_type: 'policy', result: 'success', data: { contract_basic: {}, products: [{ product_name: '意外险' }], field_confidence: {}, overall_confidence: 0.85 } }
    ]
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(aiResp) })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results.length).toBe(3)
    expect(res.results[0].success).toBe(true)
    expect(res.results[0].policies.length).toBe(1)
    expect(res.results[0].policies[0].product_name).toBe('重疾险')
    expect(res.results[1].success).toBe(true)
    expect(res.results[2].success).toBe(true)
    expect(res.splitUsed).toBe(false)
    expect(res.aiCallCount).toBe(1)
    expect(res.successCount).toBe(3)
    expect(res.failCount).toBe(0)
  })

  test('部分失败：某张图 result=fail，其他图正常返回', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '非保单', ocrConfInfo: [] }
    ]
    var aiResp = [
      { idx: 1, document_type: 'policy', result: 'success', data: { contract_basic: {}, products: [{ product_name: '寿险' }], field_confidence: {}, overall_confidence: 0.85 } },
      { idx: 2, document_type: 'unknown', result: 'fail', message: '无法识别保单信息' }
    ]
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(aiResp) })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(true)
    expect(res.results[1].success).toBe(false)
    expect(res.results[1].errorCode).toBe('ai_extract_failed')
    expect(res.results[1].error).toBe('无法识别保单信息')
    expect(res.successCount).toBe(1)
    expect(res.failCount).toBe(1)
  })

  test('AI 返回数组长度不匹配：缺失的 idx 标记 ai_length_mismatch', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '保单B', ocrConfInfo: [] },
      { fileId: 'cloud://f3', ocrText: '保单C', ocrConfInfo: [] }
    ]
    // AI 只返回 2 个（缺 idx=2）
    var aiResp = [
      { idx: 1, document_type: 'policy', result: 'success', data: { contract_basic: {}, products: [{ product_name: 'A' }], field_confidence: {}, overall_confidence: 0.8 } },
      { idx: 3, document_type: 'policy', result: 'success', data: { contract_basic: {}, products: [{ product_name: 'C' }], field_confidence: {}, overall_confidence: 0.8 } }
    ]
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(aiResp) })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(true)
    expect(res.results[1].success).toBe(false)
    expect(res.results[1].errorCode).toBe('ai_length_mismatch')
    expect(res.results[2].success).toBe(true)
  })

  test('AI 返回非数组 JSON：所有图标记 ai_format', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] }
    ]
    var deps = Object.assign({}, mockDeps, {
      safeCallChat: async function() { return { text: '{"result":"success"}', usage: {} } }
    })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(false)
    expect(res.results[0].errorCode).toBe('ai_format')
  })

  test('safeCallChat 抛错：所有图标记 ai_batch_failed', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '保单B', ocrConfInfo: [] }
    ]
    var deps = Object.assign({}, mockDeps, {
      safeCallChat: async function() { var e = new Error('AI 5xx'); e.code = 'ERR_BAD_RESPONSE'; throw e }
      })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(false)
    expect(res.results[0].errorCode).toBe('ai_batch_failed')
    expect(res.results[1].success).toBe(false)
    expect(res.results[1].errorCode).toBe('ai_batch_failed')
  })

  test('超限拆分：总字符数超过 84000 触发对半拆分，aiCallCount=2', async () => {
    // 构造 2 张图，每张 50000 字符（总 100000 > 84000）
    var longText = 'A'.repeat(50000)
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: longText, ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: longText, ocrConfInfo: [] }
    ]
    // 每次 AI 调用返回单图成功
    var callCount = 0
    var deps = Object.assign({}, mockDeps, {
      safeCallChat: async function() {
        callCount++
        return {
          text: JSON.stringify([{ idx: 1, document_type: 'policy', result: 'success', data: { contract_basic: {}, products: [{ product_name: 'P' + callCount }], field_confidence: {}, overall_confidence: 0.8 } }]),
          usage: { total_tokens: 300 }
        }
      }
    })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.splitUsed).toBe(true)
    expect(res.aiCallCount).toBe(2)
    expect(res.results.length).toBe(2)
    expect(res.results[0].success).toBe(true)
    expect(res.results[1].success).toBe(true)
    expect(callCount).toBe(2)
  })

  test('现价表提取：document_type=cash_value 时返回 cashValueData', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '现价表', ocrConfInfo: [] }
    ]
    var aiResp = [
      {
        idx: 1, document_type: 'cash_value', result: 'success',
        cash_value_data: {
          header_info: { product_name: '阳光人寿i保', insured_name: '李阳勇' },
          cash_values: [{ y: 1, v: 0 }, { y: 2, v: 5800 }],
          overall_confidence: 0.88
        }
      }
    ]
    var deps = Object.assign({}, mockDeps, { safeCallChat: makeSafeCallChat(aiResp) })

    var res = await aiExtractBatchPhase(ocrResults, deps)
    expect(res.results[0].success).toBe(true)
    expect(res.results[0].cashValueData).toBeTruthy()
    expect(res.results[0].cashValueData.product_name).toBe('阳光人寿i保')
    expect(res.results[0].cashValueData.cash_values.length).toBe(2)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/batchExtractPhase.test.js --verbose`
Expected: FAIL，`aiExtractBatchPhase is not a function`

- [ ] **Step 3: 实现 aiExtractBatchPhase**

在 `cloudfunctions/_shared/ocr-core.js` 末尾（`module.exports` 之前）新增：

```js
// ---- 批量 AI 提取（拼接 N 张图为 1 次调用，超限对半拆分） ----
const { parseAIJSON: _parseBatchJSON } = require('./parse-ai-json')

/**
 * 单次批量 AI 调用（不拆分）
 * @returns {{ results, tokens, aiCallCount }}
 */
async function _callBatchAI(ocrResults, deps) {
  const { buildBatchExtractionPrompt, safeCallChat, callChat, cloud, db, openid, familyId, AI_TIMEOUT } = deps
  const { AI } = require('./config')
  const { systemPrompt, userPrompt } = buildBatchExtractionPrompt(ocrResults)
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
  const sessionId = 'ocr_batch_' + Date.now().toString(36)
  const res = await safeCallChat(
    messages, callChat,
    { cloud, db, openid, familyId, sessionId, model: AI.OCR_MODEL, action: 'ocr_extract_batch', skipInjection: true, skipOutputAudit: true, skipContentSafety: true },
    { maxTokens: AI.OCR_BATCH_MAX_TOKENS, temperature: AI.OCR_BATCH_TEMPERATURE, responseFormat: { type: 'json_object' }, timeoutMs: AI.OCR_BATCH_TIMEOUT, cacheKey: 'ocr-batch-v1' }
  )
  const parsed = _parseBatchJSON(res.text)
  if (!Array.isArray(parsed)) {
    throw new Error('ai_format')
  }
  return { aiResponse: parsed, tokens: res.usage || {}, aiCallCount: 1 }
}

/**
 * 构建单图结果对象（从 AI 返回的单个元素）
 */
function _buildSingleResult(item, ocrResult) {
  const idx = ocrResults_idxOf(ocrResult)
  if (item.result !== 'success') {
    return { idx: idx, fileId: ocrResult.fileId, success: false, error: item.message || 'AI提取失败', errorCode: 'ai_extract_failed' }
  }
  const docType = item.document_type || 'policy'
  const data = item.data || {}
  const contractBasic = data.contract_basic || {}
  const aiFieldConf = data.field_confidence || {}
  const aiOverall = typeof data.overall_confidence === 'number'
    ? data.overall_confidence
    : (Object.keys(aiFieldConf).length > 0
        ? Object.values(aiFieldConf).reduce((s, v) => s + v, 0) / Object.keys(aiFieldConf).length
        : 0.7)
  const { fieldConf, overallConf, ocrReliable, autoConfirmed } = calcConfidence(ocrResult.ocrConfInfo, aiFieldConf, aiOverall)
  const products = data.products || []
  const newPolicies = buildPolicyFromExtract(products, contractBasic, { overallConf, fieldConf, ocrReliable, autoConfirmed })

  let cashValueData = null
  if ((docType === 'cash_value' || docType === 'mixed') && item.cash_value_data) {
    const cvd = item.cash_value_data
    const hi = cvd.header_info || {}
    const cvArr = (cvd.cash_values || []).map(cv => {
      const row = { y: cv.y, v: _toNum(cv.v) }
      if (cv.n) row.n = cv.n
      return row
    })
    cashValueData = {
      product_name: hi.product_name || (products.length > 0 ? products[0].product_name : '') || '',
      insured_name: hi.insured_name || contractBasic.insured_name || '',
      policy_number: hi.policy_number || contractBasic.policy_number || '',
      insurance_type: hi.insurance_type || '',
      cash_values: cvArr,
      overall_confidence: typeof cvd.overall_confidence === 'number' ? cvd.overall_confidence : overallConf
    }
  }
  return { idx: idx, fileId: ocrResult.fileId, success: true, policies: newPolicies, cashValueData: cashValueData, documentType: docType }
}

// 辅助：ocrResult 在原数组中的 idx（1-based），由调用方通过闭包传入
function ocrResults_idxOf(ocrResult) { return ocrResult._batchIdx }

/**
 * 批量 AI 提取编排（含对半拆分降级）
 * @param {Array} ocrResults - [{ fileId, ocrText, ocrConfInfo, ... }]
 * @param {object} deps - { cloud, db, openid, familyId, buildBatchExtractionPrompt, safeCallChat, callChat, AI_TIMEOUT }
 * @returns {{ results, totalDurationMs, splitUsed, aiCallCount, tokens, successCount, failCount }}
 */
async function aiExtractBatchPhase(ocrResults, deps) {
  const t0 = Date.now()
  const { AI } = require('./config')
  const totalChars = ocrResults.reduce((s, r) => s + (r.ocrText || '').length, 0)

  // 标记每项的 1-based idx（用于 _buildSingleResult 读取）
  ocrResults = ocrResults.map((r, i) => Object.assign({}, r, { _batchIdx: i + 1 }))

  if (totalChars <= AI.OCR_BATCH_MAX_CHARS || ocrResults.length === 1) {
    // 未超限：1 次调用
    try {
      const { aiResponse, tokens, aiCallCount } = await _callBatchAI(ocrResults, deps)
      const results = _assembleResults(ocrResults, aiResponse)
      const t1 = Date.now()
      return _summarize(results, tokens, aiCallCount, t1 - t0, false)
    } catch (e) {
      const results = ocrResults.map(r => ({ idx: r._batchIdx, fileId: r.fileId, success: false, error: (e && e.message) || 'AI异常', errorCode: e.code === 'ai_format' ? 'ai_format' : 'ai_batch_failed' }))
      const t1 = Date.now()
      return _summarize(results, {}, 1, t1 - t0, false)
    }
  }

  // 超限：对半拆分
  const mid = Math.ceil(ocrResults.length / 2)
  const left = ocrResults.slice(0, mid)
  const right = ocrResults.slice(mid)

  const [leftRes, rightRes] = await Promise.all([
    aiExtractBatchPhase(left, deps),
    aiExtractBatchPhase(right, deps)
  ])

  // 重新编号 right 部分 idx 并合并（right 的 idx 是 1..N-mid，需偏移到 mid+1..N）
  const adjustedRight = rightRes.results.map(r => ({ ...r, idx: r.idx + mid }))
  const mergedResults = leftRes.results.concat(adjustedRight)
  const mergedTokens = _mergeTokens(leftRes.tokens, rightRes.tokens)
  const mergedAiCallCount = leftRes.aiCallCount + rightRes.aiCallCount
  const t1 = Date.now()
  return _summarize(mergedResults, mergedTokens, mergedAiCallCount, t1 - t0, true)
}

/**
 * 组装结果：AI 返回数组与输入 ocrResults 对齐，校验 idx/长度
 */
function _assembleResults(ocrResults, aiResponse) {
  // 按 idx 建索引
  var byIdx = {}
  for (var i = 0; i < aiResponse.length; i++) {
    var item = aiResponse[i]
    if (item && typeof item.idx === 'number') byIdx[item.idx] = item
  }
  var results = []
  for (var j = 0; j < ocrResults.length; j++) {
    var ocr = ocrResults[j]
    var expectedIdx = j + 1
    var item = byIdx[expectedIdx]
    if (!item) {
      results.push({ idx: expectedIdx, fileId: ocr.fileId, success: false, error: 'AI返回缺失该图', errorCode: 'ai_length_mismatch' })
    } else {
      results.push(_buildSingleResult(item, ocr))
    }
  }
  return results
}

function _summarize(results, tokens, aiCallCount, totalDurationMs, splitUsed) {
  var successCount = 0, failCount = 0
  for (var i = 0; i < results.length; i++) {
    if (results[i].success) successCount++
    else failCount++
  }
  return { results, totalDurationMs, splitUsed, aiCallCount, tokens, successCount, failCount }
}

function _mergeTokens(t1, t2) {
  if (!t1 && !t2) return {}
  var a = t1 || {}, b = t2 || {}
  return {
    prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
    completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0),
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0)
  }
}
```

更新 `module.exports`：

```js
module.exports = { processOneImage, ocrPhase, aiPhase, aiExtractBatchPhase, matchPoliciesToMembers, buildPolicyFromExtract, _toNum }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/batchExtractPhase.test.js --verbose`
Expected: PASS，7 个测试全部通过

- [ ] **Step 5: 同步 _shared 到各云函数**

Run: `node scripts/sync-shared.js --prune`
Expected: ocrService/_shared/ocr-core.js 被更新

- [ ] **Step 6: Commit**

```bash
git add cloudfunctions/_shared/ocr-core.js cloudfunctions/ocrService/_shared/ocr-core.js tests/batchExtractPhase.test.js
git commit -m "feat(ocr-core): 实现 aiExtractBatchPhase 批量编排与对半拆分降级"
```

---

### Task 4: 实现 aiExtractBatch handler（云函数入口）

**Files:**
- Modify: `cloudfunctions/ocrService/handlers.js`
- Test: `tests/batchHandler.test.js`

**Interfaces:**
- Consumes: `aiExtractBatchPhase`（Task 3）、`buildBatchExtractionPrompt`（Task 2）、`logOperation`
- Produces: `aiExtractBatch(db, openid, event)` handler，按 `event.action='aiExtractBatch'` 路由
  - 入参 `event`: `{ ocr_results: [...], familyId? }`
  - 返回: `{ code: 200, data: { results, total_duration_ms, split_used, ai_call_count } }`

- [ ] **Step 1: 写失败测试**

创建 `tests/batchHandler.test.js`：

```js
/**
 * aiExtractBatch handler 单元测试
 */
jest.mock('wx-server-sdk', () => require('./__mocks__/cloudSDKMock'))

const handlers = require('../cloudfunctions/ocrService/handlers')

// mock aiExtractBatchPhase
jest.mock('../cloudfunctions/ocrService/_shared/ocr-core', () => {
  var actual = jest.requireActual('../cloudfunctions/ocrService/_shared/ocr-core')
  return {
    ...actual,
    aiExtractBatchPhase: jest.fn()
  }
})

const { aiExtractBatchPhase } = require('../cloudfunctions/ocrService/_shared/ocr-core')

var mockDb = {
  collection: function() {
    return {
      add: function() { return Promise.resolve({ _id: 'log1' }) },
      where: function() { return this },
      update: function() { return Promise.resolve({}) }
    }
  }
}

describe('aiExtractBatch handler', () => {
  beforeEach(() => { aiExtractBatchPhase.mockReset() })

  test('参数校验：缺少 ocr_results 返回 400', async () => {
    var res = await handlers.aiExtractBatch(mockDb, 'o1', { familyId: 'f1' })
    expect(res.code).toBe(400)
    expect(res.msg).toContain('ocr_results')
  })

  test('参数校验：ocr_results 非数组返回 400', async () => {
    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: 'notarray' })
    expect(res.code).toBe(400)
  })

  test('参数校验：空数组返回 400', async () => {
    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: [] })
    expect(res.code).toBe(400)
  })

  test('参数校验：超过 10 张返回 400', async () => {
    var ocrResults = Array.from({ length: 11 }, function(_, i) { return { fileId: 'cloud://f' + i, ocrText: 'text', ocrConfInfo: [] } })
    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: ocrResults })
    expect(res.code).toBe(400)
    expect(res.msg).toContain('10')
  })

  test('空 ocrText 过滤：标记 ocr_empty，不参与 AI 调用', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '', ocrConfInfo: [] }
    ]
    aiExtractBatchPhase.mockResolvedValue({
      results: [{ idx: 1, fileId: 'cloud://f1', success: true, policies: [{ product_name: 'A' }] }],
      totalDurationMs: 5000, splitUsed: false, aiCallCount: 1, tokens: {}, successCount: 1, failCount: 0
    })

    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: ocrResults, familyId: 'f1' })
    expect(res.code).toBe(200)
    expect(res.data.results.length).toBe(2)
    expect(res.data.results[0].success).toBe(true)
    expect(res.data.results[1].success).toBe(false)
    expect(res.data.results[1].errorCode).toBe('ocr_empty')
    // aiExtractBatchPhase 只收到 1 个有效 ocrResult
    expect(aiExtractBatchPhase.mock.calls[0][0].length).toBe(1)
  })

  test('正常调用：返回 results 和元数据', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '保单B', ocrConfInfo: [] }
    ]
    aiExtractBatchPhase.mockResolvedValue({
      results: [
        { idx: 1, fileId: 'cloud://f1', success: true, policies: [{ product_name: 'A' }] },
        { idx: 2, fileId: 'cloud://f2', success: true, policies: [{ product_name: 'B' }] }
      ],
      totalDurationMs: 8500, splitUsed: false, aiCallCount: 1, tokens: { total_tokens: 500 }, successCount: 2, failCount: 0
    })

    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: ocrResults, familyId: 'f1' })
    expect(res.code).toBe(200)
    expect(res.data.results.length).toBe(2)
    expect(res.data.total_duration_ms).toBe(8500)
    expect(res.data.split_used).toBe(false)
    expect(res.data.ai_call_count).toBe(1)
  })

  test('整体异常：所有图标记 ai_batch_failed', async () => {
    var ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] }
    ]
    aiExtractBatchPhase.mockRejectedValue(new Error('AI 服务异常'))

    var res = await handlers.aiExtractBatch(mockDb, 'o1', { ocr_results: ocrResults, familyId: 'f1' })
    expect(res.code).toBe(200)
    expect(res.data.results.length).toBe(1)
    expect(res.data.results[0].success).toBe(false)
    expect(res.data.results[0].errorCode).toBe('ai_batch_failed')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/batchHandler.test.js --verbose`
Expected: FAIL，`handlers.aiExtractBatch is not a function`

- [ ] **Step 3: 实现 aiExtractBatch handler**

在 `cloudfunctions/ocrService/handlers.js` 中，先更新顶部 require：

```js
const cloud = require('wx-server-sdk')
const { ocrPhase, aiPhase, aiExtractBatchPhase } = require('./_shared/ocr-core')
const { buildExtractionPrompt, buildBatchExtractionPrompt } = require('./prompts')
const { logOperation } = require('./_shared/logSeam')
const { wrapError } = require('./_shared/errorHandler')
const { matchPoliciesToMembers } = require('./_shared/member-matcher')
```

然后在 `aiExtract` handler 之后（`module.exports` 之前）新增：

```js
// ======================== aiExtractBatch ========================
/**
 * 方案 C：批量拼接提取 — N 张图 OCR 拼接为 1 次 AI 调用
 * 入参：{ ocr_results: [{fileId, ocrText, ocrConfInfo, t0, t1, t2}], familyId? }
 * 出参：{ code, data: { results: [{idx, fileId, success, policies?, cash_value_data?, document_type?, error?, error_code?}], total_duration_ms, split_used, ai_call_count } }
 *
 * 设计要点：
 *   - 阶段1 ocrOnly 已完成，本 handler 只负责阶段2 AI 提取
 *   - 拼接所有 ocrText 为 1 次 AI 调用，超限时对半拆分（aiExtractBatchPhase 内部处理）
 *   - 空文本图标记 ocr_empty，不参与 AI 调用
 *   - 整体异常时所有图标记 ai_batch_failed
 */
async function aiExtractBatch(db, openid, event) {
  const { ocr_results, familyId } = event
  if (!ocr_results || !Array.isArray(ocr_results) || ocr_results.length === 0) {
    return { code: 400, msg: '缺少参数 ocr_results' }
  }
  if (ocr_results.length > 10) {
    return { code: 400, msg: '单次最多 10 张图片' }
  }

  // 过滤空 ocrText，标记 ocr_empty
  var validResults = []
  var emptyFailures = []
  for (var i = 0; i < ocr_results.length; i++) {
    var r = ocr_results[i]
    if (!r || !r.ocrText || typeof r.ocrText !== 'string' || r.ocrText.length === 0) {
      emptyFailures.push({ idx: i + 1, fileId: r && r.fileId, success: false, error: 'OCR识别结果为空', errorCode: 'ocr_empty' })
    } else {
      validResults.push(r)
    }
  }

  // 全部为空：直接返回
  if (validResults.length === 0) {
    return { code: 200, data: { results: emptyFailures, total_duration_ms: 0, split_used: false, ai_call_count: 0 } }
  }

  try {
    var batchRes = await aiExtractBatchPhase(validResults, {
      cloud: cloud,
      db: db,
      openid: openid,
      familyId: familyId || null,
      buildBatchExtractionPrompt: buildBatchExtractionPrompt,
      safeCallChat: require('./_shared/ai-gateway').safeCallChat,
      callChat: require('./_shared/ai-client').callChat,
      AI_TIMEOUT: require('./_shared/config').AI_TIMEOUT
    })

    // 合并空文本失败项 + AI 返回项（按 idx 排序）
    var allResults = emptyFailures.concat(batchRes.results).sort(function(a, b) { return a.idx - b.idx })

    logOperation(db, {
      openid: openid, familyId: familyId || undefined, action: 'ai_extract_batch',
      result: { status: batchRes.failCount > 0 ? 'partial' : 'ok', summary: '批量提取' + validResults.length + '张, 成功' + batchRes.successCount + '/失败' + batchRes.failCount },
      meta: { imageCount: validResults.length, splitUsed: batchRes.splitUsed, totalDurationMs: batchRes.totalDurationMs, aiCallCount: batchRes.aiCallCount, tokens: batchRes.tokens || {}, successCount: batchRes.successCount, failCount: batchRes.failCount }
    }).catch(function() {})

    return {
      code: 200,
      data: {
        results: allResults,
        total_duration_ms: batchRes.totalDurationMs,
        split_used: batchRes.splitUsed,
        ai_call_count: batchRes.aiCallCount
      }
    }
  } catch (e) {
    // 整体失败：所有有效图标记 ai_batch_failed
    var errorResults = validResults.map(function(r, i) {
      return { idx: i + 1, fileId: r.fileId, success: false, error: (e && e.message) || 'AI服务异常', errorCode: 'ai_batch_failed' }
    })
    var allErrorResults = emptyFailures.concat(errorResults).sort(function(a, b) { return a.idx - b.idx })

    logOperation(db, {
      openid: openid, familyId: familyId || undefined, action: 'ai_extract_batch',
      result: { status: 'fail', summary: '批量提取异常: ' + ((e && e.message) || '') },
      meta: { imageCount: validResults.length, error: (e && e.message) || '' }
    }).catch(function() {})

    return { code: 200, data: { results: allErrorResults, total_duration_ms: 0, split_used: false, ai_call_count: 0 } }
  }
}
```

更新 `module.exports`：

```js
module.exports = { ocrSingle, ocrOnly, aiExtract, aiExtractBatch, matchPolicies }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/batchHandler.test.js --verbose`
Expected: PASS，7 个测试全部通过

- [ ] **Step 5: 验证 index.js 路由无需修改**

读取 `cloudfunctions/ocrService/index.js`，确认使用 `createHandler(handlers, 'OCR')` 自动按 action 分发。新增的 `aiExtractBatch` 已在 handlers 导出，无需修改 index.js。

- [ ] **Step 6: Commit**

```bash
git add cloudfunctions/ocrService/handlers.js tests/batchHandler.test.js
git commit -m "feat(handler): 实现 aiExtractBatch 云函数入口"
```

---

### Task 5: 前端 batchOCR_merged 实现 + OCR_BATCH_MODE 切换开关

**Files:**
- Modify: `miniprogram/utils/ocr-flow.js`

**Interfaces:**
- Consumes: 现有 `api`（apiClient）、`setStreamingSlots`、`setFillSlot`、`_printTimeline`、`_reportTimeline`
- Produces: `batchOCR_merged(fileIds, setData, opts)` 函数 + 顶部 `OCR_BATCH_MODE` 变量，`batchOCR` 入口根据 MODE 切换

- [ ] **Step 1: 读取 ocr-flow.js 当前 batchOCR 入口位置**

读取 `miniprogram/utils/ocr-flow.js`，定位到 `async function batchOCR(fileIds, setData, opts) {`（约第 262 行）和文件末尾的 `module.exports`。

- [ ] **Step 2: 在文件顶部新增 OCR_BATCH_MODE 开关**

在 `var _dedupCache = new Map()` 之前（约第 8 行）新增：

```js
// ============================================================
// 方案切换开关：'merged' = 批量拼接（1次AI） | 'split' = 原方案分批
// ============================================================
var OCR_BATCH_MODE = 'merged'
```

- [ ] **Step 3: 在 batchOCR 函数之前新增 batchOCR_merged**

在 `async function batchOCR(fileIds, setData, opts) {` 之前新增：

```js
// ============================================================
// 方案 C：批量拼接提取 — 1 次 AI 调用完成全部提取
//   阶段1：ocrOnly 并发 OCR（复用，不变）
//   阶段2：1 次 aiExtractBatch + 一次性填充所有槽位
//   阶段3：上报时间线
// ============================================================
async function batchOCR_merged(fileIds, setData, opts) {
  opts = opts || {}
  var all = [], cashValues = [], errors = []
  var batchIds = fileIds.filter(function(id) { return id !== null })
  if (!batchIds.length) return { policies: [], cashValues: [], errors: [] }

  // ===== 阶段 1：ocrOnly 并发 OCR（无 AI，无 429） =====
  var ocrRes
  try {
    var ocrRaw = await api('ocrOnly', { fileIds: batchIds, familyId: opts.familyId || '' })
    if (!ocrRaw.result || ocrRaw.result.code !== 200) {
      return { policies: [], cashValues: [], errors: [{ error: (ocrRaw.result && ocrRaw.result.msg) || 'OCR阶段失败', error_code: 'ocr_api_error' }] }
    }
    ocrRes = ocrRaw.result.data
  } catch (e) {
    return { policies: [], cashValues: [], errors: [{ error: (e && e.message) || 'OCR异常', error_code: 'ocr_exception' }] }
  }

  var ocrResults = ocrRes.ocr_results || []
  if (ocrRes.failures) { for (var f = 0; f < ocrRes.failures.length; f++) { errors.push(ocrRes.failures[f]) } }
  if (ocrResults.length === 0) return { policies: [], cashValues: [], errors: errors }

  // ===== 初始化流式槽位（骨架屏，aiExtractBatch 期间显示） =====
  var totalSlots = ocrResults.length
  if (setData) setData(setStreamingSlots(totalSlots))

  // ===== 阶段 2：1 次 aiExtractBatch =====
  var batchRequestId = _genRequestId()
  var timeline = [{
    requestId: batchRequestId, idx: 0, fileId: 'batch',
    submitTs: Date.now(), attempts: [], isBatch: true, imageCount: totalSlots
  }]

  var aiRes
  try {
    aiRes = await api('aiExtractBatch', {
      ocr_results: ocrResults,
      familyId: opts.familyId || ''
    })
  } catch (e) {
    timeline[0].completeTs = Date.now()
    timeline[0].attempts.push({ startTs: timeline[0].submitTs, endTs: timeline[0].completeTs, durationMs: timeline[0].completeTs - timeline[0].submitTs, errorCode: 'ocr_exception', ok: false })
    _printTimeline(timeline, { total: totalSlots, interval: 0 })
    _reportTimeline(timeline, { total: totalSlots, interval: 0 })
    return { policies: [], cashValues: [], errors: [{ error: (e && e.message) || 'aiExtractBatch异常', error_code: 'ocr_exception' }] }
  }

  var data = (aiRes.result && aiRes.result.code === 200) ? aiRes.result.data : null
  if (!data) {
    timeline[0].completeTs = Date.now()
    _printTimeline(timeline, { total: totalSlots, interval: 0 })
    _reportTimeline(timeline, { total: totalSlots, interval: 0 })
    return { policies: [], cashValues: [], errors: [{ error: (aiRes.result && aiRes.result.msg) || 'aiExtractBatch失败', error_code: 'ocr_api_error' }] }
  }

  // ===== 阶段 3：一次性填充所有槽位 =====
  var results = data.results || []
  var streamSlots = new Array(totalSlots).fill(null)
  var filledCount = 0

  for (var i = 0; i < results.length; i++) {
    var r = results[i]
    var slotIdx = r.idx - 1  // idx 是 1-based，slotIdx 是 0-based
    if (r.success) {
      if (r.policies && r.policies.length > 0) {
        streamSlots[slotIdx] = { kind: 'policy', product_name: r.policies[0].product_name, insurance_category: r.policies[0].insurance_category, low: !((r.policies[0].auto_confirmed !== false) && r.policies[0].confidence >= 0.95) }
        for (var k = 0; k < r.policies.length; k++) all.push(r.policies[k])
      }
      if (r.cash_value_data) {
        if (!streamSlots[slotIdx]) {
          streamSlots[slotIdx] = { kind: 'cash', product_name: r.cash_value_data.product_name || '现价表', low: false }
        }
        cashValues.push(r.cash_value_data)
      }
    } else {
      streamSlots[slotIdx] = { kind: 'error', product_name: '识别失败', error_code: r.error_code || r.errorCode, low: false }
      errors.push({ fileId: r.fileId, error: r.error || 'AI提取失败', error_code: r.error_code || r.errorCode })
    }
    filledCount++
  }

  if (setData) setData(setFillSlot(streamSlots, null, streamSlots, filledCount))
  if (opts.onBatchComplete) {
    try { opts.onBatchComplete(filledCount, totalSlots) } catch (e) {}
  }

  // ===== 时间线上报 =====
  timeline[0].completeTs = Date.now()
  timeline[0].attempts.push({ startTs: timeline[0].submitTs, endTs: timeline[0].completeTs, durationMs: timeline[0].completeTs - timeline[0].submitTs, errorCode: '', ok: true })
  timeline[0].splitUsed = data.split_used
  timeline[0].aiCallCount = data.ai_call_count
  _printTimeline(timeline, { total: totalSlots, interval: 0 })
  _reportTimeline(timeline, { total: totalSlots, interval: 0 })

  return { policies: all, cashValues: cashValues, errors: errors }
}
```

- [ ] **Step 4: 修改 batchOCR 入口，根据 OCR_BATCH_MODE 切换**

找到 `async function batchOCR(fileIds, setData, opts) {` 函数体第一行（`opts = opts || {}` 之前），在函数体最开头新增切换逻辑：

```js
async function batchOCR(fileIds, setData, opts) {
  // 方案切换：merged = 批量拼接（1次AI） | split = 原方案分批
  if (OCR_BATCH_MODE === 'merged') {
    return batchOCR_merged(fileIds, setData, opts)
  }
  opts = opts || {}
  // ... 原有逻辑保持不变
```

- [ ] **Step 5: 验证 batchOCR_merged 引用的辅助函数均已存在**

读取 `miniprogram/utils/ocr-flow.js`，确认以下函数在 batchOCR_merged 之前已定义：
- `setStreamingSlots`（约第 55 行）
- `setFillSlot`（约第 66 行）
- `_genRequestId`（约第 198 行）
- `_printTimeline`（约第 203 行）
- `_reportTimeline`（约第 233 行）

若已定义，无需修改。若未定义（不可能，因为原 batchOCR 也在用），需补定义。

- [ ] **Step 6: 手动验证语法（node 解析）**

Run: `node -c miniprogram/utils/ocr-flow.js`
Expected: 无输出（语法正确）

- [ ] **Step 7: Commit**

```bash
git add miniprogram/utils/ocr-flow.js
git commit -m "feat(frontend): 新增 batchOCR_merged 批量拼接流程 + OCR_BATCH_MODE 开关"
```

---

### Task 6: 端到端冒烟验证

**Files:**
- 无修改，仅运行测试

- [ ] **Step 1: 运行全部 OCR 相关测试**

Run: `npx jest tests/batchPrompt.test.js tests/batchExtractPhase.test.js tests/batchHandler.test.js tests/ocrExtractor.test.js tests/ocrCore.test.js tests/ocrConfidence.test.js tests/buildPolicyFromExtract.test.js --verbose`
Expected: 所有测试 PASS

- [ ] **Step 2: 运行全量测试套件，确认无回归**

Run: `npx jest --verbose`
Expected: 所有测试 PASS，无新增 FAIL

- [ ] **Step 3: 确认 _shared 同步状态**

Run: `node scripts/sync-shared.js --check`
Expected: 输出 `OK: all in sync` 或类似，无差异

- [ ] **Step 4: 确认 git 状态干净**

Run: `git status`
Expected: `nothing to commit, working tree clean`

- [ ] **Step 5: 部署提示（人工操作）**

提示用户：
1. 在云开发控制台部署 `ocrService` 云函数（包含新增的 aiExtractBatch handler）
2. 在微信开发者工具重新编译小程序（前端 ocr-flow.js 有改动）
3. 准备 9 张保单图测试，观察：
   - 总耗时（目标 < 12s）
   - AI 调用次数（应为 1 次，或触发拆分时 2 次）
   - 拆分是否触发（`split_used` 字段）
   - idx 是否对应正确

---

## Self-Review 检查

**1. Spec 覆盖检查**：
- ✅ 3.1 Prompt 设计 → Task 2
- ✅ 3.2 Token 估算与超限降级 → Task 3（aiExtractBatchPhase 内部）
- ✅ 3.3 云函数 handler → Task 4
- ✅ 3.4 编排层 → Task 3
- ✅ 3.5 前端流程 → Task 5
- ✅ 3.6 错误处理矩阵 → Task 3 + Task 4（ai_format/ai_batch_failed/ai_length_mismatch/ocr_empty/ai_extract_failed）
- ✅ 3.7 可观测性 → Task 4（logOperation）+ Task 5（_printTimeline/_reportTimeline）
- ✅ 4.1 配置切换 → Task 5（OCR_BATCH_MODE 前端开关）
- ✅ 6.2 修改文件 → 全部覆盖

**2. Placeholder 扫描**：无 TBD/TODO，所有步骤含完整代码。

**3. 类型一致性**：
- `aiExtractBatchPhase` 返回 `{ results, totalDurationMs, splitUsed, aiCallCount, tokens, successCount, failCount }` — Task 3 定义，Task 4 消费，字段名一致 ✅
- handler 返回 `{ results, total_duration_ms, split_used, ai_call_count }` — Task 4 定义，Task 5 前端消费，字段名一致（snake_case）✅
- `buildBatchExtractionPrompt(ocrResults) → { systemPrompt, userPrompt }` — Task 2 定义，Task 3 消费 ✅
- handler 测试中 mock `aiExtractBatchPhase` 返回的 `results` 元素含 `idx/fileId/success/policies/error/errorCode` — 与 Task 3 `_buildSingleResult` 输出一致 ✅

**4. 风险点**：
- Task 3 测试中 `ocrResults_idxOf` 依赖 `_batchIdx` 字段，实现中已通过 `Object.assign({}, r, { _batchIdx: i + 1 })` 注入 ✅
- Task 4 mock `aiExtractBatchPhase` 时用 `jest.requireActual` 保留其他导出，避免破坏 `buildPolicyFromExtract` 等依赖 ✅
- Task 5 `batchOCR_merged` 在 `batchOCR` 之前定义，JS 函数声明提升，调用无问题 ✅

---

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-07-31-ocr-batch-merged-extraction.md`。两种执行方式：

**1. Subagent-Driven（推荐）** - 每个 Task 派发独立 subagent，任务间 review，快速迭代

**2. Inline Execution** - 当前会话顺序执行，带检查点 review

选择哪种方式？
