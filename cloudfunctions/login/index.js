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
      // R-1 修复：agents 归属以 openid 字段为准，登录是建立 _openid 的信任锚点；
      // safeUpdateDoc 的 _openid 预校验对未绑定记录会误拒，故直接更新并写入 _openid
      const ws = writeSeam(db, openid)
      await db.collection('agents').doc(r.data[0]._id).update({ data: { last_login_at: new Date(), _openid: openid, updated_at: new Date() } })
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
      // 安全守卫：openid 不一致时拒绝登录（防止不同微信用户用同手机号劫持账号）
      if (r.data[0].openid && r.data[0].openid !== openid) {
        return { code: 403, msg: '该手机号已绑定其他微信账号' }
      }
      // R-1 修复：登录是信任锚点，直接更新并确保 _openid 写入（建立后续 writeSeam 所需归属不变量）
      const ws = writeSeam(db, openid)
      const updateData = { last_login_at: now, _openid: openid, updated_at: now }
      // openid 字段为空时首次绑定（不覆盖已有 openid）
      if (!r.data[0].openid) updateData.openid = openid
      await db.collection('agents').doc(r.data[0]._id).update({ data: updateData })
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

  // S-3 修复：dev 登录守卫改用显式 IS_DEV 标志
  const { IS_DEV } = require('./_shared/config')
  if (!IS_DEV && event.devMode) return { code: 403, msg: 'dev 登录仅限开发环境' }

  if (event.code) return await phoneLogin(event.code, openid)
  if (event.devMode) return await devLogin(openid)
  return { code: 400, msg: '缺少登录code' }
}
