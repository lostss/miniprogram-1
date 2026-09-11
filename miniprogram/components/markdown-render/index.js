// 解析器已下沉 utils/md-parse.js（候选 2：零组件状态、可单测）；本组件只留渲染与交互
const { parseMarkdown } = require('../../utils/md-parse.js')

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
    },
    // 语境变体（2026-09-09）：'report' = 报告页长文阅读语境（正文 30rpx / 段距 16rpx）；
    // 留空为默认档。与 compact 正交——报告页用 variant 而非 compact，避免聊天区字号被连带放大
    variant: {
      type: String,
      value: ''
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
    // catchtouchmove 拦截（全屏表格拖动不穿透宿主页面）
    onNoop() {},
    parseContent(content) {
      if (!content) {
        this.setData({ nodes: [] });
        return;
      }
      // 审计 P1-3（2026-08-30）：v10 已放弃流式，content 每次都是完整文本。
      // 首次渲染（无 pending 且无 timer）立即解析，避免 80ms 首字延迟；
      // 防御性节流保留：同一次渲染内 content 高频变化时合并解析。
      if (!this._pendingContent && !this._parseTimer) {
        this._pendingContent = content
        this._flushParse()
        return
      }
      this._pendingContent = content
      if (this._parseTimer) return
      this._parseTimer = setTimeout(() => this._flushParse(), 80)
    },

    _flushParse() {
      this._parseTimer = null
      // UI 审计 状态 M3：畸形 markdown（不闭合代码块/残缺表格）解析抛错时降级纯文本，防整组件崩溃
      try {
        const nodes = parseMarkdown(this._pendingContent)
        this.setData({ nodes })
      } catch (e) {
        console.error('[markdown-render] 解析失败，降级纯文本:', e)
        this.setData({ nodes: [{ type: 'paragraph', content: [{ type: 'text', content: this._pendingContent }], hasInlineStyles: false }] })
      }
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
  }
})
