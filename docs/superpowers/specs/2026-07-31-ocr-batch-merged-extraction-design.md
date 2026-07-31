# OCR 批量拼接提取方案设计

**日期**：2026-07-31
**状态**：✅ 已实现（2026-08-01 落地：merged 拼接 + 按张数自动分流 + 拆分死路径删除 + 双 prompt 收敛 + 两步独立判定）
**定位**：当前正式方案（≤5 张 hy3 拼接 / >5 张 DeepSeek 并行，前端 `batchOCR` 按张数自动分流）

## 1. 背景与目标

### 1.1 当前方案问题

当前 `ocr-flow.js` 的方案 B 采用"两阶段流水线"：

1. **阶段 1**：`ocrOnly` 并发 OCR 全部图片（无 AI，无 429 风险）
2. **阶段 2**：前端间隔 2s 错峰分批调用 `aiExtract`，每张图一次 AI 调用

问题：

- N 张图 = N 次 AI 调用，每次调用都包含完整的 system prompt（~2000 token），prompt cache 命中率受限
- 即使是 DeepSeek 直连（并发 2500），9 张图总耗时仍受最慢一张制约 + 间隔 2s × N
- TokenHub 限流场景下需要复杂的退避与串行协调

### 1.2 新方案目标

将 N 张图的 OCR 结果拼接为一个大 prompt，**一次性**交给 AI 提取，AI 返回数组结构。

- **极致速度**：1 次 AI 调用完成全部提取，总耗时 ≈ 单次调用耗时
- **省 token**：system prompt 只发 1 次，N 张图共享上下文
- **可能替代**：若数据表现稳定，可替代当前分批方案作为生产路径

### 1.3 成功标准

| 维度 | 目标 |
|---|---|
| 9 张图总耗时 | < 12s（当前方案约 18-25s） |
| AI 调用次数 | 1 次（触发拆分时 ≤ 2 次） |
| 单图提取成功率 | ≥ 当前方案 95% 水平 |
| idx 错位率 | < 1% |
| 部分失败处理 | 单图失败不影响其他图正常返回 |

## 2. 架构设计

### 2.1 整体流程

```
前端                云函数(ocrService)           AI(DeepSeek)
  │
  ├─ ocrOnly ──────→ 并发OCR全部图片 ────────→ 腾讯OCR
  │   (阶段1不变)     ← ocr_results[]
  │
  ├─ aiExtractBatch ─→ 拼接所有 ocrText ────┐
  │   (新action)      构建 batchPrompt      │
  │                   估算token是否超限      │
  │                     ├─ 未超限: 1次调用 ──→ DeepSeek
  │                     └─ 超限: 对半拆分    → DeepSeek (2次并发)
  │                   ← results[]           ← 返回JSON数组
  │                   校验idx、长度
  │                   构建policies/cashValue
  │   ← data.results[]
  │
  └─ 一次性填充所有槽位（非流式）
```

### 2.2 与现有架构的集成点

复用现有组件，最小改动：

| 现有组件 | 复用方式 |
|---|---|
| `ocrPhase`（ocr-core.js） | 不变，`ocrOnly` 仍调用它 |
| `ocrRecognize`（ocr-extractor.js） | 不变 |
| `buildPolicyFromExtract`（ocr-core.js） | 复用，对每张图独立调用 |
| `calcConfidence`（ocr-confidence.js） | 复用，每张图独立计算 |
| `logOperation`（logSeam.js） | 复用，记录 `action: 'ai_extract_batch'` |
| `withRetry`（retry.js） | 复用，包裹 AI 调用 |
| `safeCallChat` / `callChatDirect` | 复用，传 batchPrompt |

**新增组件**：

| 新组件 | 位置 | 职责 |
|---|---|---|
| `buildBatchExtractionPrompt` | ocrService/prompts.js | 构建批量拼接 prompt |
| `aiExtractBatch` handler | ocrService/handlers.js | 新 action 入口 |
| `aiExtractBatchPhase` | _shared/ocr-core.js | 批量 AI 提取编排（含拆分降级） |
| `batchOCR_merged` | miniprogram/utils/ocr-flow.js | 新前端流程路径 |

