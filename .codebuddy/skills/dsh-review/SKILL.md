---
name: dsh-review
description: Use when 审查 dsh（DeepSeek Harness）在本项目执行的会话内容，评估其代码/决策合理性，发现偏差则纠偏，并补做其未完成的工作（测试/lint/_shared 同步/云函数部署）。触发场景：用户说"检查 dsh 干了什么"、"评估 dsh 的产出"、"dsh 做完之后要复审"、发现 dsh 改动异常或用户主动测试 dsh 后需要分析
---

# DSH 复审（dsh-review）

## 定位

dsh（DeepSeek Harness）在 Windows 上只能**读/编辑文件**：`subprocess-local` 的 `createProcessInspector` 硬编码仅支持 linux/darwin，win32 直接 throw（`terminal inspection is unsupported on platform win32`），npm 最新 0.1.0-rc.6 亦如此。因此 dsh **跑不了测试/终端命令**——这不是它不努力，是平台硬限制。

本 skill 是对 dsh 会话产物的系统性复审闭环：**读会话 → 评估 → 纠偏 → 补做 → 交付**。目标是让"dsh 写完"变成"验证过、部署过"。

## 核心流程（七步）

```
1. 定位会话 → 2. 解压读取 → 3. 提取信息 → 4. 评估合理性 → 5. 纠偏 → 6. 补做 → 7. 交付报告
```

## 技术细节

### 1. 会话路径

```
$DSH_HOME/sessions/<workspace-encoded>/session-<uuid>/session.jsonl.zstd
```
`$DSH_HOME` 默认 `~/.dsh`；本项目机器已迁移到 `D:\Users\lyy\.dsh`（用户级 `setx DSH_HOME` 持久化）。

`workspace-encoded`：绝对路径去盘符冒号、`\` 替换为 `-`、前后加 `--`。
例：`C:\Users\lyy\WeChatProjects\miniprogram-1` → `--C-Users-lyy-WeChatProjects-miniprogram-1--`

取最新会话：`Get-ChildItem <dir> -Directory | Sort-Object LastWriteTime -Descending | Select -First 1`，再看内部 `session.jsonl.zstd` 的 LastWriteTime 确认最新活动。

### 2. 解压（关键坑）

文件是**追加写入的多帧 zstd**。`zstdDecompressSync` 只解第一帧，**必须按 magic 切帧逐帧解压**：

```js
const { zstdDecompressSync } = require('node:zlib');
const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
const offsets = [];
for (let i = 0; i <= buf.length - 4; i++)
  if (buf[i]===magic[0]&&buf[i+1]===magic[1]&&buf[i+2]===magic[2]&&buf[i+3]===magic[3]) offsets.push(i);
