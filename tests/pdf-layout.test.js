/**
 * PDF 版式纯函数（2026-10-22）
 *
 * PDF 是 canvas 逐行绘制，"排版对不对"只能在纸上验证。所以把可计算的几何抽出来单测：
 * 列宽、双列配对、分页切片。这样"两列并排"至少不会出现"右列溢出到页边"这种可计算错误。
 */
const { twoColumnRows, columnWidth, paginate } = require('../cloudfunctions/reportPdf/layout')

describe('twoColumnRows', () => {
  test('偶数个：两两成对', () => {
    expect(twoColumnRows(['a', 'b', 'c', 'd'])).toEqual([
      { left: 'a', right: 'b' }, { left: 'c', right: 'd' }
    ])
  })

  test('奇数个：最后一行右列为 null（渲染时不留空洞）', () => {
    expect(twoColumnRows(['a', 'b', 'c'])).toEqual([
      { left: 'a', right: 'b' }, { left: 'c', right: null }
    ])
  })

  test('空/非数组不崩', () => {
    expect(twoColumnRows([])).toEqual([])
    expect(twoColumnRows(null)).toEqual([])
  })
})

describe('columnWidth', () => {
  test('两列：总宽减一个列间距后均分（A4 可用宽 491.28）', () => {
    expect(columnWidth(491.28, 2, 16)).toBe(237.64)
  })

  test('单列：等于总宽（不减去不存在的间距）', () => {
    expect(columnWidth(491.28, 1, 16)).toBe(491.28)
  })

  test('三列：减两个间距', () => {
    expect(columnWidth(300, 3, 10)).toBe(93.33)
  })

  test('异常入参兜底（0 列按 1 列算，避免除零）', () => {
    expect(columnWidth(100, 0, 10)).toBe(100)
  })
})

describe('paginate', () => {
  test('按每页条数切片，末页可不满', () => {
    expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  test('perPage 非法时按 1 处理（不产生空页）', () => {
    expect(paginate([1, 2], 0)).toEqual([[1], [2]])
  })
})