## 3. 详细设计

### 3.1 Prompt 设计（buildBatchExtractionPrompt）

**输入拼接格式**（索引标记法）：

```
【图片_1】
{ocrText_1}

【图片_2】
{ocrText_2}

...
【图片_N】
{ocrText_N}
```

**置信度信息**：每张图的 `ocrConfInfo` 附在对应 `【图片_N】` 块下方，独立标注，避免跨图混淆：

```
【图片_1】
{ocrText_1}

[图片_1 字符级置信度参考]
  "投保人李阳勇" 98%
  "保额100000" 95%
  ...

【图片_2】
{ocrText_2}

[图片_2 字符级置信度参考]
  ...
```

**输出契约**（强制 JSON 数组）：

```json
[
  {
    "idx": 1,
    "document_type": "policy",
    "result": "success",
    "data": {
      "contract_basic": { ... },
      "products": [ ... ],
      "field_confidence": { ... },
      "overall_confidence": 0.85
    }
  },
  {
    "idx": 2,
    "document_type": "cash_value",
    "result": "success",
    "cash_value_data": {
      "header_info": { ... },
      "cash_values": [ ... ],
      "overall_confidence": 0.88
    }
  },
  {
    "idx": 3,
    "document_type": "unknown",
    "result": "fail",
    "message": "无法识别保单信息"
  }
]
```

**关键 prompt 约束（在 system prompt 基础上新增）**：

1. 顶层必须是 JSON 数组，长度严格等于输入图片数 N
2. 数组每个元素的 `idx` 字段必须从 1 递增到 N，与输入 `【图片_N】` 一一对应
3. 每张图独立判断 `document_type` 和 `result`，单张图失败不影响其他图
4. `data` 和 `cash_value_data` 结构沿用单图模式契约
5. `document_type` 为 "mixed" 时，`data` 和 `cash_value_data` 同时输出

### 3.2 Token 估算与超限降级

**估算规则**（保守估计）：

- 输入 token ≈ 总字符数 / 1.5（中文为主，含 OCR 文本 + system prompt）
- 输出 token 上限：`max_tokens = 4000`（9 张图产品+现价表场景）
- DeepSeek 上下文窗口：64K
- **安全阈值**：input_token + 4000 ≤ 60000，即 input_token ≤ 56000，对应总字符数 ≤ 84000

**对半拆分逻辑**（递归）：

```js
async function aiExtractBatchPhase(ocrResults, deps) {
  const totalChars = ocrResults.reduce((s, r) => s + (r.ocrText || '').length, 0)

  if (totalChars <= 84000) {
    // 未超限：1 次调用
    return await callBatchAI(ocrResults, deps)
  }

  // 超限：对半拆分
  const mid = Math.ceil(ocrResults.length / 2)
  const [left, right] = [ocrResults.slice(0, mid), ocrResults.slice(mid)]

  // 两个子批次并发提交（DeepSeek 并发 2500，无 429 风险）
  const [leftRes, rightRes] = await Promise.all([
    aiExtractBatchPhase(left, deps),
    aiExtractBatchPhase(right, deps)
  ])

  // 重新编号 right 部分 idx 并合并
  return mergeBatchResults(leftRes, rightRes, mid)
}
```

**拆分时的 idx 处理**：

- 左半部分：idx 1..mid
- 右半部分：idx 1..(N-mid)，合并时偏移为 (mid+1)..N
- 前端最终看到的是连续 idx 1..N

### 3.3 云函数 handler（aiExtractBatch）

**入参**：

```js
{
  ocr_results: [
    { fileId, ocrText, ocrConfInfo, t0, t1, t2 },
    ...
  ],
  familyId?: string
}
```

**校验**：

