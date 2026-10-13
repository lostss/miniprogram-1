/**
 * explore-flags.js — 探索版特性开关（MVP 内测）
 *
 * 为什么需要它：全仓此前没有任何特性开关机制，探索版若直接改现有页/入口，
 * 「删回去」只能靠 revert 提交。开关让探索入口可以一行关掉、页面整页删掉。
 *
 * 约束（刻意保持最小）：
 *   - 只放**入口可见性**这类"产品实验"开关；不放业务口径、不放环境判断（那属于配置/契约）
 *   - 探索结束即删本文件与引用它的入口（勿在此堆长期开关）
 */
const EXPLORE_FLAGS = {
  // 保单整理报告（探索版 · 内测）：客户列表页入口 + pages/checkup 页面
  checkupReport: true
}

module.exports = EXPLORE_FLAGS
