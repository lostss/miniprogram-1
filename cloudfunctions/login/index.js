const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 架构审计第 17 轮候选 #2：agents 写入统一经 writeSeam 接缝
// （_openid 注入不变量 + updated_at 审计字段；agents 表不传 familyId，不触发 family 钩子）
const { writeSeam } = require('./_shared/writeSeam')

// 方案 A（个人主体）：openid 静默登录——微信唯一身份即账号，无需手机号授权。
// 背景：手机号快速验证组件仅对企业认证主体开放，个人主体不可用；且数据红线禁存手机号。
// 历史：原 phoneLogin/devLogin 双路径（S-4 守卫）随 devMode 概念一并移除。
async function upsertAgent(openid) {
  try {
    // 2026-09-11 修复：原查询强制 `_openid: openid` 匹配——历史文档缺 _openid 时查不到，
    // 会走"新建档案"分支 → 老用户的 token_used_monthly / role / plan 全部丢失（配额被重置）。
    // openid 来自 wxContext（可信唯一标识），先按 openid 精确查；命中则在更新时**补写**
    // _openid（既修复历史数据，又不放宽越权：openid 本身不可伪造）。
    // 并发首次登录仍可能极少量双建（根治需在 agents.openid 上建唯一索引，见部署说明）。
    const r = await db.collection('agents').where({ openid }).limit(1).get()
    const now = new Date()
    const ws = writeSeam(db, openid)
    if (r.data && r.data.length > 0) {
      // M-1 修复：登录 update 改走 writeSeam.silentUpdateDoc（已先校验 _openid 归属，符合接缝不变量）
      await ws.silentUpdateDoc('agents', r.data[0]._id, { last_login_at: now, _openid: openid })
      return { code: 200, msg: '登录成功', data: { openid, agent_id: r.data[0]._id, phone: r.data[0].phone || '', nickname: r.data[0].nickname, role: r.data[0].role, plan: r.data[0].plan } }
    }
    // 经 writeSeam.silentAdd：自动注入 _openid
    // 配额审计 P0-2：trial 30000 = 1 次完整报告（典型 8K）+ 4 轮对话（典型 5K×4）+ 2 张保单 OCR（典型 3K×2）。
    // 旧值 10000 < 单次 reportAI 上下文上限 12K——新用户首次完整报告即触发 QUOTA_LIMIT，配置即劝退
    const c = await ws.silentAdd('agents', { openid, nickname: '新用户', avatar_url: '', role: 'trial', plan: 'trial', token_monthly_limit: 30000, token_used_monthly: 0, token_used_total: 0, status: 'active', created_at: now, last_login_at: now })
    return { code: 200, msg: '登录成功', data: { openid, agent_id: c._id, phone: '', nickname: '新用户', role: 'trial', plan: 'trial' } }
  } catch (err) {
    console.error('[login] 失败:', err.message)
    return { code: 500, msg: '登录失败' }
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext && (wxContext.OPENID || wxContext.openId)
  if (!openid) return { code: 401, msg: '获取用户身份失败' }
  return await upsertAgent(openid)
}
