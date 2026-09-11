// md-parse 纯模块单测（候选 2：自 markdown-render 组件下沉后的可测化）
// 用例锁定原手写状态机的既有行为，防下沉回归
const { parseMarkdown, parseInlineStyles, splitRow } = require('../miniprogram/utils/md-parse')

describe('splitRow 表格行拆分', () => {
  test('去掉首尾空元素、保留中间空单元格', () => {
    expect(splitRow('| a | b |')).toEqual([' a ', ' b '])
    expect(splitRow('| 1 |  | 3 |')).toEqual([' 1 ', '  ', ' 3 '])
  })
})

describe('parseMarkdown 块级解析', () => {
  test('代码块：提取 lang 与内容', () => {
    const nodes = parseMarkdown('```js\nconst a = 1\n```')
    expect(nodes).toEqual([{ type: 'code', lang: 'js', content: 'const a = 1' }])
  })

  test('表格：空单元格保留且列不错位', () => {
    const nodes = parseMarkdown('| 姓名 | 保额 |\n| --- | --- |\n| 小明 |  |')
    expect(nodes).toHaveLength(1)
    const t = nodes[0]
    expect(t.type).toBe('table')
    expect(t.headers).toEqual(['姓名', '保额'])
    expect(t.rows).toEqual([['小明', '']])
    expect(t.parsedRows[0][1].content).toBe('') // 空单元格以 text '' 保留
  })

  test('引用块', () => {
    const nodes = parseMarkdown('> 配置提醒')
    expect(nodes[0].type).toBe('quote')
    expect(nodes[0].contentString).toBe('配置提醒')
  })

  test('标题分级', () => {
    const nodes = parseMarkdown('## 家庭档案')
    expect(nodes[0]).toEqual({ type: 'heading', level: 2, content: '家庭档案' })
  })

  test('有序列表：含续行归属', () => {
    const nodes = parseMarkdown('1. 第一步\n   续行内容\n2. 第二步')
    expect(nodes).toHaveLength(1)
    const items = nodes[0].items
    expect(items).toHaveLength(2)
    expect(items[0].subLines).toEqual(['续行内容'])
    expect(items[0].hasSubLines).toBe(true)
  })

  test('任务列表：checked 标记', () => {
    const nodes = parseMarkdown('- [x] 已办\n- [ ] 待办')
    expect(nodes[0].type).toBe('list')
    expect(nodes[0].items.map(i => i.checked)).toEqual([true, false])
    expect(nodes[0].items[0].content[0].content).toBe('已办')
  })

  test('分割线', () => {
    expect(parseMarkdown('---')[0].type).toBe('hr')
    expect(parseMarkdown('___')[0].type).toBe('hr')
  })

  test('段落合并：跨行转 <br> + 加粗解析', () => {
    const nodes = parseMarkdown('第一行\n第二行')
    expect(nodes[0].type).toBe('paragraph')
    const segs = nodes[0].content.filter(p => p.type === 'text').map(p => p.content)
    expect(segs).toContain('第一行')
    expect(segs).toContain('第二行')
    const hasBr = nodes[0].content.some(p => p.type === 'br')
    expect(hasBr).toBe(true)
  })

  test('畸形输入不抛错：未闭合代码块吞到行尾', () => {
    const nodes = parseMarkdown('```js\nconst x = 1')
    expect(nodes[0].type).toBe('code')
    expect(nodes[0].content).toBe('const x = 1')
  })
})

// 2026-09-09：AI 把列表项说明写成顶格行（"若不补充：…"/"📌 优先级：…"），
// 原实现遇顶格非列表行即终止 → 每项各自成列表，渲染编号全是 1
describe('有序列表顶格续行合并', () => {
  test('紧跟列表项的顶格说明行归入该项，编号保持连续', () => {
    const md = [
      '1. 确认保单状态 — 描述',
      '若不确认：住院费用将无法报销。',
      '📌 优先级：高',
      '',
      '2. 补充医疗险 — 描述',
      '若不补充：治疗费需自付。'
    ].join('\n')
    const nodes = parseMarkdown(md)
    const ol = nodes.find(n => n.type === 'orderedList')
    expect(ol).toBeDefined()
    expect(ol.items.length).toBe(2)
    expect(ol.items[0].subLines.length).toBe(2)
    expect(ol.items[1].subLines.length).toBe(1)
  })

  test('隔空行的普通段落不被吞入列表', () => {
    const md = ['1. 第一项', '', '这是一段独立说明文字。'].join('\n')
    const nodes = parseMarkdown(md)
    const ol = nodes.find(n => n.type === 'orderedList')
    expect(ol.items.length).toBe(1)
    expect(ol.items[0].subLines.length).toBe(0)
    expect(nodes.some(n => n.type === 'paragraph')).toBe(true)
  })

  test('块级标记（引用/表格/分割线）仍终止列表', () => {
    const md = ['1. 第一项', '> 引用', '', '---'].join('\n')
    const nodes = parseMarkdown(md)
    const ol = nodes.find(n => n.type === 'orderedList')
    expect(ol.items.length).toBe(1)
    expect(ol.items[0].subLines.length).toBe(0)
  })
})

describe('parseInlineStyles 行内解析', () => {
  test('加粗', () => {
    const parts = parseInlineStyles('买**重疾**险')
    expect(parts).toEqual([
      { type: 'text', content: '买' },
      { type: 'strong', content: '重疾' },
      { type: 'text', content: '险' }
    ])
  })

  test('链接优先于加粗（文本顺序忠实原解析器）', () => {
    const parts = parseInlineStyles('**[a](https://x)**')
    expect(parts[0]).toEqual({ type: 'text', content: '**' })
    expect(parts[1]).toEqual({ type: 'link', text: 'a', href: 'https://x' })
    expect(parts[2]).toEqual({ type: 'text', content: '**' })
  })

  test('全角标点转换：英文句点在不跟随字母/数字时转中文句号', () => {
    const parts = parseInlineStyles('费率 3.5% / 医疗险. 健康')
    const text = parts.map(p => p.content).join('')
    expect(text).toContain('医疗险。')
    expect(text).toContain('3.5%') // 版本号/小数中的点不被转换
  })
})
