const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 架构审计第 17 轮候选 #2：agents 写入统一经 writeSeam 接缝
// （_openid 注入不变量 + updated_at 审计字段；agents 表不传 familyId，不触发 family 钩子）
const { writeSeam } = require('./_shared/writeSeam')

async function devLogin(openid) {
  try {
    const r = await db.collection('agents').where({ openid }).limit(1).get()
    if (r.data && r.data.length > 0) {
      // 经 writeSeam.silentUpdateDoc：自动附加 updated_at
      const ws = writeSeam(db, openid)
      await ws.silentUpdateDoc('agents', r.data[0]._id, { last_login_at: new Date() })
      return { code: 200, msg: '调试登录成功', data: { openid, agent_id: r.data[0]._id, phone: r.data[0].phone, nickname: r.data[0].nickname, role: r.data[0].role, plan: r.data[0].plan } }
    }
    const now = new Date()
    // 经 writeSeam.silentAdd：自动注入 _openid
    const ws = writeSeam(db, openid)
    const c = await ws.silentAdd('agents', { phone: 'dev_' + openid.slice(-6), openid, nickname: '开发测试', avatar_url: '', role: 'trial', plan: 'trial', token_monthly_limit: 10000, token_used_monthly: 0, token_used_total: 0, status: 'active', created_at: now, last_login_at: now })
    return { code: 200, msg: '调试登录成功', data: { openid, agent_id: c._id, phone: 'dev_' + openid.slice(-6), nickname: '开发测试', role: 'trial', plan: 'trial' } }
  } catch (err) {
    console.error('[login] dev 失败:', err.message)
    return { code: 500, msg: '调试登录失败' }
  }
}

async function phoneLogin(code, openid) {
  try {
    const phoneRes = await cloud.openapi.phonenumber.getPhoneNumber({ code })
    const phone = phoneRes && phoneRes.phoneInfo && phoneRes.phoneInfo.phoneNumber
    if (!phone) return { code: 400, msg: '手机号获取失败' }
    const r = await db.collection('agents').where({ phone }).limit(1).get()
    const now = new Date()
    if (r.data && r.data.length > 0) {
      // 经 writeSeam.silentUpdateDoc：自动附加 updated_at
      const ws = writeSeam(db, openid)
      await ws.silentUpdateDoc('agents', r.data[0]._id, { openid, last_login_at: now })
      return { code: 200, msg: '登录成功', data: { openid, agent_id: r.data[0]._id, phone, nickname: r.data[0].nickname, role: r.data[0].role, plan: r.data[0].plan } }
    }
    // 经 writeSeam.silentAdd：自动注入 _openid
    const ws = writeSeam(db, openid)
    const c = await ws.silentAdd('agents', { openid, phone, nickname: '新用户', avatar_url: '', role: 'trial', plan: 'trial', token_monthly_limit: 10000, token_used_monthly: 0, token_used_total: 0, status: 'active', created_at: now, last_login_at: now })
    return { code: 200, msg: '登录成功', data: { openid, agent_id: c._id, phone, nickname: '新用户', role: 'trial', plan: 'trial' } }
  } catch (err) {
    console.error('[login] phone 失败:', err.message)
    return { code: 500, msg: '登录失败' }
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext && (wxContext.OPENID || wxContext.openId)
  if (!openid) return { code: 401, msg: '获取用户身份失败' }

  const envId = String(cloud.DYNAMIC_CURRENT_ENV || process.env.ENV_ID || '')
  // 守卫：生产环境禁止 dev 登录（devMode:true 仅限非 prod 环境调试用）
  if (envId.includes('prod') && event.devMode) return { code: 403, msg: 'dev 登录仅限开发环境' }

  if (event.code) return await phoneLogin(event.code, openid)
  if (event.devMode) return await devLogin(openid)
  return { code: 400, msg: '缺少登录code' }
}
