/**
 * 全组件方法引用完整性（防孤儿调用）
 * 对 miniprogram/components 下每个组件的 index.js：
 *   mock Component 捕获配置 → 扫描方法内部 this.xxx( 调用 → 与 methods + 实例字段 + data/properties 顶层键 + 内建方法做差集
 * 拦截 _procRefresh 类重构回归（方法定义丢失但调用点残留）
 */

const path = require('path')
const fs = require('fs')

const COMPONENT_DIR = path.join(__dirname, '..', 'miniprogram', 'components')

function collectComponents() {
  return fs.readdirSync(COMPONENT_DIR).filter(function (d) {
    return fs.existsSync(path.join(COMPONENT_DIR, d, 'index.js'))
  })
}

// 小程序内建方法（不在 methods 中定义）
const BUILTIN = new Set(['triggerEvent', 'setData', 'selectComponent', 'getOpenerEventChannel', 'createSelectorQuery', 'createIntersectionObserver'])

function checkIntegrity(cfg) {
  const names = Object.keys(cfg.methods || {})
  const defined = new Set(names)
  // 实例字段：任意方法中 this.xxx = 的赋值（回调句柄等，非方法）
  const fields = new Set()
  names.forEach(function (name) {
    const src = cfg.methods[name].toString()
    const fRe = /this\.([A-Za-z_$][\w$]*)\s*=/g
    let fm
    while ((fm = fRe.exec(src))) fields.add(fm[1])
  })
  // data/properties 顶层键（this.data.xxx / this.properties.xxx 之外的字段引用）
  Object.keys(cfg.data || {}).forEach(function (k) { defined.add(k) })
  Object.keys(cfg.properties || {}).forEach(function (k) { defined.add(k) })

  const missing = []
  names.forEach(function (name) {
    const src = cfg.methods[name].toString()
    const re = /this\.([A-Za-z_$][\w$]*)\s*\(/g
    let m
    while ((m = re.exec(src))) {
      const callee = m[1]
      if (defined.has(callee) || fields.has(callee) || BUILTIN.has(callee)) continue
      if (!missing.some(function (x) { return x.name === name && x.callee === callee })) {
        missing.push({ name: name, callee: callee })
      }
    }
  })
  return missing
}

describe('全组件方法引用完整性（防孤儿调用）', function () {
  const dirs = collectComponents()
  expect(dirs.length).toBeGreaterThan(0)

  dirs.forEach(function (dir) {
    test(dir + '：组件方法内部 this.xxx( 调用均有定义', function () {
      let captured = null
      global.Component = function (cfg) { captured = cfg }
      global.wx = {
        getStorageSync: function () { return null },
        setStorageSync: function () {},
        removeStorageSync: function () {},
        showModal: function () {},
        showToast: function () {},
        cloud: { callFunction: function () {} }
      }
      jest.resetModules()
      const resolved = path.join(COMPONENT_DIR, dir, 'index.js')
      require(resolved)
      expect(captured).not.toBeNull()
      expect(checkIntegrity(captured)).toEqual([])
    })
  })
})
