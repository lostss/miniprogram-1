const { _toFullwidth } = require('../../utils/md-inline.js')

Component({
  properties: {
    content: {
      type: String,
      value: '',
      observer: 'parseContent'
    },
    // 紧凑模式：用于聊天气泡等窄容器，缩小字号与留白
    compact: {
      type: Boolean,
      value: false
    }
  },

  data: {
    nodes: [],
    fullscreenTable: null,
    isLandscape: false
  },

  lifetimes: {
    detached() {
      if (this._parseTimer) { clearTimeout(this._parseTimer); this._parseTimer = null }
    }
  },

  methods: {
    parseContent(content) {
      if (!content) {
        this.setData({ nodes: [] });
        return;
      }
      // 节流：流式渲染场景下 content 高频变化，合并 80ms 内的多次解析
      // 避免每次 onText 都重新解析整段 markdown 导致卡顿
      this._pendingContent = content
      if (this._parseTimer) return
      this._parseTimer = setTimeout(() => {
        this._parseTimer = null
        const nodes = this.parseMarkdown(this._pendingContent)
        this.setData({ nodes })
      }, 80)
    },

    parseMarkdown(text) {
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
          const headers = line.split('|').map(h => h.trim()).filter(h => h);
          i += 2; // 跳过表头行和分隔行
          const rows = [];
          while (i < lines.length && lines[i].includes('|')) {
            const cells = lines[i].split('|').map(c => c.trim()).filter(c => c);
            if (cells.length > 0) rows.push(cells);
            i++;
          }
          // 解析表格单元格内的加粗样式
          const parsedRows = rows.map(row => 
            row.map(cell => {
              const parsed = this.parseInlineStyles(cell);
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
            content: this.parseInlineStyles(quoteText),
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
          while (i < lines.length) {
            const cur = lines[i]
            const isListItem = /^\d+\.\s/.test(cur)
            const isContinuation = items.length > 0 && cur && /^\s{2,}/.test(cur)
            const isEmptyBetweenItems = items.length > 0 && /^\s*$/.test(cur)
            if (!isListItem && !isContinuation && !isEmptyBetweenItems) break
            if (isEmptyBetweenItems) { i++; continue }
            if (isListItem) {
              const itemContent = cur.replace(/^\d+\.\s/, '')
              const parsed = this.parseInlineStyles(itemContent)
              items.push({ content: parsed, hasInlineStyles: parsed.some(p => p.type !== 'text'), subLines: [], hasSubLines: false })
            } else if (isContinuation) {
              const last = items[items.length - 1]
              if (last) { last.subLines.push(cur.replace(/^\s+/, '')); last.hasSubLines = true }
            }
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
            const parsedContent = this.parseInlineStyles(itemContent);
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
          const parsedContent = this.parseInlineStyles(content);
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
    },

    // 复制代码
    copyCode(e) {
      const content = e.currentTarget.dataset.content;
      wx.setClipboardData({
        data: content,
        success: () => { wx.showToast({ title: '已复制', icon: 'success' }) },
        fail: () => { wx.showToast({ title: '复制失败', icon: 'none' }) }
      });
    },

    // 复制表格
    copyTable(e) {
      const table = e.currentTarget.dataset.table;
      let content = table.headers.join('\t') + '\n';
      table.rows.forEach(row => {
        content += row.join('\t') + '\n';
      });
      wx.setClipboardData({
        data: content,
        success: () => {
          wx.showToast({ title: '表格已复制', icon: 'success' });
        }
      });
    },

    // 全屏展开表格
    expandTable(e) {
      const table = e.currentTarget.dataset.table;
      this.setData({ fullscreenTable: table });
    },

    // 关闭全屏时恢复竖屏
    closeFullscreenTable() {
      this.setData({ fullscreenTable: null });
    },

    // 阻止事件冒泡
    preventClose() {
      // 什么都不做，只是阻止冒泡
    },

    // 复制全屏表格
    copyFullscreenTable() {
      const table = this.data.fullscreenTable;
      if (!table) return;

      let content = table.headers.join('\t') + '\n';
      table.rows.forEach(row => {
        content += row.join('\t') + '\n';
      });

      wx.setClipboardData({
        data: content,
        success: () => { wx.showToast({ title: '表格已复制', icon: 'success' }) },
        fail: () => { wx.showToast({ title: '复制失败', icon: 'none' }) }
      });
    },

    // 复制引用块
    copyQuote(e) {
      const content = e.currentTarget.dataset.content;
      wx.setClipboardData({
        data: content,
        success: () => { wx.showToast({ title: '话术已复制', icon: 'success' }) },
        fail: () => { wx.showToast({ title: '复制失败', icon: 'none' }) }
      });
    },

    onLinkTap(e) {
      const href = e.currentTarget.dataset.href
      if (href) {
        this.triggerEvent('linkTap', { href })
      }
    },

    // 解析行内样式（加粗、换行等）
    parseInlineStyles(text) {
      const segments = text.split('<br>');
      const parts = [];
      
      segments.forEach((segment, index) => {
        let remaining = segment;
        let match;
        
        // 链接 [text](url) 优先解析（比加粗优先级高）
        while ((match = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/)) !== null) {
          const matchIndex = match.index;
          const before = remaining.slice(0, matchIndex);
          if (before) {
            // 继续解析 before 中的加粗
            const beforeParts = this._parseBold(before);
            parts.push(...beforeParts);
          }
          parts.push({ type: 'link', text: _toFullwidth(match[1]), href: match[2] });
          remaining = remaining.slice(matchIndex + match[0].length);
        }
        
        // 剩余的再解析加粗
        if (remaining) {
          const remainingParts = this._parseBold(remaining);
          parts.push(...remainingParts);
        }
        
        if (index < segments.length - 1) {
          parts.push({ type: 'br' });
        }
      });
      
      return parts.length > 0 ? parts : [{ type: 'text', content: text }];
    },
    
    _parseBold(text) {
      const parts = [];
      let remaining = text;
      let match;
      while ((match = remaining.match(/\*\*(.+?)\*\*/)) !== null) {
        const before = remaining.slice(0, match.index);
        if (before) parts.push({ type: 'text', content: _toFullwidth(before) });
        parts.push({ type: 'strong', content: _toFullwidth(match[1]) });
        remaining = remaining.slice(match.index + match[0].length);
      }
      if (remaining) parts.push({ type: 'text', content: _toFullwidth(remaining) });
      return parts;
    }
  }
});
