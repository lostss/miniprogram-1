/**
 * ocr-flow 点击行为矩阵（动态层）
 * 对关键交互方法：构造假事件 → 调用 → 断言 setData / showModal 分支 / triggerEvent / 状态标志
 * 覆盖：匹配弹窗、角色卡、放弃/确认、保存态、保存失败重试
 *
 * 2026-10-13 产品决策（识别结果弹窗只留「取消 / 保存」，编辑后移到报告）随之删除的用例：
 *   - 编辑 sheet 整组（onEditCard / onEditSheetSave ×2 / onEditSheetClose）
 *   - onProcPreview（点缩略图看大图）、onProcManualAdd（失败项手动录入）
 *   - 重试路径整组（onProcRetryOne ×3 / onProcRetryAll ×2）
 * 这些方法已从组件删除 → 用例保留只会变成"测不存在的东西"（原 11 条失败即此）。
 * 保留 onFailedRetry：保存失败重试仍是弹窗内的出口。
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
    showToast: jest.fn(),
    previewImage: jest.fn(),
    setClipboardData: jest.fn(),
    nextTick: function (cb) { cb && cb() },
    cloud: { callFunction: jest.fn() }
  }
  global.wx = wxMock
  jest.resetModules()
  require('../miniprogram/components/ocr-flow/index.js')
  return captured
}

// 支持 'a.b[0].c' 路径（模拟小程序 setData 的数组索引语法）
function setByPath(obj, path, value) {
  var segs = path.split('.')
  var cur = obj
  for (var i = 0; i < segs.length - 1; i++) {
    var seg = segs[i]
    var m = /^(\w+)\[(\d+)\]$/.exec(seg)
    if (m) {
      if (cur[m[1]] == null) cur[m[1]] = []
      if (cur[m[1]][parseInt(m[2])] == null) cur[m[1]][parseInt(m[2])] = {}
      cur = cur[m[1]][parseInt(m[2])]
    } else {
      if (cur[seg] == null) cur[seg] = {}
      cur = cur[seg]
    }
  }
  var last = segs[segs.length - 1]
  var lm = /^(\w+)\[(\d+)\]$/.exec(last)
  if (lm) {
    if (cur[lm[1]] == null) cur[lm[1]] = []
    cur[lm[1]][parseInt(lm[2])] = value
  } else cur[last] = value
}

function makeInstance(cfg) {
  var inst = {}
  Object.keys(cfg.methods).forEach(function (k) { inst[k] = cfg.methods[k] })
  inst.data = JSON.parse(JSON.stringify(cfg.data))
  inst.properties = { familyId: '', skipMatch: false }
  inst.setData = function (patch) {
    Object.keys(patch).forEach(function (k) { setByPath(inst.data, k, patch[k]) })
  }
  inst.triggerEvent = jest.fn()
  inst._disposed = false
  inst._ocrBusy = false
  return inst
}

describe('ocr-flow 点击矩阵：匹配弹窗', function () {
  test('onMatchPick：更新选中家庭', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst.onMatchPick({ currentTarget: { dataset: { pick: 'fam_2' } } })
    expect(inst.data.ocrMask.matchPick).toBe('fam_2')
  })

  test('onMatchNext：无选中 → toast 提示', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst.onMatchNext()
    expect(wxMock.showToast).toHaveBeenCalled()
  })

  test('onMatchNext：有选中 → resolve(pick) 并清句柄', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    const resolve = jest.fn()
    inst._matchResolve = resolve
    inst.setData({ 'ocrMask.matchPick': 'fam_1' })
    inst.onMatchNext()
    expect(resolve).toHaveBeenCalledWith('fam_1')
    expect(inst._matchResolve).toBeNull()
  })

  test('onMatchPrev：resolve(null)', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    const resolve = jest.fn()
    inst._matchResolve = resolve
    inst.onMatchPrev()
    expect(resolve).toHaveBeenCalledWith(null)
    expect(inst._matchResolve).toBeNull()
  })
})

describe('ocr-flow 点击矩阵：角色卡', function () {
  test('onRolePick：无冲突 → 直接写入角色', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst.setData({ 'ocrMask.roleList': [{ name: '张三', role: '' }] })
    inst.onRolePick({ currentTarget: { dataset: { idx: 0, role: '本人' } } })
    expect(inst.data.ocrMask.roleList[0].role).toBe('本人')
    expect(wxMock.showModal).not.toHaveBeenCalled()
  })

  test('onRolePick：冲突 → 弹占用确认窗', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst._roleOccupied = { '本人': { name: '李四' } }
    // roleList 由 _applyRoleState 生成（带 conflict）
    inst.setData({ 'ocrMask.roleList': [{ name: '张三', role: '', conflict: { '本人': '李四' } }] })
    inst.onRolePick({ currentTarget: { dataset: { idx: 0, role: '本人' } } })
    expect(wxMock.showModal).toHaveBeenCalled()
    const opts = wxMock.showModal.mock.calls[0][0]
    expect(opts.confirmText).toBeTruthy()
    // 确认替换 → 写回角色
    opts.success({ confirm: true })
    expect(inst.data.ocrMask.roleList[0].role).toBe('本人')
  })

  test('onRoleConfirm / onRolePrev：resolve 并清句柄', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    const resolve = jest.fn()
    inst._roleResolve = resolve
    inst.setData({ 'ocrMask.roleList': [{ name: '张三', role: '本人' }] })
    inst.onRoleConfirm()
    expect(resolve).toHaveBeenCalled()
    expect(inst._roleResolve).toBeNull()

    const resolve2 = jest.fn()
    inst._roleResolve = resolve2
    inst.onRolePrev()
    expect(resolve2).toHaveBeenCalledWith(null)
    expect(inst._roleResolve).toBeNull()
  })
})

describe('ocr-flow 点击矩阵：放弃 / 确认 / 保存态', function () {
  test('onProcDiscardAll：确认 → 清空 + 触发 discarded；取消 → 无副作用', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst._procPolicies = [{ product_name: 'x' }]
    inst.onProcDiscardAll()
    expect(wxMock.showModal).toHaveBeenCalled()
    let opts = wxMock.showModal.mock.calls[0][0]
    opts.success({ confirm: false, cancel: true })
    expect(inst.triggerEvent).not.toHaveBeenCalledWith('discarded')

    inst.onProcDiscardAll()
    opts = wxMock.showModal.mock.calls[1][0]
    opts.success({ confirm: true, cancel: false })
    expect(inst.triggerEvent).toHaveBeenCalledWith('discarded')
    expect(inst._procPolicies.length).toBe(0)
    expect(inst.data.ocrMask.visible).toBe(false)
  })

  test('onProcConfirm：无异常/待核对 → 直接 _doSave', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    const spy = jest.spyOn(inst, '_doSave').mockResolvedValue()
    inst.setData({ 'ocrMask.procReview': [], 'ocrMask.procError': [] })
    inst.onProcConfirm()
    expect(spy).toHaveBeenCalled()
    expect(wxMock.showModal).not.toHaveBeenCalled()
  })

  test('onProcConfirm：有待核对 → 弹窗确认后 _doSave，取消则不保存', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    const spy = jest.spyOn(inst, '_doSave').mockResolvedValue()
    inst.setData({ 'ocrMask.procReview': [{ fileId: 'f1' }], 'ocrMask.procError': [] })
    inst.onProcConfirm()
    expect(wxMock.showModal).toHaveBeenCalled()
    let opts = wxMock.showModal.mock.calls[0][0]
    opts.success({ confirm: false, cancel: true })
    expect(spy).not.toHaveBeenCalled()

    inst.onProcConfirm()
    opts = wxMock.showModal.mock.calls[1][0]
    opts.success({ confirm: true, cancel: false })
    expect(spy).toHaveBeenCalled()
  })

  test('onFailedBack：清空结果并隐藏遮罩', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst._procPolicies = [{ product_name: 'x' }]
    inst.onFailedBack()
    expect(inst._procPolicies.length).toBe(0)
    expect(inst.data.ocrMask.visible).toBe(false)
  })

  test('onSavedHome：清空 batch + 触发 savedhome', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst.onSavedHome()
    expect(inst.triggerEvent).toHaveBeenCalledWith('savedhome', expect.any(Object))
    expect(wxMock.removeStorageSync).toHaveBeenCalledWith('ocrBatch')
    expect(inst.data.ocrMask.visible).toBe(false)
  })

  test('onSavedEnter：触发 saved 事件（手动进入报告页）', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst.onSavedEnter()
    expect(inst.triggerEvent).toHaveBeenCalledWith('saved', expect.objectContaining({ manual: true }))
  })
})

describe('ocr-flow 点击矩阵：保存失败重试', function () {
  test('onFailedRetry：重新执行保存流程', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    const spy = jest.spyOn(inst, '_doSave').mockResolvedValue()
    inst.onFailedRetry()
    expect(spy).toHaveBeenCalled()
  })
})
