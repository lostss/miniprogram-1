/**
 * WXML 绑定完整性（静态层，拦截 Bug 1/2 形态）
 * 对 pages 目录与 components 目录下各 index：
 *   提取 WXML 中 bind/catch 事件的处理器名 → 与页面/组件 JS 方法名差集
 * 正向：WXML 绑定的处理器必须在 JS 中存在（防绑定拼错/绑定到已删方法 → 点击报错或静默失效）
 */

const path = require('path')
const fs = require('fs')

const MINIPROGRAM = path.join(__dirname, '..', 'miniprogram')

// WXML 事件绑定提取：bindtap="x" / catchtap="x" / bind:linkTap="x" / catchtouchmove="x" / bindinput="x"
function collectHandlers(wxml) {
  const re = /(?:bind|catch)(?::?[a-zA-Z]+)?="([a-zA-Z_$][\w$]*)"/g
  const handlers = new Set()
  let m
  while ((m = re.exec(wxml))) handlers.add(m[1])
  return handlers
}

function collectUnits() {
  const units = []
  const pagesDir = path.join(MINIPROGRAM, 'pages')
  fs.readdirSync(pagesDir).forEach(function (d) {
    const base = path.join(pagesDir, d, 'index')
    if (fs.existsSync(base + '.wxml') && fs.existsSync(base + '.js')) units.push({ kind: 'page', dir: d })
  })
  const compDir = path.join(MINIPROGRAM, 'components')
  fs.readdirSync(compDir).forEach(function (d) {
    const base = path.join(compDir, d, 'index')
    if (fs.existsSync(base + '.wxml') && fs.existsSync(base + '.js')) units.push({ kind: 'component', dir: d })
  })
  return units
}

// 最近一次捕获的方法对象（页面顶层键 / 组件 methods），供内部调用分析复用
let lastMethods = {}

// 加载 JS 并 mock Page/Component 捕获方法集合
function loadMethods(unit) {
  let captured = null
  global.Page = function (cfg) { captured = cfg }
  global.Component = function (cfg) { captured = cfg }
  global.wx = {
    getStorageSync: function () { return null }, setStorageSync: function () {}, removeStorageSync: function () {},
    showModal: function () {}, showToast: function () {}, showLoading: function () {}, hideLoading: function () {},
    cloud: { callFunction: function () {} }, getSystemInfoSync: function () { return {} },
    setClipboardData: function () {}, previewImage: function () {}, stopPullDownRefresh: function () {}
  }
  jest.resetModules()
  const resolved = path.join(MINIPROGRAM, unit.kind + 's', unit.dir, 'index.js')
  require(resolved)
  expect(captured).not.toBeNull()
  if (unit.kind === 'component') {
    lastMethods = captured.methods || {}
    return Object.keys(lastMethods)
  }
  // 页面：顶层键排除 data/生命周期/配置
  const LIFECYCLE = new Set(['data', 'onLoad', 'onShow', 'onUnload', 'onReady', 'onPullDownRefresh', 'onReachBottom', 'onShareAppMessage', 'onShareTimeline', 'onBackPress', 'onPageScroll'])
  lastMethods = {}
  Object.keys(captured).forEach(function (k) { if (!LIFECYCLE.has(k)) lastMethods[k] = captured[k] })
  return Object.keys(lastMethods)
}

describe('WXML 绑定完整性（处理器必须存在）', function () {
  const units = collectUnits()
  expect(units.length).toBeGreaterThan(0)

  units.forEach(function (unit) {
    test(unit.kind + '/' + unit.dir + '：WXML 绑定的处理器均有方法定义', function () {
      const wxml = fs.readFileSync(path.join(MINIPROGRAM, unit.kind + 's', unit.dir, 'index.wxml'), 'utf8')
      const handlers = collectHandlers(wxml)
      const methods = loadMethods(unit)
      const missing = []
      handlers.forEach(function (h) {
        if (methods.indexOf(h) === -1) missing.push(h)
      })
      expect(missing).toEqual([])
    })
  })
})

describe('WXML 反向绑定完整性（onXxx 事件处理器未被漏绑）', function () {
  // 死方法白名单（已核实无绑定无调用，待清理，勿误报）：
  //   chat-panel: FAB 输入框已迁移到 report 页，onFabTap/onFocus/onInput 为历史残留
  //   edit-sheet: onNoop 为无绑定占位空方法
  const WHITELIST = {
    'chat-panel': ['onFabTap', 'onFocus', 'onInput'],
    'edit-sheet': ['onNoop'],
    // UI 审计 交互 S1：onBackPressed 为组件公共方法，由宿主页 onBackPress 委托调用（跨组件，本检测不识别）
    'ocr-flow': ['onBackPressed']
  }

  const units = collectUnits()

  units.forEach(function (unit) {
    test(unit.kind + '/' + unit.dir + '：无孤儿 onXxx 事件处理器（拦截 Bug 1/2 漏绑形态）', function () {
      const wxml = fs.readFileSync(path.join(MINIPROGRAM, unit.kind + 's', unit.dir, 'index.wxml'), 'utf8')
      const handlers = collectHandlers(wxml)
      const methods = loadMethods(unit)

      // 方法源码中 this.onXxx( 的内部调用 → 非孤儿
      const internallyCalled = new Set()
      methods.forEach(function (m) {
        const src = lastMethods[m].toString()
        const re = /this\.(on[A-Z][\w$]*)\s*\(/g
        let mm
        while ((mm = re.exec(src))) internallyCalled.add(mm[1])
      })

      const whitelist = WHITELIST[unit.dir] || []
      const unbound = methods.filter(function (m) {
        if (!/^on[A-Z]/.test(m)) return false
        if (handlers.has(m)) return false
        if (internallyCalled.has(m)) return false
        if (whitelist.indexOf(m) !== -1) return false
        return true
      })
      expect(unbound).toEqual([])
    })
  })
})
