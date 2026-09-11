/**
 * extract-pdf.js — pdf-parse 提取条款文本（产品条款导入 skill）
 * 用法：node scripts/extract-pdf.js <input.pdf> [--out out.txt]
 * 扫描件判定：提取文本 < 100 字符 → 拒绝（提示请上传文本型 PDF，本 skill 不逐页 OCR）。
 * 注意：pdf-parse 锁定 1.1.1（v2 依赖 pdfjs-dist 34MB 不可用）。
 */
const fs = require('fs')
const path = require('path')
const pdf = require('pdf-parse')

const MIN_TEXT = 100

async function main() {
  const args = process.argv.slice(2)
  const input = args.find(a => !a.startsWith('--'))
  const outIdx = args.indexOf('--out')
  const out = outIdx > -1 ? args[outIdx + 1] : null
  if (!input) { console.error('用法: node scripts/extract-pdf.js <input.pdf> [--out out.txt]'); process.exit(1) }

  const data = await pdf(fs.readFileSync(input))
  const text = (data.text || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (text.length < MIN_TEXT) {
    console.error('扫描件判定：提取文本过短（' + text.length + ' 字符）。请上传文本型 PDF。')
    process.exit(2)
  }
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
    fs.writeFileSync(out, text, 'utf8')
  }
  console.log('OK: pages=' + data.numpages + ' chars=' + text.length + (out ? ' -> ' + out : ''))
  if (!out) console.log(text.substring(0, 300))
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1) })