- `ocr_results` 必须是数组，长度 1-10
- 每项必须有 `fileId`、`ocrText`（非空字符串）
- `ocrText` 为空的项直接标记 `error_code: 'ocr_empty'`，不参与 AI 调用

**出参**：

```js
{
  code: 200,
  data: {
    results: [
      {
        idx: 1,
        fileId: "cloud://...",
        success: true,
        policies: [...],
        cash_value_data: null,
        document_type: "policy"
      },
      {
        idx: 2,
        fileId: "cloud://...",
        success: false,
        error: "AI返回格式错误",
        error_code: "ai_format"
      }
    ],
    total_duration_ms: 8500,
    split_used: false,
    ai_call_count: 1
  }
}
```

**handler 伪代码**：

```js
async function aiExtractBatch(db, openid, event) {
  const { ocr_results, familyId } = event
  // 参数校验 ...
  // 过滤 ocrText 为空的项，标记 ocr_empty ...

  try {
    const batchRes = await aiExtractBatchPhase(validResults, {
      cloud, db, openid, familyId, buildBatchExtractionPrompt,
      safeCallChat, callChat, AI_TIMEOUT
    })

    // 合并空文本失败项 + AI 返回项
    const allResults = mergeWithEmptyFailures(emptyFailures, batchRes, validResults)

    // 日志
    logOperation(db, {
      openid, familyId, action: 'ai_extract_batch',
      result: { status: 'partial', summary: `批量提取${validResults.length}张, 成功${batchRes.successCount}/失败${batchRes.failCount}` },
      meta: { imageCount: validResults.length, splitUsed: batchRes.splitUsed, totalDurationMs: batchRes.totalDurationMs, aiCallCount: batchRes.aiCallCount, tokens: batchRes.tokens }
    }).catch(() => {})

    return { code: 200, data: { results: allResults, total_duration_ms: batchRes.totalDurationMs, split_used: batchRes.splitUsed, ai_call_count: batchRes.aiCallCount } }
  } catch (e) {
    // 整体失败：所有图标记 error
    return { code: 200, data: { results: allAsError(validResults, e), total_duration_ms: 0, split_used: false, ai_call_count: 0 } }
  }
}
```

### 3.4 编排层（aiExtractBatchPhase）

位于 `_shared/ocr-core.js`，与 `aiPhase` 并列。

**职责**：

1. 调用 `buildBatchExtractionPrompt` 构建拼接 prompt
2. Token 估算，超限则对半拆分递归
3. 调用 `safeCallChat(callChat, ...)` 发起 AI 请求
4. 解析返回的 JSON 数组
5. 对每个元素调用 `buildPolicyFromExtract` + `calcConfidence` 构建保单对象
6. 校验 idx 连续性、数组长度
7. 返回结构化结果

**关键校验**：

- AI 返回必须是数组，长度 = 输入图片数
- idx 必须从 1 递增到 N
- 不满足时，对缺失的 idx 标记 `error_code: 'ai_idx_mismatch'`

**配置参数**（新增到 config.js，仅云函数侧使用）：

```js
AI: {
  // ...
  OCR_BATCH_MAX_CHARS: 84000,       // 拼接上限字符数（约 56K input token）
  OCR_BATCH_MAX_TOKENS: 4000,       // 批量模式输出 token 上限
  OCR_BATCH_TIMEOUT: 30000,         // 批量模式 AI 超时
  OCR_BATCH_TEMPERATURE: 0
}
```

> 方案切换开关 `OCR_BATCH_MODE` 在前端 `ocr-flow.js`，详见 4.1 节。

### 3.5 前端流程（batchOCR_merged）

在 `miniprogram/utils/ocr-flow.js` 中新增 `batchOCR_merged`，与现有 `batchOCR` 并存，通过 `OCR_BATCH_MODE` 配置切换。

**与原方案差异**：

