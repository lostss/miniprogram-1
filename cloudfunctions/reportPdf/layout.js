/**
 * PDF 版式纯函数（2026-10-22）
 *
 * 为什么单独抽出来：PDF 是 canvas 逐行绘制的，任何"排版对不对"都只能在导出的纸上验证。
 * 把可计算的几何（列宽、双列配对、分页切片）抽成纯函数，就能用单测钉住 ——
 * 剩下真正无法自动验证的只有"字有没有压线"，那需要真机导出。
 *
 * 约定：本项目 A4 纵向、左右边距 52pt、可用宽度 491.28pt（见 index.js 的 M / W）。
 */

/**
 * 双列并排：把一维列表切成 [{left, right}]。
 * 右列缺失时为 null（渲染侧据此只画左列，不留空洞）。
 */
function twoColumnRows(items) {
  const list = Array.isArray(items) ? items : []
  const rows = []
  for (let i = 0; i < list.length; i += 2) {
    rows.push({ left: list[i], right: i + 1 < list.length ? list[i + 1] : null })
  }
  return rows
}

/**
 * 列宽：总宽减去列间距后均分。
 * 取整到 0.01，避免 pdfkit 因浮点误差把末列挤到下一行。
 */
function columnWidth(totalW, cols, gap) {
  const n = Math.max(1, Number(cols) || 1)
  const g = Number(gap) || 0
  const w = (Number(totalW) || 0) - g * (n - 1)
  return Math.round((w / n) * 100) / 100
}

/**
 * 按"每页能放几行"切片（用于需要跨页的表格）。
 * 只做几何，不涉及具体内容 —— 与 index.js 的逐行绘制配合。
 */
function paginate(items, perPage) {
  const list = Array.isArray(items) ? items : []
  const n = Math.max(1, Number(perPage) || 1)
  const pages = []
  for (let i = 0; i < list.length; i += n) pages.push(list.slice(i, i + n))
  return pages
}

module.exports = { twoColumnRows, columnWidth, paginate }
