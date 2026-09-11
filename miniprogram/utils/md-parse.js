/** md-parse.js — markdown 解析纯模块
 * 候选 2 下沉：自 components/markdown-render/index.js methods 提取（零组件状态依赖）。
 * 手写状态机：代码块 / 表格 / 引用 / 标题 / 有序列表 / 列表(任务) / 分割线 / 段落，
 * 行内：链接(优先) + 加粗 + <br>。全链路无 wx/setData，可被 tests 直接单测。
 */
const { _toFullwidth } = require('./md-inline.js')

// 表格行拆分（组件审计 P1-1）：split('|') 首尾产生空元素（表格语法以 | 开头/结尾），
// 仅去掉首尾空串；中间空单元格保留（filter 删空值会造成列错位）
function splitRow(line) {
  const cells = line.split('|')
  if (cells.length > 0 && cells[0] === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  return cells
}

function _parseBold(text) {
  const parts = []
  let remaining = text
  let match
  while ((match = remaining.match(/\*\*(.+?)\*\*/)) !== null) {
    const before = remaining.slice(0, match.index)
    if (before) parts.push({ type: 'text', content: _toFullwidth(before) })
    parts.push({ type: 'strong', content: _toFullwidth(match[1]) })
    remaining = remaining.slice(match.index + match[0].length)
  }
  if (remaining) parts.push({ type: 'text', content: _toFullwidth(remaining) })
  return parts
}

// 解析行内样式（加粗、换行等）
function parseInlineStyles(text) {
  const segments = text.split('<br>')
  const parts = []

  segments.forEach((segment, index) => {
    let remaining = segment
    let match

    // 链接 [text](url) 优先解析（比加粗优先级高）
    while ((match = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/)) !== null) {
      const matchIndex = match.index
      const before = remaining.slice(0, matchIndex)
      if (before) {
        // 继续解析 before 中的加粗
        const beforeParts = _parseBold(before)
        parts.push(...beforeParts)
      }
      parts.push({ type: 'link', text: _toFullwidth(match[1]), href: match[2] })
      remaining = remaining.slice(matchIndex + match[0].length)
    }

    // 剩余的再解析加粗
    if (remaining) {
      const remainingParts = _parseBold(remaining)
      parts.push(...remainingParts)
    }

    if (index < segments.length - 1) {
      parts.push({ type: 'br' })
    }
  })

  return parts.length > 0 ? parts : [{ type: 'text', content: text }]
}

