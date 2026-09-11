/**
 * require 契约测试 — 防"导出名改名、调用方漏改"事故
 *
 * 事故背景（2026-08-29）：v2-context 的 buildV2Context 改名 buildFamilyContext，
 * conversationAI/index.js 解构仍用旧名 → undefined → 线上 chat 全量 500"服务繁忙"。
 * 单测 mock 掉依赖所以拦不住；本测试静态比对解构名与目标模块导出，零运行时依赖。
 *
 * 规则：扫描 cloudfunctions/* 下所有 js 的 `const { X } = require('./相对路径')`，
 * 目标文件可静态解析出 module.exports 时，断言每个解构名（别名取左侧 key）真实存在。
 */
const fs = require('fs')
const path = require('path')

const CF_ROOT = path.resolve(__dirname, '..', 'cloudfunctions')

function listJs(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    if (f === 'node_modules') continue
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) listJs(p, out)
    else if (f.endsWith('.js')) out.push(p)
  }
  return out
}

/** 静态解析模块导出名集合；解析不了（动态导出）返回 null 表示跳过 */
function parseExports(src) {
  const set = new Set()
  // 括号平衡提取 module.exports = { ... } 的对象体（嵌套对象/字符串内花括号都不截断）
  const idx = src.search(/module\.exports\s*=\s*\{/)
  let body = null
  if (idx >= 0) {
    const start = src.indexOf('{', idx)
    let depth = 0
    let i = start
    while (i < src.length) {
      const c = src[i]
      if (c === '\'' || c === '"') {
        const q = c
        i++
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
        i++
        continue
      }
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { body = src.slice(start + 1, i); break }
      }
      i++
    }
  }
  if (body != null) {
    for (const part of splitTopLevel(stripComments(body))) {
      const p = part.trim()
      if (!p || p.startsWith('...')) continue
      const kv = p.match(/^([A-Za-z_$][\w$]*)\s*:/)
      if (kv) set.add(kv[1])
      else if (/^[A-Za-z_$][\w$]*$/.test(p)) set.add(p)
      // 其余（计算属性/字符串键等）无法静态确认，跳过
    }
  }
  const re = /exports\.([A-Za-z_$][\w$]*)\s*=/g
  let em
  while ((em = re.exec(src))) set.add(em[1])
  // 只有 module.exports = 字面量或 exports.X 两种写法可确认；都没有则跳过
  if (body == null && set.size === 0) return null
  return set
}