| 阶段 | 原方案 batchOCR | 新方案 batchOCR_merged |
|---|---|---|
| 阶段1 ocrOnly | 并发 OCR | 并发 OCR（不变） |
| 阶段2 AI 提取 | 分批 aiExtract + 流式回填 | 1 次 aiExtractBatch + 一次性填充 |
| UI 体验 | 流式渐进出现卡片 | 全部卡片同时出现（带 loading 过渡） |

**伪代码**：

```js
async function batchOCR_merged(fileIds, setData, opts) {
  // 阶段1：复用 ocrOnly（不变）
  var ocrRes = await api('ocrOnly', { fileIds: batchIds, familyId: opts.familyId })

  // 阶段2：一次性 aiExtractBatch
  setData(setStreamingSlots(totalSlots))  // 显示骨架屏

  var aiRes
  try {
    aiRes = await api('aiExtractBatch', {
      ocr_results: ocrRes.ocr_results,
      familyId: opts.familyId
    })
  } catch (e) {
    // 网络异常：全部标记错误
    return { policies: [], cashValues: [], errors: [...] }
  }

  // 阶段3：一次性填充所有槽位
  var results = (aiRes.result && aiRes.result.code === 200) ? aiRes.result.data.results : []
  var slots = results.map(function(r) {
    if (r.success && r.policies && r.policies.length > 0) {
      return { kind: 'policy', product_name: r.policies[0].product_name, low: !(r.policies[0].confidence >= 0.95) }
    }
    if (r.success && r.cash_value_data) {
      return { kind: 'cash', product_name: r.cash_value_data.product_name || '现价表', low: false }
    }
    return { kind: 'error', product_name: '识别失败', error_code: r.error_code, low: false }
  })

  setData(setFillSlot(slots, null, slots, slots.length))

  // 收集 policies / cashValues / errors
  // ...

  // 时间线上报（复用 _reportTimeline）
  return { policies: all, cashValues: cashValues, errors: errors }
}
```

### 3.6 错误处理矩阵

| 错误场景 | 处理方式 | error_code |
|---|---|---|
| 整体 AI 调用失败（5xx/超时） | 所有图标记 error | `ai_batch_failed` |
| 整体 JSON 解析失败 | 所有图标记 error | `ai_format` |
| 数组长度 ≠ 输入图片数 | 缺失的 idx 标记 error | `ai_length_mismatch` |
| idx 错位/不连续 | 错位的项标记 error | `ai_idx_mismatch` |
| 单张图 `result: "fail"` | 该图标记 error，其他正常 | `ai_extract_failed` |
| OCR 文本为空（入参校验） | 该图标记 error，不参与 AI | `ocr_empty` |
| 拆分后某子批次失败 | 该子批次所有图标记 error | `ai_batch_failed` |

### 3.7 可观测性

**logOperation 记录**：

```js
{
  action: 'ai_extract_batch',
  openid, familyId,
  result: {
    status: 'ok' | 'partial' | 'fail',
    summary: '批量提取N张, 成功X/失败Y'
  },
  meta: {
    imageCount: N,
    splitUsed: false,
    splitDepth: 0,        // 拆分递归深度
    aiCallCount: 1,
    totalDurationMs: 8500,
    successCount: X,
    failCount: Y,
    tokens: { prompt_tokens, completion_tokens, total_tokens },
    errorCodes: { ai_format: 1, ai_extract_failed: 0 }  // 错误码分布
  }
}
```

**前端时间线**：复用 `_printTimeline` / `_reportTimeline`，但批次记录简化为单条（aiExtractBatch 一次调用）。

## 4. 切换开关与 A/B 测试

### 4.1 配置切换

切换开关放在**前端**（最直接，A/B 测试时改一行代码 + 重新部署小程序即可，无需改云函数）：

```js
// miniprogram/utils/ocr-flow.js 顶部
var OCR_BATCH_MODE = 'merged'  // 'merged' = 新方案 | 'split' = 原方案
```

