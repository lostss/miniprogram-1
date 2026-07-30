/**
 * markers.js — AI 输出标记清理的单一事实源
 *
 * 解决问题：chat-panel/index.js 的 _stripMarkers（兜底落库）和流式 onText 回调
 * 各持一份正则，规则已漂移（_stripMarkers 多 trim 和 [\/TOOL]，流式版多未闭合截断）。
 * 后端新增标记类型需同步改两处，极易漏改。
 *
 * 设计：纯函数 + partial 选项
 *  - cleanMarkers(text)        → 兜底清理（落库前）
 *  - cleanMarkers(text, {partial:true}) → 流式清理（含未闭合标记截断）
 */
function cleanMarkers(text, opts) {
  if (!text) return ''
  opts = opts || {}
  let s = text
    .replace(/\[TOOL:\w+\][\s\S]*?\[\/TOOL\]/g, '')
    .replace(/\[CARD:\w+\][\s\S]*?\[\/CARD\]/g, '')
    .replace(/\[TOOL:\w+\]/g, '')
    .replace(/\[\/TOOL\]/g, '')
    .replace(/\[INTENT(?::\w+)?\]/g, '')
  // partial 模式：流式输出中，未闭合的 [TOOL:/[CARD:/[INTENT 起截断
  if (opts.partial) {
    const idx = s.search(/\[(TOOL|CARD|INTENT)/)
    if (idx >= 0) s = s.substring(0, idx)
  }
  // 兜底模式（非 partial）：trim 空白
  if (!opts.partial) {
    return s.trim()
  }
  return s
}

module.exports = { cleanMarkers }
