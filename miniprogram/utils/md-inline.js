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

module.exports = { _toFullwidth }
