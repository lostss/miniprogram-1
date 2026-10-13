/**
 * family-actions — 删除家庭后的本地残留清理（2026-09-20 复核批次 A）
 *
 * 覆盖本次补的 `chat_history_<familyId>`：家庭档案已在云端删除，本地仍留着该家庭的
 * 完整聊天快照（小秘回答里含保额/家庭情况等 PII），且该 key 按家庭数累积、不随家庭
 * 删除释放，长期逼近小程序 10MB 存储上限。
 *
 * 同时锁死反向行为：删除**失败**时不得清缓存（否则用户重试时状态已被销毁）。
 */
jest.mock('../miniprogram/utils/apiClient', () => jest.fn())

const api = require('../miniprogram/utils/apiClient')
// 2026-10-13：CLIENTS_CACHE_KEY 已随"首页/客户列表页合并"收成单键（只留 HOME_CACHE_KEY）
const { confirmDeleteFamily, HOME_CACHE_KEY } = require('../miniprogram/utils/family-actions')

// 最小 wx 假实现：ActionSheet/Modal 同步走"确认"分支，storage 用真实 Map 便于断言键的存亡
function mockWx(store) {
  global.wx = {
    getStorageSync: (k) => store.get(k) || '',
    setStorageSync: (k, v) => store.set(k, v),
    removeStorageSync: (k) => store.delete(k),
    showToast: jest.fn(),
    showLoading: jest.fn(),
    hideLoading: jest.fn(),
    showActionSheet: (o) => o.success({ tapIndex: 0 }),
    showModal: (o) => o.success({ confirm: true })
  }
  return store
}

function seededStore() {
  const store = new Map()
  store.set('chat_history_fam_A', { messages: [{ role: 'assistant', content: '含 PII 的对话' }] })
  store.set('chat_history_fam_B', { messages: [{ role: 'assistant', content: 'B' }] })
  store.set('match_cache', { name: 'fam_A' })
  store.set(HOME_CACHE_KEY, [{ _id: 'fam_A' }])
  return store
}

const flush = () => new Promise(r => setTimeout(r, 0))

describe('confirmDeleteFamily — 本地缓存清理', () => {
  beforeEach(() => { api.mockReset(); delete global.wx })
  afterEach(() => { delete global.wx })

  test('删除成功后清 chat_history_<familyId>，且不影响其他家庭的缓存', async () => {
    const store = seededStore()
    mockWx(store)
    api.mockResolvedValue({ ok: true, code: 200 })
    const onSuccess = jest.fn()

    confirmDeleteFamily({ familyId: 'fam_A', name: '李姐', onSuccess })
    await flush()

    expect(store.has('chat_history_fam_A')).toBe(false) // ← 本次修复
    expect(store.has('chat_history_fam_B')).toBe(true)  // 不误伤其他家庭
    expect(store.has('match_cache')).toBe(false)
    expect(store.has(HOME_CACHE_KEY)).toBe(false)
    expect(onSuccess).toHaveBeenCalled()
  })

  test('删除失败 → 一律不清缓存（用户可重试，数据仍在）', async () => {
    const store = seededStore()
    mockWx(store)
    api.mockResolvedValue({ ok: false, code: 500, msg: '删除失败' })
    const onSuccess = jest.fn()

    confirmDeleteFamily({ familyId: 'fam_A', name: '李姐', onSuccess })
    await flush()

    expect(store.has('chat_history_fam_A')).toBe(true)
    expect(store.has(HOME_CACHE_KEY)).toBe(true)
    expect(onSuccess).not.toHaveBeenCalled()
  })

  test('207（部分级联失败）自动重试后成功 → 按成功路径清理', async () => {
    const store = seededStore()
    mockWx(store)
    api
      .mockResolvedValueOnce({ ok: false, code: 207, msg: '部分关联数据已清理' })
      .mockResolvedValueOnce({ ok: true, code: 200 })

    confirmDeleteFamily({ familyId: 'fam_A', name: '李姐' })
    await flush()

    expect(api).toHaveBeenCalledTimes(2) // 207 触发一次自动重试
    expect(store.has('chat_history_fam_A')).toBe(false)
  })

  test('缺 familyId → 不弹任何确认、不发请求', async () => {
    const store = seededStore()
    mockWx(store)

    confirmDeleteFamily({ familyId: '', name: '李姐' })
    await flush()

    expect(api).not.toHaveBeenCalled()
    expect(store.has('chat_history_fam_A')).toBe(true)
  })
})
