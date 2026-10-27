/**
 * 异常与待核验清单 A1–A6（2026-10-21）
 *
 * 定位：**化验单**只列"基于保单基本信息可核对的事实与提示"，不下诊断、不给建议。
 * 编号固定（A1–A6），因为 AI 导读与顾问面谈要能引用具体编号（"见 A3"）。
 * 某一类本次为空时**不出现**（不制造空标题），但编号不重排 —— 缺号即"本次无此事项"。
 *
 * 各条的事实来源（都必须有字段支撑，没有字段的项宁可不出现）：
 *   A1 非正常状态保单 —— status ≠ active（状态标签见 policy-status）
 *   A2 受益人为法定   —— beneficiary_name 含「法定」
 *   A3 受益人待核验   —— beneficiary_name 为空（不是"法定"，是没读到/没填）
 *   A4 除外承保标记   —— 需要手动标记字段（当前数据模型**没有**）→ 恒为空，不猜
 *   A5 未来 2 年内到期的长期险 —— 非终身、非一年期，止期落在 [今天, 今天+24 个月]
 *   A6 短期险续保日临近 —— 一年期产品且止期 ≤ 60 天（这是**提示**，不是风险判定）
 *
 * ⚠️ 2026-10-22：本文件已升为跨树契约（_shared），页面与 PDF 共用同一份 ——
 * 之前只在 miniprogram/utils/report 下，PDF 无从引用，导致纸上没有 A1–A6。
 *
 * 附加险：并入主险条目里表述（"含附加 N 项"），不单独占一行 —— 同一份合同的两个状态
 * 分开列会让"份数"看起来对不上。
 */
const { STATUS_LABELS, isOneYearPolicy, isLifetimeTerm } = require('./policy-status')
const { coverTermYear } = require('./policy-terms')

const DAY = 24 * 3600 * 1000

function _s(v) { return String(v == null ? '' : v).trim() }

/** 止期：优先 contract_end_date；否则从保险期间原文里取「至YYYY-MM-DD / 至YYYY年MM月DD日」 */
function parseEndDate(p) {
  const raw = _s(p && p.contract_end_date)
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw.slice(0, 10) + 'T00:00:00')
    if (!isNaN(d.getTime())) return d
  }
  const txt = _s(p && p.insurance_period)
  const m = txt.match(/至\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    if (!isNaN(d.getTime())) return d
  }
  return null
}

function _memberName(p) { return _s(p && p.insured_name) || '未指定被保人' }

