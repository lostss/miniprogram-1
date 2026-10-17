/**
 * 新建客户弹窗（2026-10-17：名称 + 人数一次性录入）
 *
 * 要修的那个 bug（用户实报）：原流程是两步 wx.showModal(editable)，而 wx.showModal 的
 * 确认是"**先关闭弹窗再回调**"—— 名称留空时只弹了个 toast，输入框连同已打的字一起消失。
 * 本测试把这条钉死：空名称提交后 **visible 仍为 true**、输入值保留、只加行内错误。
 */
jest.mock('../miniprogram/utils/apiClient', () => jest.fn())

const api = require('../miniprogram/utils/apiClient')
const { HOME_CACHE_KEY } = require('../miniprogram/utils/family-actions')

let page

beforeAll(() => {
  global.Page = (cfg) => { page = cfg }
  global.wx = {
    getStorageSync: jest.fn(() => null),
    setStorageSync: jest.fn(),
    removeStorageSync: jest.fn(),
    showToast: jest.fn(),
    showLoading: jest.fn(),
    hideLoading: jest.fn(),
    navigateTo: jest.fn(),
    vibrateShort: jest.fn()
  }
  require('../miniprogram/pages/index/index.js')
})

/** 假页面实例：setData 支持 'a.b' 路径（弹窗状态全是嵌套字段），并真实合并进 data */
function makeCtx() {
  const ctx = Object.assign({}, page)
  ctx.data = JSON.parse(JSON.stringify(page.data))
  ctx.setData = jest.fn((patch) => {
    Object.keys(patch).forEach((k) => {
      const parts = k.split('.')
      let o = ctx.data
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]]
      o[parts[parts.length - 1]] = patch[k]
    })
  })
  return ctx
}

beforeEach(() => { api.mockReset(); wx.showToast.mockClear(); wx.removeStorageSync.mockClear() })

describe('打开 / 取消', () => {
  test('打开时是干净初始态（上次的输入不残留）', () => {
    const ctx = makeCtx()
    ctx.data.createModal = { visible: false, name: '旧名字', count: 5, error: '旧错误', submitting: false }
    ctx.onCreateFamily()
    expect(ctx.data.createModal).toEqual({ visible: true, name: '', count: 0, error: '', submitting: false })
  })

  test('创建中不允许取消（避免请求已发出、弹窗先关掉）', () => {
    const ctx = makeCtx()
    ctx.onCreateFamily()
    ctx.setData({ 'createModal.submitting': true })
    ctx.onCreateCancel()
    expect(ctx.data.createModal.visible).toBe(true)
  })

  test('点遮罩不关闭（表单未提交前意外关闭 = 丢输入）', () => {
    const ctx = makeCtx()
    ctx.onCreateFamily()
    ctx.onCreateMaskTap()
    expect(ctx.data.createModal.visible).toBe(true)
  })
})

describe('校验：就地报错、不关窗、不丢输入', () => {
  test('名称为空点创建 → 弹窗仍在、输入保留、只加行内错误、不发请求', () => {
    const ctx = makeCtx()
    ctx.onCreateFamily()
    ctx.onCreateSubmit()
    expect(api).not.toHaveBeenCalled()
    expect(ctx.data.createModal.visible).toBe(true)
    expect(ctx.data.createModal.error).toBe('请填写客户名称')
  })

  test('全空格视为空（trim 后再判）', () => {
    const ctx = makeCtx()
    ctx.onCreateFamily()
    ctx.onCreateNameInput({ detail: { value: '   ' } })
    ctx.onCreateSubmit()
    expect(api).not.toHaveBeenCalled()
    expect(ctx.data.createModal.error).toBe('请填写客户名称')
  })

  test('重新输入即清除错误（不让红字一直挂着）', () => {
    const ctx = makeCtx()
    ctx.onCreateFamily()
    ctx.onCreateSubmit()
    expect(ctx.data.createModal.error).toBeTruthy()
    ctx.onCreateNameInput({ detail: { value: '李姐' } })
    expect(ctx.data.createModal.error).toBe('')
  })

  test('人数步进器限死 0..10（取代原"人数请填 0-10 的整数"的 toast 纠错）', () => {
    const ctx = makeCtx()
    ctx.onCreateFamily()
    ctx.onCountMinus()
    expect(ctx.data.createModal.count).toBe(0) // 下界
    for (let i = 0; i < 20; i++) ctx.onCountPlus()
    expect(ctx.data.createModal.count).toBe(10) // 上界
  })
})

describe('提交', () => {
  test('成功：占位成员按 skeletonName 命名、关弹窗、清列表缓存、跳新客户', async () => {
    api.mockResolvedValue({ ok: true, data: { _id: 'fam_new' } })
    const ctx = makeCtx()
    ctx.onCreateFamily()
    ctx.onCreateNameInput({ detail: { value: ' 李姐-转介绍 ' } }) // 首尾空格应被 trim
    ctx.onCountPlus(); ctx.onCountPlus(); ctx.onCountPlus()
    await ctx._doCreateFamily(ctx.data.createModal.name.trim(), ctx.data.createModal.count)

    const [action, payload] = api.mock.calls[0]
    expect(action).toBe('createFamily')
    expect(payload.family_name).toBe('李姐-转介绍')
    // 占位成员必须用契约命名（后端 member-matcher 依此认领；空名会让认领失效）
    expect(payload.members.map((m) => m.name)).toEqual(['成员1', '成员2', '成员3'])
    expect(ctx.data.createModal.visible).toBe(false)
    expect(ctx.data.createModal.submitting).toBe(false)
    expect(wx.removeStorageSync).toHaveBeenCalledWith(HOME_CACHE_KEY)
  })

  test('人数为 0（暂不填）→ 不造占位成员，仍是合法建档', async () => {
    api.mockResolvedValue({ ok: true, data: { _id: 'fam_x' } })
    const ctx = makeCtx()
    ctx.onCreateFamily()
    await ctx._doCreateFamily('李姐', 0)
    expect(api.mock.calls[0][1].members).toEqual([])
  })

  test('服务端失败：留在弹窗里报错（名称不丢），不是关窗 toast', async () => {
    api.mockResolvedValue({ ok: false, msg: '名称重复' })
    const ctx = makeCtx()
    ctx.onCreateFamily()
    ctx.onCreateNameInput({ detail: { value: '李姐' } })
    await ctx._doCreateFamily('李姐', 2)
    expect(ctx.data.createModal.visible).toBe(true)
    expect(ctx.data.createModal.error).toBe('名称重复')
    expect(ctx.data.createModal.submitting).toBe(false)
  })

  test('网络异常：同样留在弹窗，给出通用错误', async () => {
    api.mockRejectedValue(new Error('network'))
    const ctx = makeCtx()
    ctx.onCreateFamily()
    await ctx._doCreateFamily('李姐', 2)
    expect(ctx.data.createModal.visible).toBe(true)
    expect(ctx.data.createModal.error).toBe('创建失败，请重试')
    expect(ctx.data.createModal.submitting).toBe(false)
  })

  test('创建中重复点击不会发第二次请求', async () => {
    api.mockResolvedValue({ ok: true, data: { _id: 'f' } })
    const ctx = makeCtx()
    ctx.onCreateFamily()
    ctx.onCreateNameInput({ detail: { value: '李姐' } })
    const p1 = ctx.onCreateSubmit() // 内部置 submitting
    ctx.onCreateSubmit()
    await p1
    expect(api).toHaveBeenCalledTimes(1)
  })
})
