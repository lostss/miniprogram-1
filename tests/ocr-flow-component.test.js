/**
 * ocr-flow 组件测试
 * 1. 方法引用完整性：组件方法内部 this.xxx( 调用必须有定义
 *    （拦截 _procRefresh 类孤儿调用——R2 收编 classifyBatchResults 时方法定义丢失，
 *      7 处调用点抛 TypeError，恢复弹窗点"继续处理"后无界面指引）
 * 2. checkResume 恢复路径：有 ocrBatch 存储时点击"继续处理"应恢复渲染确认卡（回归正常处理 UI）
 */

let captured = null
let wxMock = {}

function loadComponent() {
  captured = null
  global.Component = function (cfg) { captured = cfg }
  wxMock = {
    getStorageSync: jest.fn(function () { return null }),
    setStorageSync: jest.fn(),
    removeStorageSync: jest.fn(),
    showModal: jest.fn(),
    cloud: { callFunction: jest.fn() }
  }
  global.wx = wxMock
  jest.resetModules()
  require('../miniprogram/components/ocr-flow/index.js')
  return captured
}

// 支持 'a.b.c' 路径的 setData
function setByPath(obj, path, value) {
  var segs = path.split('.')
  var cur = obj
  for (var i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] == null) cur[segs[i]] = {}
    cur = cur[segs[i]]
  }
  cur[segs[segs.length - 1]] = value
}

function makeInstance(cfg, overrides) {
  var inst = {}
  Object.keys(cfg.methods).forEach(function (k) { inst[k] = cfg.methods[k] })
  inst.data = JSON.parse(JSON.stringify(cfg.data))
  inst.properties = Object.assign({ familyId: '', skipMatch: false }, overrides && overrides.properties)
  inst.setData = function (patch) {
    Object.keys(patch).forEach(function (k) { setByPath(inst.data, k, patch[k]) })
  }
  inst.triggerEvent = jest.fn()
  inst._disposed = false
  inst._ocrBusy = false
  return inst
}

