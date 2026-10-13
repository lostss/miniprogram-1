#!/usr/bin/env node
/**
 * extract-session.js — 解压并结构化提取 dsh 会话（dsh-review 复审专用）
 *
 * 用法：
 *   node scripts/extract-session.js              # 自动选最新会话
 *   node scripts/extract-session.js --list       # 列出所有会话（按 zstd 文件 mtime 排序）
 *   node scripts/extract-session.js <dir|file>   # 指定会话目录或 .zstd 文件
 *   node scripts/extract-session.js --json       # 输出 JSON（供进一步处理）
 *
 * 为什么有这个脚本（2026-09-26 复审实录，别再手写一遍）：
 *   ① 会话是**追加写入的多帧 zstd**，`zstdDecompressSync` 只解第一帧 → 必须按 magic 切帧
 *   ② 目录名/文件名有**两代**（`session-<uuid>` 与裸 uuid；`session.v3.jsonl.zstd` 与 `session.jsonl.zstd`）
 *   ③ **不能按目录 mtime 选最新** —— 同批创建的目录 mtime 可能**完全相同**（实测 5 个），
 *      必须按 `.zstd` 文件自身 mtime 排
 *   ④ `content` 是**对象数组**不是字符串（直接拼只会得到 `[object Object]`）
 *   ⑤ 用 `node -e` 手写时，PowerShell 会吃掉 `$`（如 `{$in:...}`）与嵌套引号 → 用本文件免坑
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const DSH_HOME = process.env.DSH_HOME || 'D:/Users/lyy/.dsh'

/** 工作目录 → workspace-encoded（与 dsh 自身的编码一致）
 *  例：C:\Users\lyy\WeChatProjects\miniprogram-1 → --C-Users-lyy-WeChatProjects-miniprogram-1--
 *  ⚠️ 只去**冒号**、**保留盘符字母**。初版把盘符一起删掉（`replace(/^[A-Za-z]:/,'')`）→
 *  开头那个 `\` 会变成一个多余的 `-`，编出 `---Users-...` 而非 `--C-Users-...--`，目录永远找不到。
 *  （2026-09-26 写完后**实测**才发现 —— 本脚本的第一个受益者就是它自己。）
 */
function encodeWorkspace(cwd) {
  return '--' + String(cwd).replace(/^([A-Za-z]):/, '$1').replace(/[\\/]/g, '-') + '--'
}

function sessionsRoot() {
  return path.join(DSH_HOME, 'sessions', encodeWorkspace(process.cwd()))
}

/** 所有会话文件，按**文件** mtime 降序（⚠️ 不按目录 mtime） */
function listSessions() {
  const root = sessionsRoot()
  if (!fs.existsSync(root)) {
    console.error('找不到会话目录: ' + root)
    console.error('（若 dsh 的工作目录不是当前目录，请显式传入会话目录，或设置 DSH_HOME）')
    process.exit(1)
  }
  const out = []
  fs.readdirSync(root).forEach(d => {
    const dir = path.join(root, d)
    let st
    try { st = fs.statSync(dir) } catch (e) { return }
    if (!st.isDirectory()) return
    fs.readdirSync(dir).forEach(f => {
      if (!/\.jsonl\.zstd$/.test(f)) return
      const p = path.join(dir, f)
      try {
        const s = fs.statSync(p)
        out.push({ dir: d, file: f, full: p, size: s.size, mtime: s.mtimeMs })
      } catch (e) {}
    })
  })
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** 多帧 zstd 逐帧解压 */
function decompress(file) {
  const buf = fs.readFileSync(file)
  const magic = [0x28, 0xB5, 0x2F, 0xFD]
  const offsets = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) offsets.push(i)
  }
  let text = ''
  let ok = 0
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try { text += zlib.zstdDecompressSync(buf.slice(offsets[i], end)).toString('utf8'); ok++ } catch (e) {}
  }
  return { text, frames: offsets.length, ok }
}

function parseRecords(text) {
  return text.split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) } catch (e) { return null } })
    .filter(Boolean)
}

