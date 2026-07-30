#!/usr/bin/env node
/**
 * sync-shared.js — 将 cloudfunctions/_shared/ 分发到各云函数目录
 *
 * 用法：node scripts/sync-shared.js [--broadcast] [--no-prune] [--dry-run] [--check]
 *
 * 默认（闭包式 + 自动清理）：只把每个云函数【实际 require 到的】_shared 文件复制到其 _shared/，
 *   并自动清理副本中陈旧的死文件。
 *   推导方式：从函数根目录的 .js 出发，沿 require('./_shared/X') 与
 *   _shared 内部 require('./Y') 求传递闭包；未出现在闭包中的文件不复制。
 *   这样 ocrService 等只用本地文件的云函数，不会塞进整套对话/报告专用死代码。
 *
 * --broadcast：回退旧行为，广播 _shared 全部文件到每个函数（兼容老习惯）。
 * --no-prune：禁用默认的自动清理。默认会删除副本中存在、但【权威源有此文件且不在本函数闭包中】
 *   的死文件（权威源中已删除的文件、或本函数从不引用的却因旧广播残留的文件）。
 *   函数独有的 _shared 文件（权威源中不存在）一律保留。
 *
 * --dry-run：只打印将要发生的变更，不写文件。
 * --check：等价于 --dry-run，但检测到任何 create/update/prune 时以退出码 1 退出。
 *   用于 CI / precommit 守护 _shared 单一事实源，防止副本漂移。
 *
 * 跨树契约：CONTRACT_FILES 中的文件额外同步到 miniprogram/utils/，
 * 使前端与云函数共用同一事实源。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SHARED_SRC = path.join(ROOT, 'cloudfunctions', '_shared')
const CF_DIR = path.join(ROOT, 'cloudfunctions')

const broadcast = process.argv.includes('--broadcast')
// prune 默认开启：自动清理副本中陈旧的死文件。--no-prune 显式禁用。
const prune = !process.argv.includes('--no-prune')
// --check 隐含 --dry-run，并在检测到漂移时以退出码 1 退出（CI / precommit 守护）
const check = process.argv.includes('--check')
const dryRun = check || process.argv.includes('--dry-run')

// ponytail: 自动发现需要同步 _shared/ 的云函数，不再硬编码
// 判定标准：已存在 _shared 目录，或根目录 .js 中出现 require('./_shared/...')
// 后者覆盖 login 等新增 _shared 依赖的云函数（首次同步前还没有 _shared 子目录）
const TARGET_FUNCTIONS = fs.readdirSync(CF_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name !== '_shared')
  .filter(d => {
    const fnDir = path.join(CF_DIR, d.name)
    if (fs.existsSync(path.join(fnDir, '_shared'))) return true
    const rootFiles = fs.readdirSync(fnDir).filter(f => f.endsWith('.js') && fs.statSync(path.join(fnDir, f)).isFile())
    return rootFiles.some(f => {
      try {
        const src = fs.readFileSync(path.join(fnDir, f), 'utf-8')
        return /require\(\s*['"]\.\/_shared\//.test(src)
      } catch (_) { return false }
    })
  })
  .map(d => d.name)

// 跨树契约文件：_shared 权威源 → miniprogram/utils/，使前端与云函数共用同一事实源
// ponytail: 只列确需前端引用的文件，避免把云函数专用逻辑泄漏进小程序
const CONTRACT_FILES = ['thresholds.js', 'pii-rules.js', 'parse-expiry.js']

// 扫描一个 .js 文件中、解析到 _shared/ 下的 require 目标（返回相对 _shared 的路径，'/' 分隔）
// fileAbs 可能是：
//   - 目标函数根目录文件（require './_shared/X'，target 落在 fnDir/_shared 下）
//   - 权威源 _shared 内部文件（require './Y'，target 落在 SHARED_SRC 下）
// 两种情况分别用 fnDir/_shared 和 SHARED_SRC 作为基准计算 rel，取不以 .. 开头的那个。
function findSharedReqs(fnDir, fileAbs) {
  let src
  try { src = fs.readFileSync(fileAbs, 'utf-8') } catch (_) { return [] }
  const reqs = []
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  const fnSharedDir = path.join(fnDir, '_shared')
  while ((m = re.exec(src))) {
    const spec = m[1]
    if (!spec.startsWith('.')) continue
    const target = path.resolve(path.dirname(fileAbs), spec)
    // 优先用 fnDir/_shared 计算（根目录文件路径），再用 SHARED_SRC 计算（_shared 内部文件路径）
    let rel = path.relative(fnSharedDir, target).replace(/\\/g, '/')
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel) {
      rel = path.relative(SHARED_SRC, target).replace(/\\/g, '/')
    }
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      if (fs.existsSync(path.join(SHARED_SRC, rel + '.js'))) reqs.push(rel + '.js')
      else if (fs.existsSync(path.join(SHARED_SRC, rel, 'index.js'))) reqs.push(rel + '/index.js')
    }
  }
  return reqs
}

// 求某函数需要的 _shared 文件闭包（相对 _shared 的路径集合）
// 注意：_shared 内部文件的依赖扫描读【权威源 SHARED_SRC】，而非目标目录的副本——
// 否则新增 require 依赖时，目标副本还是旧的，闭包计算发现不了新依赖（鸡生蛋问题）。
function requiredShared(fnDir) {
  const sharedDir = path.join(fnDir, '_shared')
  const rootFiles = fs.readdirSync(fnDir).filter(f => f.endsWith('.js') && fs.statSync(path.join(fnDir, f)).isFile())
  const seen = new Set()
  const queue = []
  for (const rf of rootFiles) {
    for (const r of findSharedReqs(fnDir, path.join(fnDir, rf))) {
      if (!seen.has(r)) { seen.add(r); queue.push(r) }
    }
  }
  while (queue.length) {
    const rel = queue.pop()
    // 读权威源的对应文件，确保新增 require 能被发现
    const authorityAbs = path.join(SHARED_SRC, rel)
    for (const r of findSharedReqs(fnDir, authorityAbs)) {
      if (!seen.has(r)) { seen.add(r); queue.push(r) }
    }
  }
  return seen
}

function getAllFiles(dir, base = '') {
  let results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = base ? base + '/' + entry.name : entry.name
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) results = results.concat(getAllFiles(fullPath, relPath))
    else if (entry.isFile() && entry.name.endsWith('.js')) results.push(relPath)
  }
  return results
}

function syncFunction(fnName) {
  const fnDir = path.join(CF_DIR, fnName)
  const targetDir = path.join(fnDir, '_shared')
  let created = 0, updated = 0, skipped = 0, pruned = 0

  if (!fs.existsSync(targetDir)) {
    if (!dryRun) fs.mkdirSync(targetDir, { recursive: true })
    console.log(`  [mkdir] ${fnName}/_shared/`)
  }

  // 闭包式：只复制本函数实际依赖的 _shared 文件；broadcast 才复制全部
  let srcFiles
  if (broadcast) {
    srcFiles = getAllFiles(SHARED_SRC)
  } else {
    srcFiles = Array.from(requiredShared(fnDir))
  }

  for (const relPath of srcFiles) {
    const srcFile = path.join(SHARED_SRC, relPath)
    const destFile = path.join(targetDir, relPath)
    const content = fs.readFileSync(srcFile, 'utf-8')

    const destDir = path.dirname(destFile)
    if (!fs.existsSync(destDir)) {
      if (!dryRun) fs.mkdirSync(destDir, { recursive: true })
      console.log(`  [mkdir] ${fnName}/_shared/${path.dirname(relPath)}/`)
    }

    if (!fs.existsSync(destFile)) {
      if (!dryRun) fs.writeFileSync(destFile, content, 'utf-8')
      console.log(`  [create] ${fnName}/_shared/${relPath}`)
      created++
    } else {
      const existing = fs.readFileSync(destFile, 'utf-8')
      if (existing !== content) {
        if (!dryRun) fs.writeFileSync(destFile, content, 'utf-8')
        console.log(`  [update] ${fnName}/_shared/${relPath}`)
        updated++
      } else skipped++
    }
  }

  // prune：删除副本中【权威源有、但不在本函数闭包】的死文件（函数独有文件保留）
  if (prune && !broadcast) {
    const needed = new Set(requiredShared(fnDir))
    for (const relPath of getAllFiles(targetDir)) {
      const inAuthority = fs.existsSync(path.join(SHARED_SRC, relPath))
      if (inAuthority && !needed.has(relPath)) {
        const f = path.join(targetDir, relPath)
        if (!dryRun) fs.unlinkSync(f)
        console.log(`  [prune] ${fnName}/_shared/${relPath}`)
        pruned++
      }
    }
  }

  return { created, updated, skipped, pruned }
}

// Main
console.log('Syncing _shared/ to cloud functions...')
console.log(`mode: ${broadcast ? 'broadcast' : 'closure'}${prune ? ' + prune' : ' (no-prune)'}${dryRun ? ' (dry-run)' : ''}${check ? ' (check)' : ''}\n`)

let totalCreated = 0, totalUpdated = 0, totalSkipped = 0, totalPruned = 0
for (const fn of TARGET_FUNCTIONS) {
  console.log(`\n${fn}/_shared/`)
  const { created, updated, skipped, pruned } = syncFunction(fn)
  totalCreated += created
  totalUpdated += updated
  totalSkipped += skipped
  totalPruned += pruned
}

// 跨树契约：把 _shared 权威源中的契约文件同步到小程序 utils/
let contractCreated = 0, contractUpdated = 0, contractSkipped = 0
for (const name of CONTRACT_FILES) {
  const srcFile = path.join(SHARED_SRC, name)
  if (!fs.existsSync(srcFile)) continue
  const destFile = path.join(ROOT, 'miniprogram', 'utils', name)
  const content = fs.readFileSync(srcFile, 'utf-8')
  if (!fs.existsSync(destFile)) {
    if (!dryRun) fs.writeFileSync(destFile, content, 'utf-8')
    console.log(`  [create] miniprogram/utils/${name}`)
    contractCreated++
  } else {
    const existing = fs.readFileSync(destFile, 'utf-8')
    if (existing !== content) {
      if (!dryRun) fs.writeFileSync(destFile, content, 'utf-8')
      console.log(`  [update] miniprogram/utils/${name}`)
      contractUpdated++
    } else contractSkipped++
  }
}

console.log(`\nDone: ${totalCreated} created, ${totalUpdated} updated, ${totalSkipped} unchanged${prune ? `, ${totalPruned} pruned` : ''}`)
if (CONTRACT_FILES.length > 0) console.log(`Contract: ${contractCreated} created, ${contractUpdated} updated, ${contractSkipped} unchanged (miniprogram/utils/)`)
if (dryRun && !check) console.log('(dry-run — no files were written)')

// CI / precommit 守护：检测到任何漂移则非 0 退出
if (check) {
  const drift = totalCreated + totalUpdated + totalPruned + contractCreated + contractUpdated
  if (drift > 0) {
    console.error(`\n❌ Check failed: ${drift} file(s) would change. Run 'node scripts/sync-shared.js' to sync.`)
    process.exit(1)
  } else {
    console.log('\n✓ Check passed: _shared/ in sync.')
  }
}