describe('ocr-flow 组件：方法引用完整性（防孤儿调用）', function () {
  const cfg = loadComponent()

  test('组件方法内部 this.xxx( 调用均有定义', function () {
    const names = Object.keys(cfg.methods)
    const defined = new Set(names)
    // 实例字段：任意方法中 this.xxx = 的赋值（回调句柄等，非方法）
    const fields = new Set()
    names.forEach(function (name) {
      const src = cfg.methods[name].toString()
      const fRe = /this\.([A-Za-z_$][\w$]*)\s*=/g
      let fm
      while ((fm = fRe.exec(src))) fields.add(fm[1])
    })
    // 小程序内建方法（不在 methods 中定义）
    const builtin = new Set(['triggerEvent', 'setData', 'selectComponent', 'getOpenerEventChannel', 'createSelectorQuery', 'createIntersectionObserver'])
    const missing = []
    names.forEach(function (name) {
      const src = cfg.methods[name].toString()
      const re = /this\.([A-Za-z_$][\w$]*)\s*\(/g
      let m
      while ((m = re.exec(src))) {
        const callee = m[1]
        if (defined.has(callee) || fields.has(callee) || builtin.has(callee)) continue
        if (!missing.some(function (x) { return x.name === name && x.callee === callee })) {
          missing.push({ name: name, callee: callee })
        }
      }
    })
    expect(missing).toEqual([])
  })
})

describe('ocr-flow 组件：checkResume 恢复路径', function () {
  test('有 ocrBatch 时弹窗，点"继续处理"→ 恢复渲染确认卡（回归正常处理 UI）', function () {
    jest.useFakeTimers()
    try {
      const cfg = loadComponent()
      const stored = {
        policies: [{ product_name: '康宁', insurance_category: '重疾', auto_confirmed: false }],
        cashValues: [],
        errors: [{ fileId: 'f1', thumb: 't.jpg', error: '识别失败' }],
        // 存储审计 P0：TTL 校验，测试 mock 需带 savedAt 否则被 12h 拦截
        savedAt: Date.now()
      }
      wxMock.getStorageSync.mockReturnValue(stored)
      const inst = makeInstance(cfg)

      inst.checkResume()

      // 弹窗提示存在
      expect(wxMock.showModal).toHaveBeenCalled()
      const modalOpts = wxMock.showModal.mock.calls[0][0]
      expect(modalOpts.confirmText).toBe('继续处理')

      // 模拟点击"继续处理"：延迟渲染（等弹窗关闭动画），推进定时器后卡片出现
      modalOpts.success({ confirm: true, cancel: false })
      expect(inst.data.ocrMask.phase).not.toBe('done') // 尚未渲染（等 300ms）
      jest.advanceTimersByTime(300)

      // 界面回到正常处理态（done 阶段 + 确认卡分组）
      expect(inst.data.ocrMask.phase).toBe('done')
      expect(inst.data.ocrMask.visible).toBe(true)
      expect(inst.data.ocrMask.procReview.length).toBe(1)
      expect(inst.data.ocrMask.procError.length).toBe(1)
      // 恢复结果已持久化（重进可继续）
      expect(wxMock.setStorageSync).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test('无 ocrBatch 时不弹窗', function () {
    const cfg = loadComponent()
    wxMock.getStorageSync.mockReturnValue(null)
    const inst = makeInstance(cfg)
    inst.checkResume()
    expect(wxMock.showModal).not.toHaveBeenCalled()
  })

  test('点"放弃"→ 清空 batch', function () {
    const cfg = loadComponent()
    wxMock.getStorageSync.mockReturnValue({ policies: [{ product_name: 'x' }], cashValues: [], errors: [], savedAt: Date.now() })
    const inst = makeInstance(cfg)
    inst.checkResume()
    const modalOpts = wxMock.showModal.mock.calls[0][0]
    modalOpts.success({ confirm: false, cancel: true })
    expect(wxMock.removeStorageSync).toHaveBeenCalledWith('ocrBatch')
  })
})

describe('ocr-flow 组件：_startOCR 全部失败统一进列表', function () {
  test('全部失败（含 not_policy）不再弹 modal，直接进入 done 列表，错误组可渲染', async function () {
    const cfg = loadComponent()
    const flowMod = require('../miniprogram/utils/ocr-flow')
    jest.spyOn(flowMod, 'compressAndUpload').mockResolvedValue({ fileIds: ['cloud://f1'], localPaths: ['/tmp/a.jpg'] })
    jest.spyOn(flowMod, 'batchOCR').mockResolvedValue({ policies: [], cashValues: [], errors: [{ error: '当前图片未识别到保单信息', error_code: 'not_policy', fileId: 'cloud://f1' }] })
    jest.spyOn(flowMod, 'cleanupTempFiles').mockImplementation(function () {})
    jest.spyOn(flowMod, 'rememberFailedFiles').mockImplementation(function () {})

    const inst = makeInstance(cfg)
    await inst._startOCR(['/tmp/a.jpg'])

    // 方案 B：不弹 modal，统一进 done 列表
    expect(wxMock.showModal).not.toHaveBeenCalled()
    expect(inst.data.ocrMask.phase).toBe('done')
    expect(inst.data.ocrMask.visible).toBe(true)
    // 错误组渲染：not_policy 卡含具体文案（errorLabel → errorToUI.title）
    expect(inst.data.ocrMask.procError.length).toBe(1)
    expect(inst.data.ocrMask.procError[0].fileId).toBe('cloud://f1')
    expect(inst.data.ocrMask.procError[0].error).toContain('非保单图片')
    // 失败后 busy 已重置（可再次上传/操作）
    expect(inst._ocrBusy).toBe(false)
  })

  test('全部失败（非 not_policy 错误码）同样直接进列表，无 modal', async function () {
    const cfg = loadComponent()
    const flowMod = require('../miniprogram/utils/ocr-flow')
    jest.spyOn(flowMod, 'compressAndUpload').mockResolvedValue({ fileIds: ['cloud://f1'], localPaths: ['/tmp/a.jpg'] })
    jest.spyOn(flowMod, 'batchOCR').mockResolvedValue({ policies: [], cashValues: [], errors: [{ error: 'AI提取失败', error_code: 'ai_extract_failed', fileId: 'cloud://f1' }] })
    jest.spyOn(flowMod, 'cleanupTempFiles').mockImplementation(function () {})
    jest.spyOn(flowMod, 'rememberFailedFiles').mockImplementation(function () {})

    const inst = makeInstance(cfg)
    await inst._startOCR(['/tmp/a.jpg'])

    expect(wxMock.showModal).not.toHaveBeenCalled()
    expect(inst.data.ocrMask.phase).toBe('done')
    expect(inst.data.ocrMask.procError.length).toBe(1)
  })
})
