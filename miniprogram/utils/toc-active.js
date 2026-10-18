/**
 * 目录激活态（2026-10-18）
 *
 * 目标：报告页顶部吸顶章节标签，高亮"当前正在读哪一章"。
 *
 * 为什么不用 scroll 事件算偏移：章节节点在 report-markdown 组件内部，滚动容器在**页面**上，
 * 组件拿不到 scrollTop。改用 IntersectionObserver（relativeToViewport），让节点自己报告
 * "我是否落在目录下方那条可视带里"，组件只做一次归约。
 *
 * 归约规则（纯函数，便于单测）：按目录顺序取**第一个**可见的章节 ——
 * 多个章节同时可见时（屏内能装两章），用户视线在上方那一章，取第一个才符合直觉。
 * 一个都不可见（章节全部折叠、或滚过末尾）时**保留上一次的激活项**，不要清空 ——
 * 清空会让标签在滚动中闪一下，比"稍微滞后"更糟。
 *
 * @param {string[]} keys  目录顺序（章节 key）
 * @param {object}   seen  { [key]: true } 当前可见的章节集合
 * @param {string}   prev  上一次的激活 key（兜底）
 * @returns {string} 应当激活的 key（可能为空串：首次进入且什么都不可见）
 */
function pickActiveKey(keys, seen, prev) {
  var list = keys || []
  var map = seen || {}
  for (var i = 0; i < list.length; i++) {
    if (map[list[i]]) return list[i]
  }
  return prev || ''
}

module.exports = { pickActiveKey }
