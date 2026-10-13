/**
 * _shared/markers.js — AI 输出「旧协议标记」清理的唯一事实源（跨树契约）
 *
 * 背景（架构审查候选 5）：本模块此前是**人工镜像**——后端 `conversationAI/prompts.js`
 * 的 `stripToolCardMarkers` 与前端 `miniprogram/utils/markers.js` 的 `cleanMarkers`
 * 各持一份正则、靠人工同步，并且**已经漂移**：前端缺 `{TOOL_INTENT:...}` 规则
 * → v9 旧协议残留在前端不被清理，会漏到用户可见文本里。
 * 现抽为 `_shared` 契约（由 `sync-shared.js` 的 CONTRACT_FILES 同步到 `miniprogram/utils/`），
 * **新增标记类型只改本文件一处**，两侧不可能再漂移。
 *
 * 三个消费点的语义差异用选项表达，不再用分叉实现表达：
 *   - 后端落库前（`conversationAI/index.js`）：`cleanMarkers(text)`
 *   - 前端兜底（`chat-panel` 落库前）      ：`cleanMarkers(text)`
 *   - 前端流式 partial（流式已废弃，保留）  ：`cleanMarkers(text, { partial: true })` — 未闭合标记起截断，不 trim
 *
 * 术语：v9 双通道用文本标记承载工具意图/卡片；v10 改原生 function calling 后这些标记已废弃，
 * 但历史消息与模型幻觉仍可能产出 → 清理是兜底防线，不是主协议。
 */

/** 已废弃的旧协议标记名。**新增标记类型只改这里**（partial 截断锚点由它派生） */
const MARKER_TAGS = ['TOOL', 'CARD', 'INTENT']

/**
 * 闭合标记 → 整段删除（标记与其中内容一起丢：那是协议载荷，不是给用户看的）。
 * 注意：模块级 /g 正则配合 `String.replace` 使用是安全的（replace 会重置 lastIndex）。
 */
const MARKER_PAIR_RE = [
  /\[TOOL:\w+\][\s\S]*?\[\/TOOL\]/g,
  /\[CARD:\w+\][\s\S]*?\[\/CARD\]/g
]

/** 残缺/单点标记 → 只删标记本身，保留正文（模型常只吐半个标记） */
const MARKER_LOOSE_RE = [
  /\[TOOL:\w+\]/g,
  /\[\/TOOL\]/g,
  /\[INTENT(?::\w+)?\]/g,
  /\{TOOL_INTENT:[\s\S]*?\}\s*/g
]

/** partial 模式的截断锚点：未闭合标记的起始位置（由 MARKER_TAGS 派生） */
const MARKER_PARTIAL_RE = new RegExp('\\[(' + MARKER_TAGS.join('|') + ')')

/**
 * 清理 AI 输出中的旧协议标记。
 * @param {string} text
 * @param {{partial?: boolean, trim?: boolean}} [opts]
 *   partial=true：流式场景，遇未闭合标记起截断（隐含不 trim）
 *   trim=false  ：保留首尾空白（默认 trim）
 * @returns {string}
 */
function cleanMarkers(text, opts) {
  if (!text) return ''
  const o = opts || {}
  let s = text
  for (const re of MARKER_PAIR_RE) s = s.replace(re, '')
  for (const re of MARKER_LOOSE_RE) s = s.replace(re, '')
  if (o.partial) {
    const idx = s.search(MARKER_PARTIAL_RE)
    if (idx >= 0) s = s.substring(0, idx)
    // 流式片段：不 trim（拼接在途，尾部空白有意义）
    return s
  }
  return o.trim === false ? s : s.trim()
}

/**
 * 后端历史 API（`conversationAI/index.js` 沿用旧名）。
 * 行为 == `cleanMarkers(text)`，保留导出以免调用点与测试连锁改动。
 */
function stripToolCardMarkers(text) {
  return cleanMarkers(text)
}

module.exports = { MARKER_TAGS, cleanMarkers, stripToolCardMarkers }
