jest.mock('../cloudfunctions/conversationAI/_shared/logSeam', () => ({
  logAI: jest.fn().mockResolvedValue(undefined)
}))

const { handleConfirm } = require('../cloudfunctions/conversationAI/confirm-handler')

test('probe handleConfirm invocation', async () => {
  const ctxCache = { invalidate: jest.fn() }
  const dispatch = jest.fn().mockResolvedValue({ code: 200, msg: 'ok' })
  const writeMessage = jest.fn().mockResolvedValue(true)
  const r = await handleConfirm({
    familyId: 'fam_001', openid: 'op_test', pendingId: 'pc_001', sid: 'sess_001',
    userText: '确认', db: {}, promptVersion: 'v1',
    lastMsg: { pending_confirms: [{ pendingId: 'pc_001', type: 'fact_confirm', factId: 'fact_001' }] },
    ctxCache, dispatch, writeMessage
  })
  // eslint-disable-next-line no-console
  console.log('CODE:', r && r.code)
  // eslint-disable-next-line no-console
  console.log('CTX_INVALIDATE_CALLS:', ctxCache.invalidate.mock.calls.length)
  // eslint-disable-next-line no-console
  console.log('DISPATCH_CALLS:', dispatch.mock.calls.length)
})
