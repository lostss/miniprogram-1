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

// ===========================================================================
// 2026-09-19 流程审计 P1-5：批量写入**部分失败**不得当成功
// ===========================================================================
describe('ocr-flow 组件：保存结果对账（P1-5）', function () {
  // 直接驱动 _doSave 的写入段：skipMatch + 预置 familyId 跳过归属阶段，
  // _runRoleStage 打桩跳过角色阶段，只在 confirmWritePolicies 返回值上做文章。
  function setup(cfg, writeRet) {
    const flowMod = require('../miniprogram/utils/ocr-flow')
    jest.spyOn(flowMod, 'confirmWritePolicies').mockResolvedValue(writeRet)
    const inst = makeInstance(cfg, { properties: { skipMatch: true, familyId: 'fam1' } })
    wxMock.nextTick = function (fn) { fn() } // _doSave 用 wx.nextTick 延迟 _showSaved
    inst._procPolicies = [{ product_name: 'A' }, { product_name: 'B' }, { product_name: 'C' }]
    inst._runRoleStage = jest.fn().mockResolvedValue({ familyId: 'fam1', newRoles: [] })
    inst._showSaved = jest.fn()
    return inst
  }

  test('部分失败（written=2/total=3）→ 进 failed 相并披露已保存数，且不走 _showSaved', async function () {
    // 原实现只拦 written===0：2/3 会顺流走 _showSaved → _clearBatch 清空批次，
    // 未落库的第 3 份既无提示也无法重试（数据静默丢失）。
    const inst = setup(loadComponent(), { ok: true, written: 2, total: 3, dedupSkipped: 0 })
    await inst._doSave()
    expect(inst.data.ocrMask.phase).toBe('failed')
    expect(inst.data.ocrMask.saveError).toContain('已保存 2/3')
    expect(inst._showSaved).not.toHaveBeenCalled()
  })

  test('dedupSkipped 抵扣后无缺口 → 视为全部成功（不误报失败）', async function () {
    const inst = setup(loadComponent(), { ok: true, written: 2, total: 3, dedupSkipped: 1 })
    await inst._doSave()
    expect(inst._showSaved).toHaveBeenCalled()
  })

  test('全部成功 → 走 _showSaved，savedCount 取后端 written', async function () {
    const inst = setup(loadComponent(), { ok: true, written: 3, total: 3, dedupSkipped: 0 })
    await inst._doSave()
    expect(inst._showSaved).toHaveBeenCalled()
    expect(inst._showSaved.mock.calls[0][0]).toBe(3)
  })
})

// ===========================================================================
// 2026-09-19 流程审计 P2-4：失败态「放弃全部」必须清批次
// ===========================================================================
describe('ocr-flow 组件：失败态放弃清批次（P2-4）', function () {
  test('onFailedBack → 清 ocrBatch 存储 + 上抛 discarded', function () {
    const inst = makeInstance(loadComponent())
    inst._procPolicies = [{ product_name: 'A' }]
    inst._procErrors = [{ fileId: 'f1' }]

    inst.onFailedBack()

    // 原实现只清 _proc*：本地 ocrBatch 残留 → checkResume 下次进入又弹"检测到未完成的处理…"
    expect(wxMock.removeStorageSync).toHaveBeenCalledWith('ocrBatch')
    expect(inst.triggerEvent).toHaveBeenCalledWith('discarded')
    expect(inst._procPolicies).toEqual([])
    expect(inst._procErrors).toEqual([])
    expect(inst.data.ocrMask.visible).toBe(false)
  })
})

// ===========================================================================
// 2026-09-19 流程审计 P1-1：归属候选不再按"家庭名精确相等"过滤 + 关键词覆盖被保人
// ===========================================================================
jest.mock('../miniprogram/utils/apiClient', () => jest.fn())

describe('ocr-flow 组件：归属候选（P1-1）', function () {
  // 后端 searchFamilies 是正则子串双路匹配（家庭名 or 成员名），返回项天然含两类命中
  function seedApi(keywordsSeen) {
    jest.resetModules()
    const cfg = loadComponent()
    const api = require('../miniprogram/utils/apiClient') // resetModules 后须重新取
    api.mockReset()
    api.mockImplementation(function (action, params) {
      if (action === 'searchFamilies') {
        keywordsSeen.push(params.keyword)
        if (params.keyword === '李阳勇') {
          return Promise.resolve({ ok: true, data: { families: [{ _id: 'f2', name: '李阳勇家庭' }, { _id: 'f1', name: '李姐-转介绍' }] } })
        }
        return Promise.resolve({ ok: true, data: { families: [] } })
      }
      if (action === 'getFamily') {
        if (params.familyId === 'f1') return Promise.resolve({ ok: true, data: { _id: 'f1', name: '李姐-转介绍', members: [{ name: '李阳勇', role: '本人' }] } })
        if (params.familyId === 'f2') return Promise.resolve({ ok: true, data: { _id: 'f2', name: '李阳勇家庭', members: [{ name: '谢敏', role: '配偶' }] } })
      }
      return Promise.resolve({ ok: true, data: {} })
    })
    return { cfg, api }
  }

  test('成员名命中与子串命中都保留，各标注依据，强命中优先且默认预选它', async function () {
    const seen = []
    const { cfg } = seedApi(seen)
    const inst = makeInstance(cfg)
    const pending = inst._runMatchStage([{ insured_name: '李阳勇', policyholder_name: '李阳勇', product_name: 'X' }])
    await new Promise(function (r) { setTimeout(r, 0) }) // 冲净 await 链

    const cands = inst.data.ocrMask.matchCandidates
    // 原实现 `c.name === primaryHolder` 会把两个都丢掉（'李阳勇家庭' ≠ '李阳勇'）→ 只能新建家庭
    expect(cands.map(function (c) { return c._id }).sort()).toEqual(['f1', 'f2'])
    const byId = {}
    cands.forEach(function (c) { byId[c._id] = c })
    expect(byId.f1.basis).toBe('成员「李阳勇」所在家庭') // 成员名命中
    expect(byId.f2.basis).toBe('家庭名包含「李阳勇」')   // 子串命中
    expect(inst.data.ocrMask.matchPick).toBe('f1')      // 强命中（成员名命中）排首位并被预选

    inst.onMatchNext()
    expect(await pending).toBe('f1')
  })

  test('关键词覆盖投保人与各被保人（父母为孩子投保时，投保人名不在任何家庭）', async function () {
    const seen = []
    const { cfg } = seedApi(seen)
    const inst = makeInstance(cfg)
    const pending = inst._runMatchStage([
      { insured_name: '小明', policyholder_name: '王芳', product_name: 'A' },
      { insured_name: '小红', policyholder_name: '王芳', product_name: 'B' }
    ])
    await new Promise(function (r) { setTimeout(r, 0) })

    expect(seen).toEqual(['王芳', '小明', '小红']) // 去重且投保人优先；原实现只查 '王芳'
    inst.onMatchNext()
    await pending
  })
})
