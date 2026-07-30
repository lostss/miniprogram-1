// 行内渲染公共引擎：全角标点 + 上标拆分
// report-markdown 与 markdown-render 共用，避免渲染行为分叉
// （report 侧曾单独实现导致表格上标错位；chat 侧缺失全角导致标点不一致）

function _toFullwidth(s) {
  return s
    .replace(/,/g, '，')
    .replace(/;/g, '；')
    .replace(/:/g, '：')
    .replace(/!/g, '！')
    .replace(/\?/g, '？')
    .replace(/\(/g, '（')
    .replace(/\)/g, '）')
    .replace(/\.(?![a-zA-Z0-9])/g, '。')  // 避免替换版本号中的点
}

const _SUP_RE = /[⁹²³⁰⁴-⁹]/  // ¹²³⁰⁴-⁹ 上标 Unicode

function _splitSupers(s) {
  const parts = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (_SUP_RE.test(ch)) {
      let j = i + 1
      while (j < s.length && _SUP_RE.test(s[j])) j++
      parts.push({ t: s.slice(i, j), sup: true })
      i = j
    } else {
      let j = i + 1
      while (j < s.length && !_SUP_RE.test(s[j])) j++
      parts.push({ t: s.slice(i, j), sup: false })
      i = j
    }
  }
  return parts.length ? parts : [{ t: s, sup: false }]
}

module.exports = { _toFullwidth, _splitSupers }
