/**
 * fetch-clause.js — 下载条款 PDF（产品条款导入 skill）
 * 用法：node scripts/fetch-clause.js <url> <output.pdf>
 * 校验：HTTP 200 + %PDF 魔数 + 非空。
 */
const fs = require('fs')
const path = require('path')

async function main() {
  const args = process.argv.slice(2)
  const url = args.find(a => !a.startsWith('--'))
  const outIdx = args.indexOf('--out')
  const out = outIdx > -1 ? args[outIdx + 1] : null
  if (!url || !out) { console.error('用法: node scripts/fetch-clause.js <url> --out <output.pdf>'); process.exit(1) }
  if (!/^https?:/i.test(url)) { console.error('仅支持 http(s) 直链'); process.exit(1) }

  console.log('下载:', url)
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: new URL(url).origin + '/' }
  })
  if (!res.ok) { console.error('HTTP ' + res.status + '（官方源 404 属站点差异，可请用户提供条款文件）'); process.exit(1) }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 5 || buf.slice(0, 4).toString('latin1') !== '%PDF') {
    console.error('非 PDF 文件（魔数校验失败）'); process.exit(1)
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, buf)
  console.log('OK:', out, buf.length + ' bytes')
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1) })
