---
name: dsh-review
description: Use when 审查 dsh（DeepSeek Harness）在本项目执行的会话内容，评估其代码/决策合理性，发现偏差则纠偏，并补做其未完成的工作（测试/lint/_shared 同步/云函数部署）。触发场景：用户说"检查 dsh 干了什么"、"评估 dsh 的产出"、"dsh 做完之后要复审"、发现 dsh 改动异常或用户主动测试 dsh 后需要分析
---

# DSH 复审（dsh-review）

## 定位

**dsh 在本机（Windows）能跑终端命令。** 2026-09-26 复审实测：会话里有 **69 次 `pwsh` 调用**，`npm test`、`npx eslint cloudfunctions miniprogram tests`、`git log/status/ls-files` 都真实执行，且作为**后台任务**返回 `exit code 0`。

（旧版此处写「dsh 只能读/编辑文件、**跑不了**测试/终端命令」✗ —— 那是把 `subprocess-local` 的 **terminal inspection** 限制误当成 spawn 限制：`createProcessInspector` 硬编码仅支持 linux/darwin、win32 直接 throw `terminal inspection is unsupported on platform win32`，但它**只拦"读取终端状态"，不拦启动进程**。这条误判会让复审者以为「dsh 不可能自测」从而**跳过"它是否已经测过"的核查** —— 本次复审我因此先入为主地判错了两次。）

所以本 skill 的重心不是「替它跑测试」✗，而是「**不采信它的 exit 0，独立复跑**」✓：跑过 ≠ 结论正确，也可能跑的是旧代码、或漏了相关套件。

本 skill 是对 dsh 会话产物的系统性复审闭环：**读会话 → 评估 → 纠偏 → 补做 → 交付**。目标是让"dsh 写完"变成"验证过、部署过"。

## 核心流程（七步）

```
1. 定位会话 → 2. 解压读取 → 3. 提取信息 → 4. 评估合理性 → 5. 纠偏 → 6. 补做 → 7. 交付报告
```

## 技术细节

### 1. 会话路径

```
$DSH_HOME/sessions/<workspace-encoded>/<目录名>/<文件名>
  目录名：session-<uuid>（新） | <uuid>（旧）—— 两代并存，都要认
  文件名：session.v3.jsonl.zstd（新） | session.jsonl.zstd（旧）—— 两代并存，都要认
```
`$DSH_HOME` 默认 `~/.dsh`；本项目机器已迁移到 `D:\Users\lyy\.dsh`（用户级 `setx DSH_HOME` 持久化）。

