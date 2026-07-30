/**
 * timeline-builder.js — 保障关键时点时间轴构建
 *
 * 从 report-builder.js 抽取：_buildTimeline, _parseMilestonesToTimeline, _parseExpiryYear。
 * 纯计算模块，不依赖 AI，可独立单测。
 */

var _parseExpiry = null
function _loadExpiry() {
  if (!_parseExpiry) _parseExpiry = require('../parse-expiry').parseExpiry
}

/**
 * 解析 insurance_period 为到期年份（null=无明确到期年/终身）
 */
function parseExpiryYear(period, startY) {
  _loadExpiry()
  if (!period) return null
  var eff = startY ? new Date(String(startY) + '-01-01') : null
  var r = _parseExpiry(period, eff, 0)
  if (/终身|长期/.test(period)) return null
  return r.year
}

/**
 * 构建保障关键时点时间轴数据
 * @param {array} policies
 * @param {array} members
 * @returns {array} [{ y, label, type, m?, soon? }]
 */
function buildTimeline(policies, members) {
  var now = new Date()
  var thisYear = now.getFullYear()
  var thisMonth = now.getMonth()
  var events = []

  for (var i = 0; i < policies.length; i++) {
    var p = policies[i]
    var eff = p.contract_effective_date || p.effective_date || ''
    if (!eff) continue
    var startY = new Date(eff).getFullYear()
    var startM = new Date(eff).getMonth()
    if (isNaN(startY)) continue

    var name = p.insured_name || '--'

    // 保障到期
    var endY = parseExpiryYear(p.insurance_period, startY)
    if (endY && endY > thisYear) {
      events.push({ y: endY, label: p.product_name + '（' + name + '）到期', type: 'expiry' })
    }

    // 缴费期满
    if (p.payment_period) {
      var payEnd = parseExpiryYear(p.payment_period, startY)
      if (payEnd && payEnd > thisYear) {
        events.push({ y: payEnd, label: p.product_name + '（' + name + '）缴完', type: 'paydone' })
      }
    }

    // 每年缴费月（未来12个月内的）
    for (var m = 0; m < 12; m++) {
      var d = new Date(thisYear, thisMonth + m, 1)
      var yr = d.getFullYear()
      var mo = d.getMonth()
      if (mo === startM && (yr > thisYear || (yr === thisYear && mo >= thisMonth))) {
        events.push({
          y: yr,
          label: p.product_name + '（' + name + '）缴费 · ' + (p.annual_premium || 0) + '元',
          type: 'payment',
          m: mo
        })
      }
    }
  }

  // 去重排序
  events.sort(function(a, b) {
    return a.y - b.y || a.type.localeCompare(b.type) || a.label.localeCompare(b.label)
  })
  var merged = []
  for (var j = 0; j < events.length; j++) {
    var e = events[j]
    var last = merged[merged.length - 1]
    if (last && last.y === e.y && last.type === e.type && last.label === e.label) continue
    merged.push(e)
  }

  // 标记30天内的缴费事件
  var soonCut = new Date()
  soonCut.setDate(soonCut.getDate() + 30)
  var monthStart = new Date(thisYear, thisMonth, 1)
  return merged.map(function(e) {
    var soon = e.type === 'payment' && e.m !== undefined && (function() {
      var pd = new Date(thisYear, e.m, 1)
      return pd >= monthStart && pd <= soonCut
    })()
    return { y: e.y, label: e.label, type: e.type, m: e.m, soon: soon }
  })
}

/**
 * 从 AI milestones 表格提取时间轴数据（保单字段不支持时降级使用）
 */
function parseMilestonesToTimeline(md) {
  var text = String(md || '')
  if (!text) return []
  var events = []
  var lines = text.split('\n')
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var m = line.match(/^\|\s*(\d+年|现在)\s*\|\s*(.+?)\s*\|/)
    if (!m) continue
    if (m[1] === '现在') continue
    var y = parseInt(m[1], 10)
    if (isNaN(y)) continue
    var rawLabel = (m[2] || '').replace(/\[|\]/g, '').trim()
    if (!rawLabel) continue
    var type = /缴费|缴完|续保|保费/.test(rawLabel) ? 'payment'
      : /领取|返还|派发/.test(rawLabel) ? 'paydone'
      : 'expiry'
    events.push({ y: y, label: rawLabel, type: type })
  }
  events.sort(function(a, b) { return a.y - b.y })
  return events
}

module.exports = { buildTimeline, parseMilestonesToTimeline }
