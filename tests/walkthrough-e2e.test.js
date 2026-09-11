/**
 * 穿行测试 v2 — 主业务交易端到端
 *
 * 在内存 DB mock（cloudSDKMock：真实 where 过滤）上驱动真实云函数入口，
 * 按真实用户事务顺序走查：openid 静默登录 → 建档(OCR 保存链路) → 数据隔离 → 报告生成 → 查询 → 更新 → 级联删除。
 * AI 外部调用在 @cloudbase/node-sdk 边界打桩（与既有测试一致），其余全部走真实代码。
 */
const cloud = require('wx-server-sdk')
const cloudbase = require('@cloudbase/node-sdk')

const OPENID_A = 'wx_openid_a'
const OPENID_B = 'wx_openid_b'

function setOpenid(oid) {
  cloud.getWXContext = jest.fn().mockReturnValue({ OPENID: oid, APPID: 'wx_test' })
}
function readAll(name) {
  return cloud.database().collection(name).get().then(r => r.data || [])
}
function readWhere(name, where) {
  return cloud.database().collection(name).where(where).get().then(r => r.data || [])
}

beforeEach(() => {
  cloud.__resetMock()
  cloudbase.__resetMock()
  setOpenid(OPENID_A)
  // 内容安全审核桩（TMS）：返回 pass，避免降级日志噪音
  cloud.openapi = { security: { msgSecCheck: jest.fn().mockResolvedValue({ result: 'pass' }) } }
})

afterEach(() => { jest.restoreAllMocks() })