/** 剥离行/块注释（字符串感知：字符串里的 // 不算注释），防止注释与键名黏连导致丢键 */
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\'' || c === '"') {
      const q = c
      out += c
      i++
      while (i < src.length && src[i] !== q) { out += src[i]; if (src[i] === '\\') { i++; out += src[i] || '' } i++ }
      if (i < src.length) { out += src[i]; i++ }
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** 按顶层逗号切分对象体（嵌套 {} / [] / 字符串内的逗号不切） */
function splitTopLevel(body) {
  const parts = []
  let depth = 0
  let cur = ''
  let i = 0
  while (i < body.length) {
    const c = body[i]
    if (c === '\'' || c === '"') {
      const q = c
      cur += c
      i++
      while (i < body.length && body[i] !== q) { cur += body[i]; if (body[i] === '\\') { i++; cur += body[i] || '' } i++ }
      if (i < body.length) { cur += body[i]; i++ }
      continue
    }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    if (c === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += c
    i++
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

/** 解构名列表：`{ a, b: alias }` → ['a','b']（别名取左侧 key，与目标导出比对） */
function parseDestructuredNames(raw) {
  const names = []
  for (let part of raw.split(',')) {
    part = part.trim()
    if (!part || part.startsWith('...')) continue
    const kv = part.match(/^([A-Za-z_$][\w$]*)\s*:/)
    names.push(kv ? kv[1] : part)
  }
  return names
}

function collectViolations() {
  const violations = []
  const funcs = fs.readdirSync(CF_ROOT).filter(d => {
    const p = path.join(CF_ROOT, d)
    return fs.statSync(p).isDirectory() && d !== '_shared' && d !== 'node_modules'
  })
  for (const fn of funcs) {
    for (const file of listJs(path.join(CF_ROOT, fn))) {
      const src = fs.readFileSync(file, 'utf8')
      // 支持一级成员链：require('./config').AI — 深于一级（.A.B）放弃检查
      const re = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](\.[^'"]*)['"]\s*\)((?:\.[A-Za-z_$][\w$]*){0,1})/g
      let m
      while ((m = re.exec(src))) {
        const target = path.resolve(path.dirname(file), m[2])
        const targetFile = fs.existsSync(target) ? target : target + '.js'
        if (!fs.existsSync(targetFile)) continue // 缺文件由部署侧/其他检查管
        const member = (m[3] || '').replace(/^\./, '')
        const exportsSet = member
          ? parseNestedExports(fs.readFileSync(targetFile, 'utf8'), member)
          : parseExports(fs.readFileSync(targetFile, 'utf8'))
        if (!exportsSet) continue
        for (const name of parseDestructuredNames(m[1])) {
          if (!exportsSet.has(name)) {
            const via = member ? `（经 .${member}）` : ''
            violations.push(
              `${path.relative(CF_ROOT, file)} 解构了 { ${name} }，但 ${path.relative(CF_ROOT, targetFile)}${via} 未导出该名字`
            )
          }
        }
      }
    }
  }
  return violations
}

/** 解析 module.exports 对象里某个嵌套成员（如 AI: {...}）的键集合；无法静态解析返回 null */
function parseNestedExports(src, member) {
  const idx = src.search(/module\.exports\s*=\s*\{/)
  if (idx < 0) return null
  const start = src.indexOf('{', idx)
  let depth = 0
  let i = start
  let end = -1
  while (i < src.length) {
    const c = src[i]
    if (c === '\'' || c === '"') {
      const q = c
      i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
      i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i; break } }
    i++
  }
  if (end < 0) return null
  const body = stripComments(src.slice(start + 1, end))
  for (const part of splitTopLevel(body)) {
    const kv = part.trim().match(new RegExp('^' + member + '\\s*:\\s*\\{'))
    if (kv) {
      const inner = part.trim().replace(new RegExp('^' + member + '\\s*:\\s*'), '')
      if (!inner.startsWith('{')) return null
      const innerBody = inner.slice(1, inner.lastIndexOf('}'))
      const set = new Set()
      for (const p of splitTopLevel(innerBody)) {
        const t = p.trim()
        const ikv = t.match(/^([A-Za-z_$][\w$]*)\s*:/)
        if (ikv) set.add(ikv[1])
        else if (/^[A-Za-z_$][\w$]*$/.test(t)) set.add(t)
      }
      return set.size ? set : null
    }
  }
  return null
}

describe('require 契约：解构名必须存在于目标模块导出', () => {
  test('云函数所有相对路径解构引用与导出一致', () => {
    const violations = collectViolations()
    if (violations.length) {
      throw new Error('发现解构名与导出不匹配（改名漏改事故模式）：\n  - ' + violations.join('\n  - '))
    }
  })

  test('回归样本：conversationAI 对 v2-context 的解构有效（2026-08-29 线上 500 事故）', () => {
    const src = fs.readFileSync(path.join(CF_ROOT, 'conversationAI', 'index.js'), 'utf8')
    const m = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(\s*['"]\.\/_shared\/v2-context['"]\s*\)/)
    expect(m).toBeTruthy()
    const exportsSet = parseExports(
      fs.readFileSync(path.join(CF_ROOT, 'conversationAI', '_shared', 'v2-context.js'), 'utf8')
    )
    for (const name of parseDestructuredNames(m[1])) {
      expect(exportsSet.has(name)).toBe(true)
    }
  })
})