let text = '';
for (let i = 0; i < offsets.length; i++) {
  const end = i + 1 < offsets.length ? offsets[i+1] : buf.length;
  try { text += zstdDecompressSync(buf.slice(offsets[i], end)).toString('utf8'); } catch (e) {}
}
```

### 3. 记录结构（jsonl，逐行 JSON.parse）

| type | data 字段 | 含义 |
|------|----------|------|
| `session` | `cwd`/`agentPreset` | 会话头（确认工作目录是否正确） |
| `tool/call` | `data.name` + `data.arguments`（JSON 字符串） | 工具调用 |
| `data.message` | `role` + `content`（string 或 `[{type:'text'|'tool_use'|'tool_result',...}]`） | 消息 |
| 流式噪声 | type ∈ `text-chunks`/`assistant/chunk`/`step/*`/`turn/*`/`run/*` | **过滤**，只看完整记录 |

提取四类信息：
1. **用户指令**（每 turn 首条 user 消息，排除 tool_result 内容）
2. **工具统计**（按 `data.name` 计数，`str_replace_editor` 的 arguments 里 `path`+`command` 判断读/改）
3. **编辑过的文件**（改动路径集合）
4. **assistant 最终回复**（非 tool_use 的 text 消息）

### 4. 评估合理性（对照项目规范）

按此顺序逐项核对：

1. **功能正确性**：抽查 dsh 改动的核心文件，实际读代码验证设计/实现（不信它的自述）。
2. **工程宪法**：禁 `any`；不掩盖失败；静态（tsc/lint/jest）+ 运行时自检。
3. **部署纪律**：改 `cloudfunctions/` → 需部署对应函数；改 `_shared/*` → 改主源 → `sync-shared.js` → 部署消费方。
4. **lint 归因**：eslint 报的 `no-var`/`prefer-template` 要**用 `git diff` 区分 dsh 新增 vs 文件原有**——dsh 新增代码通常干净（const/let），别把文件历史债务算到它头上。
5. **命名/字段/数据红线**：camelCase/snake_case、`_openid` 必含、禁存敏感字段、时间字段跨集合统一。
6. **dsh 平台限制**：它说"跑不了测试"时，检查会话里是否有 bash 调用失败记录（`terminal inspection is unsupported on platform win32`）——有则属实，不是借口。

### 5. 纠偏

- 修复 **dsh 新增代码**引入的 lint 违规（prefer-template、缩进等），**不动文件原有问题**（手术式修改）。
- 修正 dsh 的错误设计决策（如有）。
- 注意：纠偏后**重跑相关测试**确认无回归。

### 6. 补做清单（dsh 做不了/没做的事）

```bash
# 1. 测试（全量 + 相关套件）
npx jest --silent                       # 全量回归
npx jest tests/<相关>.test.js           # 定向验证

# 2. lint（用 eslint@8，项目配置是旧格式）
npx --yes eslint@8.57.0 <改动的文件...>

# 3. _shared 同步（先 check 再 sync）
node scripts/sync-shared.js --check
node scripts/sync-shared.js

# 4. 部署（MCP cloudbase）
manageFunctions.updateFunctionCode({ functionName, functionRootPath })
# ⚠️ 部署会覆盖环境变量！部署后必须 queryFunctions.getFunctionDetail 核对 Env
#    若被清空：updateFunctionConfig 合并写回（含 TENCENT_SECRET_ID/KEY 等既有变量）
```

部署决策表：

| 改动 | 部署 |
|------|------|
| `cloudfunctions/<fn>/` 自身代码 | 部署 `<fn>` |
| `_shared/*` 主源 | sync-shared 后部署所有消费方 |
| 仅前端 miniprogram/ | 无需部署云函数 |

### 7. 交付报告

```
| 会话 | 任务 | 工具统计 | 改动文件 | 评估结论 | 补做内容 | 部署状态 |
```

报告要点：任务内容（用户指令）、dsh 做了什么（工具/文件）、**评估结论**（合理处+问题处，含对 dsh 能力的修正判断）、补做明细（测试数/lint 修复/同步/部署）、部署后 Env 核对结果。

## 红旗

- dsh 编辑后无验证痕迹 → 必补跑测试（它的 11 用例证明能跑，跑了就能证明）。
- 改 `_shared` 未同步副本 → 必同步（防"白改"——改副本=白改，改主源才是源头）。
- 改 `cloudfunctions/` 未部署 → 必部署，且核对 Env。
- 会话显示 cwd 是 `$DSH_HOME/profiles/web` 而非项目目录 → 检查 `DSH_CWD` 是否配置（setx 后重启 dsh）。
- 用 `git diff` 前别信任何 lint 归因——先看 diff 再下结论。

## 平台事实备忘（防止重复排查）

- junction 在部分 Windows 环境创建即失效（Node 无法 follow）→ dsh 回退层 510 链接坏 → 已用**物理复制**到 `$DSH_HOME/profiles/web/node_modules` 绕过（勿再删）。迁移 D 盘后回退层由 dsh 自动重建为指向新 npm 全局的 junction，勿再删。
- dsh 依赖解析：profile 目录物理 node_modules 优先于回退层。
- `DSH_CWD` 持久化在用户级注册表，重启 dsh 才生效。
- API key：`DEEPSEEK_API_KEY` 环境变量 + `settings.yaml` 的 `apiKeyEnv`。
- 目录选择：native 弹窗在 IDE 内置浏览器不可用 → patch 用 browse 后端（`cordis.patch.yml` 已配）。