describe('穿行 v2 — 主业务交易', function() {

  test('完整链路：openid 登录 → 建档 → 保单/事实/财务 → 报告 → 查询 → 更新 → 级联删除', async function() {
    // ================= 1. 登录（openid 静默登录，方案 A）=================
    const login = require('../cloudfunctions/login/index')
    const lr = await login.main({}, {})
    expect(lr.code).toBe(200)
    expect(lr.data.openid).toBe(OPENID_A)
    expect(lr.data.phone).toBe('')
    // agents 建档落库（writeSeam 注入 _openid；不存手机号——数据红线）
    const agents = await readAll('agents')
    expect(agents.length).toBe(1)
    expect(agents[0].openid).toBe(OPENID_A)
    expect(agents[0]._openid).toBe(OPENID_A)
    expect(agents[0].nickname).toBe('新用户')
    expect(agents[0].phone || '').toBe('')

    // ================= 2. 建档（OCR 保存链路：createFamily + members）=================
    const dataWrite = require('../cloudfunctions/dataWrite/index')
    const cf = await dataWrite.main({
      action: 'createFamily',
      family_name: '张三家',
      members: [{ name: '张三', role: '本人', gender: '男', birth_date: '1985-05-01', occupation: '企业职员', income: 30 }]
    }, {})
    expect(cf.code).toBe(200)
    const familyId = cf.data._id
    const memberId = cf.data.members[0].member_id
    expect(memberId).toBeTruthy()
    const families = await readAll('families')
    expect(families.length).toBe(1)
    expect(families[0]._openid).toBe(OPENID_A)
    const members = await readAll('members')
    expect(members.length).toBe(1)
    expect(members[0].family_id).toBe(familyId)

    // ---- 保单写入（writePolicy：校验 + 注入检测 + 状态判定）----
    const wp = await dataWrite.main({
      action: 'writePolicy',
      familyId, memberId,
      data: {
        product_name: '平安福', insurance_category: '重疾', insurer: '平安人寿',
        sum_assured: 500000, annual_premium: 8000, policy_number: 'P20240001',
        effective_date: '2024-01-01', policyholder_name: '张三', insured_name: '张三', payment_method: '年缴'
      }
    }, {})
    expect(wp.code).toBe(200)
    const policies = await readAll('policies')
    expect(policies.length).toBe(1)
    expect(policies[0].family_id).toBe(familyId)
    expect(policies[0].member_id).toBe(memberId)
    expect(policies[0].status).toBe('active')
    const policyDocId = policies[0]._id
    const policyBizId = policies[0].id || policies[0]._id

    // ---- 事实写入（addFact：谓词归一化 + 脱敏）----
    const af = await dataWrite.main({ action: 'addFact', familyId, subjectName: '张三', predicate: '年收入', objectValue: '30万', source: 'ai' }, {})
    expect(af.code).toBe(200)
    const facts = await readAll('facts')
    expect(facts.some(f => f.family_id === familyId && String(f.predicate).includes('年收入'))).toBe(true)

    // ---- 财务写入（upsertFinances：字段别名归一化，singleton by family）----
    const uf = await dataWrite.main({ action: 'updateFinances', familyId, income: 30, fixed_expense: 10, debt: 100, debt_type: '房贷' }, {})
    expect(uf.code).toBe(200)
    const finances = await readAll('finances')
    expect(finances.length).toBe(1)
    expect(finances[0].annual_income).toBe(30)
    expect(finances[0].total_debt).toBe(100)

    // ================= 3. 数据隔离：他人 openid 不可见 =================
    setOpenid(OPENID_B)
    const dataQuery = require('../cloudfunctions/dataQuery/index')
    const gB = await dataQuery.main({ action: 'getFamily', familyId }, {})
    expect(gB.code).toBe(404)
    const lB = await dataQuery.main({ action: 'listFamilies', limit: 10 }, {})
    expect(lB.code).toBe(200)
    expect(lB.data.families.length).toBe(0)
    setOpenid(OPENID_A)

    // ================= 4. 报告生成（AI 边界打桩）=================
    const _reportPayload = {
      portrait: '张三家庭保障画像：支柱双职工，重疾缺口约50万……',
      review: '当前保障分析：重疾保障充足度中等……',
      plan: '建议方案：补充定期寿险……',
      summary: '家庭保障总览：1张保单，年缴8000元',
      analysis: '风险分析：房贷负债100万，寿险保额不足……',
      conclusion: '结论：当前保障基本充足，建议补充寿险',
      suggestions: '建议一：补充定期寿险100万；建议二：关注重疾豁免',
      disclaimer: '本报告由 AI 生成，仅供参考，不构成投保建议',
      core_insights: ['重疾缺口50万', '寿险缺口100万']
    }
    cloudbase.__setMockGenerateText(jest.fn().mockResolvedValue({
      text: JSON.stringify(_reportPayload),
      usage: { total_tokens: 320 }
    }))
    // 2026-09-09：reportAI 已切 DeepSeek 直连（callChatDirect 走 axios，不经 SDK generateText），
    // 同一桩须同时注入直连通道，否则 e2e 会打真实网络
    jest.spyOn(require('../cloudfunctions/reportAI/_shared/ai-client'), 'callChatDirect')
      .mockResolvedValue({ text: JSON.stringify(_reportPayload), usage: { total_tokens: 320 } })
    const reportAI = require('../cloudfunctions/reportAI/index')
    const rr = await reportAI.main({ familyId }, {})
    expect(rr.code).toBe(200)
    expect(rr.data.portrait).toContain('保障画像')
    // families.last_* 落库 + insight_stale 复位
    const famAfter = await readWhere('families', { _id: familyId })
    expect(famAfter[0].last_portrait).toContain('保障画像')
    expect(famAfter[0].insight_stale).toBe(false)
    // 报告版本归档（archivePrevious → reports 集合）
    // 首次生成无"上一版"可归档；清 CAS 锁后二次生成 → 归档上一版
    const reportsFirst = await readAll('reports')
    expect(reportsFirst.some(r => r.family_id === familyId)).toBe(false)
    const famForLock = await readWhere('families', { _id: familyId })
    delete famForLock[0].analysis_lock_at
    delete famForLock[0].last_analysis_at
    const rr2 = await reportAI.main({ familyId }, {})
    expect(rr2.code).toBe(200)
    expect(rr2.throttled).not.toBe(true)
    const reports = await readAll('reports')
    expect(reports.some(r => r.family_id === familyId)).toBe(true)

    // ================= 5. 查询 =================
    const gA = await dataQuery.main({ action: 'getFamily', familyId }, {})
    expect(gA.code).toBe(200)
    expect(gA.data.report.portrait).toContain('保障画像')
    expect(gA.data.policies.length).toBe(1)
    const lA = await dataQuery.main({ action: 'listFamilies', limit: 3 }, {})
    expect(lA.code).toBe(200)
    expect(lA.data.families.length).toBe(1)
    expect(lA.data.families[0]._id).toBe(familyId)

    // ================= 6. 更新 =================
    const um = await dataWrite.main({ action: 'updateMember', familyId, memberId, field: 'income', value: 40 }, {})
    expect(um.code).toBe(200)
    const memAfter = await readWhere('members', { member_id: memberId })
    expect(memAfter[0].income).toBe(40)
    // 保单状态变更（changePolicyStatus：白名单校验；定位按业务 id 而非 _id）
    // 2026-08-30：非 active 状态必须携带失效日期（effectiveDate）
    const cs = await dataWrite.main({ action: 'changePolicyStatus', familyId, policyId: policyBizId, status: 'surrendered', effectiveDate: '2026-08-30' }, {})
    expect(cs.code).toBe(200)
    const polAfter = await readWhere('policies', { _id: policyDocId })
    expect(polAfter[0].status).toBe('surrendered')

    // ================= 7. 删除（batchTx 级联，最后删 family）=================
    const del = await dataWrite.main({ action: 'deleteFamily', familyId }, {})
    expect(del.code).toBe(200)
    const famGone = await readWhere('families', { _id: familyId })
    expect(famGone.length).toBe(0)
    expect((await readWhere('members', { family_id: familyId })).length).toBe(0)
    expect((await readWhere('policies', { family_id: familyId })).length).toBe(0)
    expect((await readWhere('facts', { family_id: familyId })).length).toBe(0)
    expect((await readWhere('finances', { family_id: familyId })).length).toBe(0)
    expect((await readWhere('reports', { family_id: familyId })).length).toBe(0)
  })

  test('入口守卫：缺 familyId / 未知 action / 无 openid 均返回 4xx', async function() {
    const dataWrite = require('../cloudfunctions/dataWrite/index')
    expect((await dataWrite.main({ action: 'nonexistent' }, {})).code).toBe(400)
    const reportAI = require('../cloudfunctions/reportAI/index')
    expect((await reportAI.main({}, {})).code).toBe(400)
    const login = require('../cloudfunctions/login/index')
    // 无 openid 401
    cloud.getWXContext = jest.fn().mockReturnValue({})
    expect((await dataWrite.main({ action: 'createFamily' }, {})).code).toBe(401)
    expect((await login.main({}, {})).code).toBe(401)
  })

  test('重复登录：同 openid 复用 agent，不重复建档', async function() {
    const login = require('../cloudfunctions/login/index')
    const r1 = await login.main({}, {})
    const r2 = await login.main({}, {})
    expect(r1.code).toBe(200)
    expect(r2.code).toBe(200)
    expect(r2.data.agent_id).toBe(r1.data.agent_id)
    expect((await readAll('agents')).length).toBe(1)
  })
})