function parseMarkdown(text) {
  const nodes = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      nodes.push({
        type: 'code',
        lang: lang || 'text',
        content: codeLines.join('\n')
      });
      i++;
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('---')) {
      // 组件审计 P1-1：保留空单元格——split('|') 只产生首尾空元素（表格语法 | 开头/结尾），
      // 去掉首尾即可，中间空单元格必须保留（filter 会删空值导致列错位，违反"保留空单元格"约定）
      const headers = splitRow(line).map(h => h.trim());
      i += 2; // 跳过表头行和分隔行
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) {
        const cells = splitRow(lines[i]).map(c => c.trim());
        if (cells.length > 0) rows.push(cells);
        i++;
      }
      // 解析表格单元格内的加粗样式
      const parsedRows = rows.map(row =>
        row.map(cell => {
          const parsed = parseInlineStyles(cell);
          const hasStyles = parsed.some(p => p.type !== 'text');
          return {
            content: hasStyles ? parsed : parsed[0].content,
            hasInlineStyles: hasStyles
          };
        })
      );
      // 布局决策：1行→卡片重排，多行→横滑表格
      const useCompact = rows.length > 1
      nodes.push({
        type: 'table',
        headers,
        rows,
        parsedRows,
        useCompact
      });
      continue;
    }

    // 引用块
    if (line.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].slice(1).trim());
        i++;
      }
      const quoteText = quoteLines.join('\n');
      nodes.push({
        type: 'quote',
        content: parseInlineStyles(quoteText),
        contentString: quoteText,
        hasInlineStyles: true
      });
      continue;
    }

    // 标题
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      nodes.push({
        type: 'heading',
        level,
        content: headerMatch[2]
      });
      i++;
      continue;
    }

    // 有序列表（含续行：4空格缩进行 / 项间空行都属于当前列表）
    if (line.match(/^\d+\.\s/)) {
      const items = []
      // 2026-09-09：AI 常把列表项说明写成顶格普通行（"若不补充：…" / "📌 优先级：…"），
      // 原实现遇顶格非列表行即 break → 每个条目各自成列表，wxml 的 liIdx+1 让编号全是 1。
      // 现补：非空、非列表项、非其他块级标记的顶格行，且与上一行之间最多隔一个空行 → 视为当前项续行。
      let blankStreak = 0
      while (i < lines.length) {
        const cur = lines[i]
        const isListItem = /^\d+\.\s/.test(cur)
        const isContinuation = items.length > 0 && cur && /^\s{2,}/.test(cur)
        const isEmptyBetweenItems = items.length > 0 && /^\s*$/.test(cur)
        // 仅"紧跟列表项、中间无空行"的顶格行算续行——隔空行的普通段落仍是独立段落（防吞正文）
        const isPlainContinuation = items.length > 0 && !!cur && !isListItem &&
          !/^(#{1,6}\s|[-*]\s|>\s|\||```|={3,}|-{3,})/.test(cur) && blankStreak === 0
        if (!isListItem && !isContinuation && !isEmptyBetweenItems && !isPlainContinuation) break
        if (isEmptyBetweenItems) { blankStreak++; i++; continue }
        if (isListItem) {
          const itemContent = cur.replace(/^\d+\.\s/, '')
          const parsed = parseInlineStyles(itemContent)
          items.push({ content: parsed, hasInlineStyles: parsed.some(p => p.type !== 'text'), subLines: [], hasSubLines: false })
        } else {
          const last = items[items.length - 1]
          if (last) { last.subLines.push(cur.replace(/^\s+/, '')); last.hasSubLines = true }
        }
        blankStreak = 0
        i++
      }
      nodes.push({ type: 'orderedList', items })
      continue
    }

    // 列表（含任务列表和嵌套列表）
    if (line.match(/^[-*]\s/)) {
      const items = [];
      while (i < lines.length) {
        const currentLine = lines[i];
        const listMatch = currentLine.match(/^(\s*)[-*]\s(.*)$/);
        if (!listMatch) break;
        const indent = listMatch[1].length;
        const content = listMatch[2];
        // 任务列表检测
        const taskMatch = content.match(/^\[([ x])\]\s(.*)$/);
        const itemContent = taskMatch ? taskMatch[2] : content;
        // 解析行内加粗
        const parsedContent = parseInlineStyles(itemContent);
        items.push({
          content: parsedContent,
          hasInlineStyles: parsedContent.some(p => p.type !== 'text'),
          checked: taskMatch ? taskMatch[1] === 'x' : null,
          indent: Math.floor(indent / 2)
        });
        i++;
      }
      nodes.push({ type: 'list', items });
      continue;
    }

    // 分割线
    if (line.match(/^-{3,}$/) || line.match(/^\*{3,}$/) || line.match(/^_+$/)) {
      nodes.push({ type: 'hr' });
      i++;
      continue;
    }

    // 普通段落
    if (line.trim()) {
      const paraLines = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('```') && !lines[i].startsWith('>') && !lines[i].includes('|')) {
        paraLines.push(lines[i]);
        i++;
      }
      // 将换行符转换为 <br> 标记
      const content = paraLines.join('<br>');
      // 解析行内加粗和换行
      const parsedContent = parseInlineStyles(content);
      const hasInlineStyles = parsedContent.some(p => p.type !== 'text');
      nodes.push({
        type: 'paragraph',
        content: parsedContent,
        hasInlineStyles: hasInlineStyles
      });
      continue;
    }

    i++;
  }

  return nodes;
}

module.exports = { parseMarkdown, parseInlineStyles, splitRow }