/** content 是 string | 对象数组（取 .text / 递归 .content） */
function flat(c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(x => flat(x)).join(' ')
  if (c && typeof c === 'object') return c.text || (c.content !== undefined ? flat(c.content) : JSON.stringify(c))
  return ''
}
const cut = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').slice(0, n || 240)

function argOf(r) {
  let a = (r.data || {}).arguments
  try { a = typeof a === 'string' ? JSON.parse(a) : a } catch (e) {}
  return a || {}
}
const raw = r => JSON.stringify(r.data || {})

function summarize(recs, meta) {
  const byType = {}
  const tools = {}
  const edited = {}
  const users = []
  const asst = []
  const failures = []
  const subagents = []
  const bgJobs = []
  let header = null
  let title = null
  let model = null

  recs.forEach((r, i) => {
    byType[r.type] = (byType[r.type] || 0) + 1
    const d = r.data || {}
    if (r.type === 'user/message') {
      const t = flat(d.content)
      if (t) {
        // 子代理回执 / 后台任务完成通知也走这里 —— 它们是"它做过什么"的关键证据
        // ⚠️ 分类要收紧：早期版本用 /subagent/i 兜，会把 skills 清单之类的提醒也算成子代理回执
        // 子代理回执**存全文**（不截断）：它们是待跟进的审计产出，摘要级截断等于丢内容
        if (/background job|finished \[status/i.test(t)) bgJobs.push(cut(t, 300))
        else if (/^Agent \S+ sent a message/i.test(t)) subagents.push({ kind: 'report', text: t })
        else users.push(cut(t, 400))
      }
    }
    if (r.type === 'assistant/message') {
      const t = flat(d.content)
      if (t) asst.push({ seq: i, text: t })
    }
    if (r.type === 'tool/call') {
      const nm = d.name || '?'
      tools[nm] = (tools[nm] || 0) + 1
      if (nm === 'edit' || nm === 'write') {
        const a = argOf(r)
        const p = String(a.path || a.file_path || '?').replace(/^.*miniprogram-1[\\/]/, '')
        edited[p] = edited[p] || { edit: 0, write: 0 }
        edited[p][nm]++
      }
      if (nm === 'subagent') subagents.push({ kind: 'call', text: cut(a2s(argOf(r)), 260) })
    }
    if (r.type === 'tool/result' && /"isError":true|"is_error":true|Error:|EIO|EINVAL|ENOENT/i.test(raw(r))) {
      failures.push({ seq: i, text: cut(raw(r), 300) })
    }
    if (r.type === 'request/header' && !model) {
      const h = (d.header || {}).config
      if (h) model = h.model + ' / effort=' + h.reasoningEffort
    }
    if (r.type === 'session/title' && d.title) {
      // 会有两条：先 fallback（截断自首条 prompt），后 LLM 生成（更概括）→ 优先后者
      const fallback = !!(d.source && d.source.kind === 'fallback')
      if (!title || !fallback) title = d.title
    }
    if (r.type === 'session' && !header) header = d
  })

  return { meta, byType, tools, edited, users, asst, failures, subagents, bgJobs, header, title, model }
}
function a2s(o) { try { return JSON.stringify(o) } catch (e) { return '' } }

function print(s) {
  console.log('=== 会话 ===')
  console.log('  目录: ' + s.meta.dir)
  console.log('  文件: ' + s.meta.file + '  (' + (s.meta.size / 1024).toFixed(0) + 'KB, mtime ' +
    new Date(s.meta.mtime).toISOString().replace('T', ' ').slice(0, 19) + ')')
  console.log('  帧=' + s.meta.frames + ' 解压成功=' + s.meta.ok + ' 记录=' + s.meta.records)
  if (s.title) console.log('  标题: ' + s.title)
  if (s.model) console.log('  算力: ' + s.model)
  if (s.header && Object.keys(s.header).length) console.log('  头: ' + cut(a2s(s.header), 200))

  console.log('\n=== 记录类型 ===')
  Object.keys(s.byType).sort((a, b) => s.byType[b] - s.byType[a]).forEach(k => console.log('  ' + k + ' = ' + s.byType[k]))

  console.log('\n=== 工具统计 ===')
  Object.keys(s.tools).sort((a, b) => s.tools[b] - s.tools[a]).forEach(k => console.log('  ' + k + ' = ' + s.tools[k]))

  console.log('\n=== 改动落点（edit/write）★ 第 4 步要拿它和"我自己的近期改动"求交集 ===')
  Object.keys(s.edited).sort().forEach(k => {
    const e = s.edited[k]
    console.log('  ' + (e.edit ? e.edit + 'x edit ' : '') + (e.write ? e.write + 'x write ' : '') + ' ' + k)
  })

  console.log('\n=== 用户输入（' + s.users.length + '）===')
  s.users.slice(0, 12).forEach((t, i) => console.log('  [' + i + '] ' + t))

  console.log('\n=== 子代理 / 后台任务（' + (s.subagents.length + s.bgJobs.length) + '）★ 最容易漏的证据 ===')
  s.subagents.slice(0, 8).forEach(a => console.log('  [agent] ' + (a.kind === 'call' ? a.text : cut(a.text, 400))))
  s.bgJobs.slice(0, 10).forEach(t => console.log('  [job  ] ' + t))
  if (s.subagents.some(a => a.kind === 'report')) {
    console.log('  （回执是审计产出，本视图截断显示 —— 用 --subagents 看全文）')
  }

  console.log('\n=== 失败/报错的工具结果（' + s.failures.length + '）===')
  s.failures.slice(0, 10).forEach(f => console.log('  @' + f.seq + ' ' + f.text))

  console.log('\n=== 助手最终消息（最后 1 条）===')
  const last = s.asst[s.asst.length - 1]
  if (last) console.log('  @' + last.seq + ' ' + cut(last.text, 1800))

  console.log('\n提示：改动落点请与「我最近改过的文件」求交集，逐一核对关键标记是否仍在（见 SKILL.md 第 4 步 ⑥）')
}

function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const list = args.includes('--list')
  const target = args.find(a => !a.startsWith('--'))

  const all = listSessions()
  if (list) {
    console.log('共 ' + all.length + ' 个会话文件（按 zstd 文件 mtime 降序）：')
    all.slice(0, 12).forEach(s => {
      console.log('  ' + new Date(s.mtime).toISOString().replace('T', ' ').slice(0, 19) + '  ' +
        (s.size / 1024).toFixed(0).padStart(5) + 'KB  ' + s.dir + '/' + s.file)
    })
    return
  }

  let picked
  if (!target) {
    picked = all[0]
  } else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    picked = all.find(s => s.dir === path.basename(target))
  } else if (fs.existsSync(target)) {
    picked = all.find(s => s.full === path.resolve(target)) ||
      { dir: path.basename(path.dirname(target)), file: path.basename(target), full: target, size: fs.statSync(target).size, mtime: fs.statSync(target).mtimeMs }
  } else {
    picked = all.find(s => s.dir === target || s.file === target)
  }
  if (!picked) { console.error('未找到会话: ' + (target || '(最新)')); process.exit(1) }

  const { text, frames, ok } = decompress(picked.full)
  const recs = parseRecords(text)
  const meta = { dir: picked.dir, file: picked.file, size: picked.size, mtime: picked.mtime, frames, ok, records: recs.length }
  const s = summarize(recs, meta)
  if (asJson) console.log(JSON.stringify(s, null, 1))
  else if (args.includes('--subagents')) {
    // 子代理审计产出**全文**：它们是待跟进的发现清单，截断等于丢内容
    const reps = s.subagents.filter(a => a.kind === 'report')
    console.log('子代理回执 ' + reps.length + ' 份（全文）\n')
    reps.forEach((a, i) => {
      console.log('───────── 回执 ' + (i + 1) + '/' + reps.length + ' ─────────')
      console.log(a.text)
      console.log('')
    })
  } else print(s)
}

main()