function buildAnomalies(input) {
  const src = input || {}
  // items 应已由 rider-link 标注（isRider/parentKey/riderCount）；未标注时按普通条目处理
  const list = (src.policies || []).filter(function(p) { return p && p.status !== 'deleted' })
  const now = src.now instanceof Date ? src.now : new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const in24m = new Date(today.getTime() + 730 * DAY)

  // 附加险不单列：把它的名字挂到主险那条的 detail 上
  const riderNamesOf = {}
  list.forEach(function(p) {
    if (p && p.isRider && p.parentKey) {
      if (!riderNamesOf[p.parentKey]) riderNamesOf[p.parentKey] = []
      riderNamesOf[p.parentKey].push(_s(p.product_name))
    }
  })
  const mainList = list.filter(function(p) { return !(p.isRider && p.parentKey) })
  const riderSuffix = function(p) {
    const names = riderNamesOf[p && (p.id || p._id)] || []
    return names.length ? '（含附加 ' + names.length + ' 项）' : ''
  }

  const groups = []

  // A1 非正常状态保单
  const a1 = mainList.filter(function(p) { return _s(p.status) && _s(p.status) !== 'active' })
  if (a1.length) {
    groups.push({
      code: 'A1', title: '非正常状态保单', count: a1.length,
      items: a1.map(function(p) {
        return {
          policyId: _s(p.id || p._id), member: _memberName(p),
          product: _s(p.product_name) || '未命名保单',
          detail: (STATUS_LABELS[p.status] || _s(p.status)) + riderSuffix(p)
        }
      })
    })
  }

  // A2 受益人为法定
  const a2 = mainList.filter(function(p) { return /法定/.test(_s(p.beneficiary_name)) })
  if (a2.length) {
    groups.push({
      code: 'A2', title: '受益人为法定', count: a2.length,
      items: a2.map(function(p) {
        return { policyId: _s(p.id || p._id), member: _memberName(p), product: _s(p.product_name) || '未命名保单', detail: '受益人：' + _s(p.beneficiary_name) }
      })
    })
  }

  // A3 受益人待核验（没读到受益人，不是"法定"）
  // 2026-10-27（方案 A3 原义）：判据从"姓名为空"升级为**受益比例**。
  // 方案要的是"受益人比例缺失"，而姓名空只是其中一种情形（还有"填了名字但没填比例"）。
  // 两种情况都进 A3，但 detail 分开写 —— "没填受益人"与"填了但没填比例"对用户是两个动作。
  const _ratioOf = function(p) { var v = Number(p && p.beneficiary_ratio); return isNaN(v) ? null : v }
  // 2026-10-27（按方案字面收口）：A3 = 受益人**比例**缺失。
  // 三种情形都算：没有受益人、比例非法（≤0 / >100）、比例未采集。
  // 但"未采集"往往一次几十份（OCR 不采该字段）→ **聚合成一条**，否则 A1/A2 会被淹掉。
  // 计数仍按份数（count 反映真实问题量），只是明细不逐条铺开。
  const a3Hard = []       // 逐条列：没受益人 / 比例非法
  const a3Uncollected = [] // 聚合：比例未采集
  mainList.forEach(function(p) {
    if (_s(p.status) !== 'active') return
    if (!_s(p.beneficiary_name)) { a3Hard.push(p); return }
    var r = _ratioOf(p)
    if (r === null) { a3Uncollected.push(p); return }
    if (r <= 0 || r > 100) a3Hard.push(p)
  })
  const a3Count = a3Hard.length + a3Uncollected.length
  if (a3Count > 0) {
    var a3Items = a3Hard.map(function(p) {
      var hasName = !!_s(p.beneficiary_name)
      var r = _ratioOf(p)
      var detail = !hasName ? '保单未记录受益人' : ('受益比例 ' + r + '%（应在 1–100%）')
      return { policyId: _s(p.id || p._id), member: _memberName(p), product: _s(p.product_name) || '未命名保单', detail: detail }
    })
    if (a3Uncollected.length) {
      var names = {}
      a3Uncollected.forEach(function(p) { names[_memberName(p)] = 1 })
      a3Items.push({
        policyId: '',
        member: Object.keys(names).join('、') || '—',
        product: '',
        detail: '共 ' + a3Uncollected.length + ' 份未采集受益比例（可在保单卡片补充，补录后可核对是否为 100%）'
      })
    }
    groups.push({ code: 'A3', title: '受益人待核验', count: a3Count, items: a3Items })
  }

  // A4 除外承保标记：数据模型里没有这个字段（需用户手动标记，属后续能力）→ 恒为空。
  // 留一个显式判断而不是删掉编号：将来加了字段（exclusion_marked）这里自动生效，
  // 且"缺号"这件事在注释与测试里都是明确的，不会被误读成"漏实现"。
  const a4 = mainList.filter(function(p) { return p && p.exclusion_marked === true })
  if (a4.length) {
    groups.push({
      code: 'A4', title: '除外承保标记', count: a4.length,
      items: a4.map(function(p) {
        return { policyId: _s(p.id || p._id), member: _memberName(p), product: _s(p.product_name) || '未命名保单', detail: _s(p.exclusion_note) || '已标记除外承保' }
      })
    })
  }

  // A5 未来 2 年内到期的长期险（非终身、非一年期）
  const a5 = []
  mainList.forEach(function(p) {
    if (isLifetimeTerm(p && p.coverage_term)) return
    if (isOneYearPolicy(p)) return
    const end = parseEndDate(p)
    if (end) {
      if (end >= today && end <= in24m) {
        a5.push({ p: p, when: end, text: end.getFullYear() + '-' + String(end.getMonth() + 1).padStart(2, '0') })
      }
      return
    }
    // 只有年份可用时：本年度或下一年度才算"未来 2 年内"（不猜具体日期）
    const startY = Number(String(_s(p && (p.effective_date || p.contract_effective_date))).slice(0, 4))
    if (!startY) return
    const endY = coverTermYear(p, startY, src.ageByName ? src.ageByName[_memberName(p)] || 0 : 0)
    if (endY && endY >= now.getFullYear() && endY <= now.getFullYear() + 1) {
      a5.push({ p: p, when: null, text: endY + ' 年' })
    }
  })
  if (a5.length) {
    groups.push({
      code: 'A5', title: '两年内到期的长期险', count: a5.length,
      items: a5.map(function(x) {
        return { policyId: _s(x.p.id || x.p._id), member: _memberName(x.p), product: _s(x.p.product_name) || '未命名保单', detail: '保障止于 ' + x.text + riderSuffix(x.p) }
      })
    })
  }

  // A6 短期险续保日临近（提示；60 天以内才列，避免一年期保单常年霸占清单）
  const a6 = []
  mainList.forEach(function(p) {
    if (!isOneYearPolicy(p)) return
    const end = parseEndDate(p)
    if (!end) return
    const days = Math.round((end.getTime() - today.getTime()) / DAY)
    if (days < 0 || days > 60) return
    a6.push({ p: p, days: days, end: end })
  })
  if (a6.length) {
    groups.push({
      code: 'A6', title: '短期险续保日临近（提示）', count: a6.length,
      items: a6.map(function(x) {
        return {
          policyId: _s(x.p.id || x.p._id), member: _memberName(x.p), product: _s(x.p.product_name) || '未命名保单',
          detail: x.end.getFullYear() + '-' + String(x.end.getMonth() + 1).padStart(2, '0') + '-' + String(x.end.getDate()).padStart(2, '0') + ' 到期（' + x.days + ' 天），续保状态需向保司核对'
        }
      })
    })
  }

  return groups
}

module.exports = { buildAnomalies, parseEndDate }