`batchOCR` 入口根据此变量决定走原方案还是 `batchOCR_merged`。云函数侧两个 handler（`aiExtract` / `aiExtractBatch`）始终并存，无需配置。

### 4.2 对比指标

测试时记录以下指标用于对比：

| 指标 | 原方案 split | 新方案 merged |
|---|---|---|
| 总耗时（9张图） | ?s | ?s |
| AI 调用次数 | 9 | 1-2 |
| 总 token 消耗 | ? | ? |
| 成功率 | ?% | ?% |
| idx 错位率 | N/A | ?% |
| 触发拆分次数 | N/A | ? |

## 5. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| AI 在拼接后混淆图片边界 | 中 | 高 | 显式 `【图片_N】` 标记 + 强约束 prompt + idx 校验 |
| 输出 token 超限 | 中 | 高 | max_tokens=4000 + 对半拆分降级 |
| 单次调用耗时过长 | 低 | 中 | axios timeout 30s，云函数超时 60s |
| AI 返回数组长度不匹配 | 低 | 中 | 校验，缺失项标记 error |
| idx 错位 | 低 | 中 | 校验 idx 连续性，错位项标记 error |
| 拼接后 prompt 过长导致 AI 性能下降 | 低 | 中 | 拆分阈值保守设置（56K 而非 60K） |

## 6. 实现范围

### 6.1 新增文件

无（所有改动在现有文件内）

### 6.2 修改文件

| 文件 | 改动 |
|---|---|
| `cloudfunctions/_shared/config.js` | 新增 OCR_BATCH_* 配置 |
| `cloudfunctions/_shared/ocr-core.js` | 新增 `aiExtractBatchPhase` 函数 |
| `cloudfunctions/ocrService/prompts.js` | 新增 `buildBatchExtractionPrompt` 函数 |
| `cloudfunctions/ocrService/handlers.js` | 新增 `aiExtractBatch` handler |
| `cloudfunctions/ocrService/index.js` | 注册 `aiExtractBatch` action 路由 |
| `miniprogram/utils/ocr-flow.js` | 新增 `batchOCR_merged` 函数 + `OCR_BATCH_MODE` 切换开关 |
| `miniprogram/pages/index/index.js` | 无需修改（仍调用 `batchOCR`，内部根据 MODE 切换路径） |
| `miniprogram/pages/report/index.js` | 无需修改（同上） |

### 6.3 不修改的部分

- `ocrPhase`、`ocrRecognize`、`ocrOnly`（阶段1完全复用）
- `buildExtractionPrompt`（保留，原方案仍可用）
- `aiExtract` handler（保留，原方案仍可用）
- `buildPolicyFromExtract`、`calcConfidence`（复用）
- 日志、重试、AI client 等基础设施

## 7. 测试计划

### 7.1 单元测试

- `buildBatchExtractionPrompt`：输入多张图 OCR 文本，验证拼接格式、idx 标记、置信度独立标注
- `aiExtractBatchPhase`：mock AI 返回，验证拆分逻辑、idx 校验、错误处理
- `aiExtractBatch` handler：参数校验、空文本过滤、结果合并

### 7.2 集成测试

- 3 张保单图：验证 1 次 AI 调用，3 个 policies 返回
- 9 张图（含现价表）：验证 max_tokens 是否触发拆分
- 1 张图 OCR 为空：验证该图标记 ocr_empty，其他图正常
- AI 返回数组长度不匹配：验证错误标记

### 7.3 对比测试

同一组 9 张图，分别用 `OCR_BATCH_MODE='split'` 和 `'merged'` 测试，对比总耗时、token 消耗、成功率。

## 8. 未来扩展

- 若 `merged` 方案稳定，可下线 `split` 方案，删除 `batchOCR` 旧代码
- 支持动态批次大小：根据 OCR 文本长度自动决定是全量拼接还是分组
- 结合 prompt cache：批量拼接的 system prompt 部分稳定，cache 命中率高
