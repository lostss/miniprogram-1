/**
 * WXSS 语法守卫（2026-10-17）
 *
 * 起因（真机实测）：给 `.gt-tick` 追加 `white-space:nowrap;` 时，原行末已有分号 →
 * 生成 `;;` → 微信开发者工具报
 *   `WXSS 文件编译错误 ... index.wxss:110:3 unexpected token ';'`
 * → **整个报告页白屏**（不是样式错乱，是编译失败）。
 *
 * 为什么必须单独守：jest 只跑 JS，**从不编译 wxss** ——
 * 单元测试全绿、lint 全绿、pre-commit 全过，用户打开就是白屏。
 * 这是目前唯一能在推送前抓到这类错误的关口（项目无 CI）。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.wxss')) out.push(p)
  }
  return out
}

const files = walk(ROOT, [])
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

describe('WXSS 语法（编译失败会导致整页白屏）', () => {
  test('至少扫到全部 wxss（防 walk 失效导致"零检查通过"）', () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
  })

  test('没有空声明 / 双分号（WXSS 编译器拒绝 `;;`）', () => {
    const bad = files.filter((f) => /;;/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    expect(bad.map((f) => path.relative(ROOT, f))).toEqual([])
  })

  test('声明块不以分号开头（`{ ;` 同样会报 unexpected token）', () => {
    const bad = files.filter((f) => /\{\s*;/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    expect(bad.map((f) => path.relative(ROOT, f))).toEqual([])
  })

  test('花括号成对（漏闭合会让后续所有规则失效）', () => {
    const bad = []
    for (const f of files) {
      const s = stripComments(fs.readFileSync(f, 'utf8'))
      const open = (s.match(/\{/g) || []).length
      const close = (s.match(/\}/g) || []).length
      if (open !== close) bad.push(path.relative(ROOT, f) + ' ' + open + '/' + close)
    }
    expect(bad).toEqual([])
  })
})
