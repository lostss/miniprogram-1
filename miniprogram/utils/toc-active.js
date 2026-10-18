/**
 * 目录激活态（2026-10-18，第二版）
 *
 * 第一版用 IntersectionObserver 判断"哪些章节落在可视带里"，真机暴露两个问题：
 *   ① **回到顶部不回弹** —— 回滚时若可视带里暂时没有章节，规则是"保留上一次"，于是标签停在中途；
 *   ② **对应不准确** —— 章节标题被吸顶目录挡住时，该章已不在带内、下一章在带内 → 高亮跳过一章。
 *
 * 第二版改为**按滚动位置取"最后一个越过目录下沿的章节"**，这是阅读时人眼真正的判据：
 * 只要某一章的标题已经滚到目录下方（哪怕整章还在屏幕里），当前章就是它；一直滚到顶时
 * 没有任何章节越过这条线 → 回到第一章。
 *
 * 输入：
 *   offsets: [{ key, top0 }] —— 各章标题在"测量时刻"的屏幕坐标（视口坐标，含滚动量）
 *   dy:      相对测量时刻的滚动增量（scrollTop − scrollTopAtMeasure，向下为正）
 *   lineY:   目录下沿的屏幕坐标（吸顶后是常量，所以只需测一次）
 * 判据： top0 − dy <= lineY
 *
 * 为什么不在函数里做"容差/吸附"：容差属于渲染层的观感（目录高度），放在组件里用实测值，
 * 这里只保留可测的几何规则。
 *
 * @param {Array}  offsets [{ key, top0 }]
 * @param {number} dy      滚动增量
 * @param {number} lineY   目录下沿屏幕坐标
 * @returns {string} 激活的章节 key（空数组时返回 ''）
 */
function pickActiveByOffset(offsets, dy, lineY) {
  var list = offsets || []
  if (!list.length) return ''
  var d = Number(dy) || 0
  var line = Number(lineY)
  if (!isFinite(line)) line = 0
  var active = list[0].key // 默认第一章：滚到顶部时"没有章节越过线"→ 回弹到概览
  for (var i = 0; i < list.length; i++) {
    var top = Number(list[i].top0)
    if (!isFinite(top)) continue
    if (top - d <= line) active = list[i].key
    else break // 章节按文档顺序排列：第一张还在线下的，后面都不可能越过
  }
  return active || ''
}

module.exports = { pickActiveByOffset }
