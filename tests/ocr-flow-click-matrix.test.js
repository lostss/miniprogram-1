/**
 * ocr-flow 点击行为矩阵（动态层）
 * 对关键交互方法：构造假事件 → 调用 → 断言 setData / showModal 分支 / triggerEvent / 状态标志
 * 覆盖：匹配弹窗、角色卡、编辑 sheet、放弃/确认、保存态
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

describe('ocr-flow 点击矩阵：编辑 sheet', function () {
  test('onEditCard：打开保单编辑面板', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst._procPolicies = [{ product_name: '康宁', sum_assured: '50万' }]
    inst.onEditCard({ currentTarget: { dataset: { policyindex: 0 } } })
    expect(inst.data.ocrSheet.visible).toBe(true)
    expect(inst.data.ocrSheet.policyIndex).toBe(0)
    expect(inst.data.ocrSheet.title).toContain('康宁')
  })

  test('onEditSheetClose：关闭面板并重置 mode', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst.setData({ 'ocrSheet.visible': true, 'ocrSheet.mode': 'edit' })
    inst.onEditSheetClose()
    expect(inst.data.ocrSheet.visible).toBe(false)
    expect(inst.data.ocrSheet.mode).toBe('view')
  })

  test('onEditSheetSave：编辑模式 → 更新保单并关闭（校验已移交 edit-sheet 组件）', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst._procPolicies = [{ product_name: '康宁', sum_assured: '50万' }]
    inst.setData({ 'ocrSheet.visible': true, 'ocrSheet.policyIndex': 0 })
    inst.onEditSheetSave({ detail: { sum_assured: '800000' } })
    expect(inst.data.ocrSheet.visible).toBe(false)
    expect(inst.data.ocrSheet.mode).toBe('view')
    expect(inst._procPolicies[0].sum_assured).toBe('800000')
    expect(inst._procPolicies[0].field_confidence.sum_assured).toBe(0.99)
  })

  test('onEditSheetSave：新增模式 → 仅收集非空值入新保单（空值过滤）', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst._procPolicies = []
    inst.setData({ 'ocrSheet.visible': true, 'ocrSheet.policyIndex': -1 })
    // 必填校验在 edit-sheet 组件内完成（product_name 非空才触发 save）；此处验证空值字段不入录
    inst.onEditSheetSave({ detail: { product_name: '康宁', sum_assured: '800000', effective_date: '' } })
    expect(inst._procPolicies.length).toBe(1)
    expect(inst._procPolicies[0].product_name).toBe('康宁')
    expect(inst._procPolicies[0].sum_assured).toBe('800000')
    expect(inst._procPolicies[0].effective_date).toBeUndefined()
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

  test('onProcPreview：预览图片', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst.onProcPreview({ currentTarget: { dataset: { src: 'cloud://t.jpg' } } })
    expect(wxMock.previewImage).toHaveBeenCalledWith(expect.objectContaining({ urls: ['cloud://t.jpg'] }))
  })

  test('onProcManualAdd：打开手动录入面板并记录 fileId', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst.onProcManualAdd({ currentTarget: { dataset: { fileid: 'cloud://f1' } } })
    expect(inst.data.ocrSheet.visible).toBe(true)
    expect(inst.data.ocrSheet.policyIndex).toBe(-1)
    expect(inst._manualFileId).toBe('cloud://f1')
  })
})

describe('ocr-flow 点击矩阵：重试路径（审计补充）', function () {
  test('onProcRetryOne：重试成功 → 移除失败项并入库', async function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst._procErrors = [{ fileId: 'f1', thumb: 't.jpg', error: '识别失败' }]
    jest.spyOn(inst, '_ocrRetryOne').mockResolvedValue({ policies: [{ product_name: '康宁' }], newFileId: 'cloud://n' })
    const flowMod = require('../miniprogram/utils/ocr-flow')
    const cleanup = jest.spyOn(flowMod, 'cleanupTempFiles').mockImplementation(function () {})

    await inst.onProcRetryOne({ currentTarget: { dataset: { fileid: 'f1' } } })

    expect(inst._procErrors.length).toBe(0)
    expect(inst._procPolicies.length).toBe(1)
    expect(inst._procPolicies[0].product_name).toBe('康宁')
    expect(cleanup).toHaveBeenCalledWith(['cloud://n'])
    expect(inst.data.ocrMask.procBusy).toBe(false)
  })

  test('onProcRetryOne：重试失败 → 失败项保留 + toast', async function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst._procPolicies = []
    inst._procErrors = [{ fileId: 'f1', thumb: 't.jpg', error: '识别失败' }]
    jest.spyOn(inst, '_ocrRetryOne').mockResolvedValue({ error: 'AI 超时' })

    await inst.onProcRetryOne({ currentTarget: { dataset: { fileid: 'f1' } } })

    // 失败项按 fileId 保留（错误文案经 classifyBatchResults 归一分组）
    expect(inst._procErrors.length).toBe(1)
    expect(inst._procErrors[0].fileId).toBe('f1')
    expect(wxMock.showToast).toHaveBeenCalled()
    expect(inst.data.ocrMask.procBusy).toBe(false)
  })

  test('onProcRetryOne：procBusy 时防重入', async function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    inst.setData({ 'ocrMask.procBusy': true })
    const retry = jest.spyOn(inst, '_ocrRetryOne').mockResolvedValue({})
    await inst.onProcRetryOne({ currentTarget: { dataset: { fileid: 'f1' } } })
    expect(retry).not.toHaveBeenCalled()
  })

  test('onProcRetryAll：部分成功 → 成功入库、失败保留', async function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    // 真实流程中 _procPolicies/_procCash 已由识别阶段（_renderProc）初始化；onProcRetryAll 不依赖 _procRefresh 补初始化
    inst._procPolicies = []
    inst._procCash = []
    inst._procErrors = [{ fileId: 'f1', thumb: 't1' }, { fileId: 'f2', thumb: 't2' }]
    jest.spyOn(inst, '_ocrRetryOne').mockImplementation(function (fileId) {
      return fileId === 'f1'
        ? Promise.resolve({ policies: [{ product_name: '康宁' }] })
        : Promise.resolve({ error: '失败' })
    })

    await inst.onProcRetryAll()

    expect(inst._procPolicies.length).toBe(1)
    expect(inst._procErrors.length).toBe(1)
    expect(inst._procErrors[0].fileId).toBe('f2')
    expect(inst.data.ocrMask.procBusy).toBe(false)
  })

  test('onProcRetryAll：无失败项 → 直接返回（不触发重试）', async function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    const retry = jest.spyOn(inst, '_ocrRetryOne').mockResolvedValue({})
    await inst.onProcRetryAll()
    expect(retry).not.toHaveBeenCalled()
  })

  test('onFailedRetry：重新执行保存流程', function () {
    const cfg = loadComponent()
    const inst = makeInstance(cfg)
    const spy = jest.spyOn(inst, '_doSave').mockResolvedValue()
    inst.onFailedRetry()
    expect(spy).toHaveBeenCalled()
  })
})