`workspace-encoded`：绝对路径去盘符冒号、`\` 替换为 `-`、前后加 `--`。
例：`C:\Users\lyy\WeChatProjects\miniprogram-1` → `--C-Users-lyy-WeChatProjects-miniprogram-1--`

**取最新会话 ⚠️ 不能按目录 mtime 选**：2026-09-26 实测本机 57 个会话目录里有 **5 个目录 mtime 完全相同**（同批创建）→ 按目录排序会取错 ✓。正确做法：枚举每个目录内的 `session*.jsonl.zstd`，**按该文件自身的 mtime 排序**取最新（同例：真正活跃的会话文件比那 5 个同批目录**晚 10 小时**，一眼可分）。

### 2. 解压 + 提取（**用技能自带脚本，别手写**）

已封装为 `scripts/extract-session.js`（与本技能同目录，在项目根下直接跑）：

```bash
node .codebuddy/skills/dsh-review/scripts/extract-session.js          # 自动选最新会话，输出全部段落
node .codebuddy/skills/dsh-review/scripts/extract-session.js --list   # 列会话（按 .zstd 文件 mtime 降序）
node .codebuddy/skills/dsh-review/scripts/extract-session.js --json   # 机器可读
```

一次输出：会话头/标题/算力 · 记录类型计数 · 工具统计 · **改动落点** · 用户输入 · **子代理与后台任务** · 失败清单 · 助手最终消息。

排障时才需要知道内部关键点：① 会话是**追加写入的多帧 zstd**，`zstdDecompressSync` 只解第一帧 → 必须按 magic `28 B5 2F FD` 切帧逐帧解压（脚本已按帧 catch，个别坏帧不影响整体）；② 工作区编码**只去冒号、保留盘符字母**（`C:\a\b` → `--C-a-b--`；初版把盘符一起删掉 → 编出 `---a-b--` 而找不到目录，**写完实测才发现**）。

### 3. 记录结构（jsonl，逐行 JSON.parse）

| type | data 字段 | 含义 |
|------|----------|------|
| `user/message` | `content` = **对象数组** `[{type:'text', text}]`（也可能是 `tool-result`） | 用户输入 / **子代理回执** / **后台任务完成通知** |
| `assistant/message` | `content`（同上，数组） | 助手消息（**它的最终自述在这里**） |
| `tool/call` | `data.name` + `data.arguments`（**JSON 字符串，需二次 parse**） | 工具调用（`read`/`edit`/`write`/`pwsh`/`grep`/`subagent`/`job_output`/`skill`…） |
| `tool/result` | `data.message.content[].content[].text`；失败判定看 `isError:true` | 工具结果（**报错/失败在此**） |
| `subagent/catalog` | — | 子代理目录（**本次 5 个，最易漏**） |
| `agent/inbox/spliced` | — | 子代理消息注入（本次 25 条） |
| `turn/start` · `request/header` · `session/title` | — | 算力配置（**model / reasoningEffort 在 request/header**）· **会话标题＝任务概括** |
| 流式噪声 | type ∈ `text-chunks`/`assistant/chunk`/`step/*`/`turn/*`/`run/*` | **过滤**，只看完整记录 |

⚠️ **两个会白跑一轮的坑**（2026-09-26 都踩了）：① `content` **不是字符串而是对象数组** → 直接拼进字符串只会得到 `[object Object]`；取文本必须 map `x.text`。② type **没有** `data.message` 这个名字（旧文档写错）→ 用 `user/message` / `assistant/message`。

提取六类信息（`extract-session.js` 已全部输出，这里只记判读口径）：

1. **用户指令**（`user/message`；`content` 是数组，**排除** `tool-result` 与系统提醒）
2. **工具统计**（按 `tool/call` 的 `data.name` 计数；`edit`/`write` 的 arguments 里 `path` 即改动落点）
3. **编辑过的文件**（改动路径集合 —— 第 4 步要拿它求交集；落在 `%TEMP%` 的是它的临时脚本，不算仓库改动）
4. **子代理产出** ★ **最易漏**（`subagent/catalog` + `user/message` 里的「Agent … sent a message」回执：本次 5 个子代理，其中一个交出 **52 条 UI/UX 发现**，而技能旧版完全没提这一环）
5. **后台任务回执** ★ 判断「它到底跑过什么」的**唯一证据**（`user/message` 里的 `background job pwsh-N finished [status: …, exit code: …]`）
6. **助手最终回复**（`assistant/message` —— 它的自述，**读，但一律当"待验证"读**）

### 4. 评估合理性（对照项目规范）

按此顺序逐项核对：

0. **被覆盖检查** ★ **先做这条**：拿「改动落点」与我**自己最近改过的文件**求交集，逐一核关键标记是否仍在。工作区里同时躺着**三种来源** —— dsh 的、文件历史债、**以及我自己的未提交改动** —— 只做 `git diff` 区分不出第三种。2026-09-26 实测：dsh 编辑的 19 个文件里**有 7 个是我前两天刚改过的**，逐个核了 15 个标记才确认没被覆盖。**漏检的代价是静默丢失已修好的 bug。**
1. **功能正确性**：抽查 dsh 改动的核心文件，实际读代码验证设计/实现（不信它的自述）。**子代理的结论同样要抽验**（★ 且**逐条读代码**复核后才可判定"未修"）：它们基于同一份（可能错误的）前提，且**与 dsh 的编辑并发执行** → 报告很可能在你读到时**已被修掉**。2026-09-27 实测：一份报告 P1 层 10 条里有 **9 条**已在工作区修好并带注释，我照报告标了"❗未修"还给用户列了"今天必修"——**是错的**。判据：每条发现必须能在**当前代码**里复现，才叫未修；报告只是线索。
2. **重复契约复检** ★：检查它**新增**的代码有没有又造一份"手工同步的重复"（两处各写常量/清单/判据，靠注释说"改一处必须同改"）。本项目这类问题**已三次造成实际 bug**（2026-09-26 那次是 `_monthKey` 在 `guard` 与 `ai-accounting` 各一份）。判据：同一事实出现在 ≥2 处且彼此没有 `require` 关系。
3. **工程宪法**：禁 `any`；不掩盖失败；静态（tsc/lint/jest）+ 运行时自检。
4. **部署纪律**：改 `cloudfunctions/` → 需部署对应函数；改 `_shared/*` → 改主源 → `sync-shared.js` → 部署消费方。
5. **lint 归因**：eslint 报的 `no-var`/`prefer-template` 要**用 `git diff` 区分三种来源**：dsh 新增 / 文件历史债 / 我自己的改动。dsh 新增代码通常干净（`const`），别把文件历史债算到它头上（2026-09-26：137 处问题里只有 **3 处**是它新增的）。
6. **命名/字段/数据红线**：camelCase/snake_case、`_openid` 必含、禁存敏感字段、时间字段跨集合统一。
7. **它跑过 ≠ 结论正确**：dsh **能跑**测试/lint（见定位节）→ 先看后台任务回执判断**它跑过什么**，再**独立复跑**。别因为它"没跑"就下结论，也别因为它"跑了"就采信。

### 5. 纠偏

- 修复 **dsh 新增代码**引入的 lint 违规（prefer-template、缩进等），**不动文件原有问题**（手术式修改）。
- 修正 dsh 的错误设计决策（如有）。
- 注意：纠偏后**重跑相关测试**确认无回归。

### 6. 补做清单（dsh **未必做过**的事 —— 不是"做不了"）

```bash
# 1. 测试（全量 + 相关套件）—— 独立复跑，不采信会话里的 exit 0
npx jest --silent                       # 全量回归
npx jest tests/<相关>.test.js           # 定向验证

# 2. lint（用 eslint@8，项目配置是旧格式）
npx --yes eslint@8.57.0 <改动的文件...>

# 3. _shared 同步：先 --check 再实跑，两步合起来才能判断它是否已同步
node scripts/sync-shared.js --check     # 副本是否一致
node scripts/sync-shared.js             # 实跑：若报 0 updated → 说明 dsh 已同步过（无需补）
                                        #        若报 N updated → 它改了主源没同步，本次已补

# 4. 部署
tcb fn code update <fn>                 # CLI 路径：实测不会清空环境变量
# 改 _shared/* → 所有消费方都要部署（别只部署改动的那个函数）
# 若走 MCP cloudbase 路径：部署会覆盖环境变量 → 必须回查 Env，被清空则 updateFunctionConfig 合并写回
```

⚠️ **核对 Env 时的坑**：`tcb fn detail <fn>` 会把环境变量**含密钥明文打印**到终端 ✗ —— 2026-09-26 实测发生，且该输出会进会话记录。**别在有日志留存的场合跑**；只需确认"存在"时，用 grep 过滤键名而不要打印值。

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

报告要点：任务内容（用户指令，含**子代理**分派的子任务）、dsh 做了什么（工具/文件/临时脚本）、**评估结论**（合理处+问题处，含"它已自测过什么"与"哪里踩坑又自己抓住"）、**被覆盖检查结论**（与我近期改动求交集的结果）、**重复契约复检结论**、补做明细（测试数 / lint 修复 / 同步 / 部署）、部署后 Env 核对结果。

**同时追加一行到项目 `README.md` 的「最近部署记录」**（本项目的既定习惯）：日期 · 会话摘要 · 评估与纠偏 · 补做与部署 · 涉及函数。技能改动无需部署，但复审本身要留痕。

## 红旗

- **dsh 的改动文件与我最近改过的文件有交集** → 必做被覆盖检查（第 4 步 0）——这是最可能造成**静默损失**的一条。
- dsh 编辑后无验证痕迹 → 必独立复跑测试（它**能**跑，跑过也不代表对；后台任务回执只是线索）。
- 会话里只有它自己的 `exit code 0`、没有后台任务回执 → 可能真没跑，也可能跑了没回执 → 一律自己复跑。
- 改 `_shared` 未同步副本 → 必同步（防"白改"——改副本=白改，改主源才是源头）；**先 `--check` 再实跑**才能判定它是否已同步。
- 改 `cloudfunctions/` 未部署 → 必部署（含所有 `_shared` 消费方），且核对 Env。
- **dsh 新增的"回归测试"全是源码文本/正则断言**（本项目的常见风格：`expect(src).toMatch(...)`、`match(...).length).toBe(N)`）→ 必跑一次 `npx --yes eslint@8.57.0 <改动文件> -f unix` 并**只看真错误类别**（`no-undef`/`no-dupe-keys`/`no-unreachable`/`no-const-assign`）。文本断言对**作用域、未定义标识符、跨模块接线**零检出：2026-09-28 实测 `reportAI._blockedReportResult` 引用 handler 作用域的 `const _releaseLock`（ReferenceError），3 条文本断言全绿放行，只有 `no-undef` 抓得到。
- **部署前必查 env 漂移**：`tcb fn deploy` 会按 `cloudbaserc.json` 的 `envVariables` 覆盖线上值 → 先用 `tcb fn detail <fn> --json`（**落盘后用 node 只打印 `Variables[].Key`，别让值进终端**）对比本地配置，**线上有而本地缺 → 先把线上值回写 `cloudbaserc.json` 再部署**，否则一次 redeploy 就清空该变量（2026-09-28 实测 `conversationAI` 线上有 `DEEPSEEK_API_KEY`、本地配置缺）。
- 会话显示 cwd 是 `$DSH_HOME/profiles/web` 而非项目目录 → 检查 `DSH_CWD` 是否配置（setx 后重启 dsh）。
- 用 `git diff` 前别信任何 lint 归因——先看 diff 再下结论（三种来源）。

## 平台事实备忘（防止重复排查）

- junction 在部分 Windows 环境创建即失效（Node 无法 follow）→ dsh 回退层 510 链接坏 → 已用**物理复制**到 `$DSH_HOME/profiles/web/node_modules` 绕过（勿再删）。迁移 D 盘后回退层由 dsh 自动重建为指向新 npm 全局的 junction，勿再删。
- dsh 依赖解析：profile 目录物理 node_modules 优先于回退层。
- `DSH_CWD` 持久化在用户级注册表，重启 dsh 才生效。
- API key：`DEEPSEEK_API_KEY` 环境变量 + `settings.yaml` 的 `apiKeyEnv`。
- 目录选择：native 弹窗在 IDE 内置浏览器不可用 → patch 用 browse 后端（`cordis.patch.yml` 已配）。
