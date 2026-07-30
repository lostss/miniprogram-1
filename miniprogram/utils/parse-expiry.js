/**
 * parse-expiry.js — 保障期文本解析（权威源，前后端共用）
 *
 * 纯函数，不依赖任何配置，可在小程序环境和云函数运行时使用。
 * 前端：miniprogram/utils/parse-expiry.js（由 sync-shared.js CONTRACT_FILES 同步）
 * 后端：cloudfunctions/_shared/parse-expiry.js（闭包式同步到各云函数）
 *
 * 支持格式：
 *   - 「至70岁」「保障至70周岁」(需传 age)
 *   - 「终身」「长期」
 *   - 「至2045-12-31」「2049年12月17日」「至2026年03月19日」
 *   - 「30年」「20年」
 *   - 「至YYYY」
 */

/**
 * 解析保障期文本 → 到期年份/日期
 * @param {string} insurancePeriod - 保障期文本
 * @param {string} effectiveDate - 生效日期（ISO/日期字符串）
 * @param {number} [age=0] - 被保人年龄（仅 "至N岁" 格式需要）
 * @returns {{ year: number|null, date: Date|null, label: string }}
 */
function parseExpiry(insurancePeriod, effectiveDate, age) {
  var text = (insurancePeriod || '').trim()
  if (!text) return { year: null, date: null, label: '未知' }

  var eff = effectiveDate ? new Date(effectiveDate) : new Date()
  if (isNaN(eff.getTime())) return { year: null, date: null, label: text }

  var insuredAge = age || 0

  // 「至70岁」「保障至70周岁」— age 为被保人当前周岁，推算出生年再得期年
  var ageMatch = text.match(/至\s*(\d+)\s*[岁周岁]/)
  if (ageMatch && insuredAge > 0) {
    var targetAge = parseInt(ageMatch[1], 10)
    var birthYear = new Date().getFullYear() - insuredAge
    var yr = birthYear + targetAge
    return { year: yr, date: new Date(yr, 11, 31), label: '至' + targetAge + '岁' }
  }

  // 「终身」「长期」
  if (/终身|长期/.test(text)) {
    var lifetimeYr = eff.getFullYear() + 105 - (insuredAge || 30)
    return { year: lifetimeYr, date: new Date(lifetimeYr, 11, 31), label: '长期' }
  }

  // 「至YYYY年MM月DD日…」(噪声期型，如"2025年03月20日零时起至2026年03月19日二十四时止")
  var rangeMatch = text.match(/至\s*(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (rangeMatch) {
    var ry = parseInt(rangeMatch[1], 10)
    var rm = parseInt(rangeMatch[2], 10) - 1
    var rd = parseInt(rangeMatch[3], 10)
    return { year: ry, date: new Date(ry, rm, rd), label: '至' + ry + '-' + (rm + 1) + '-' + rd }
  }

  // 「30年」「20年」— 数字+年（仅匹配纯数字+年，不含噪声前缀）
  var yearMatch = text.match(/^(\d+)\s*年/)
  if (yearMatch) {
    var ny = eff.getFullYear() + parseInt(yearMatch[1], 10)
    return { year: ny, date: new Date(ny, 11, 31), label: text }
  }

  // 「至2045-12-31」「2049年12月17日」— 直接日期（含月日，可精确比较）
  var dateMatch = text.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})/)
  if (dateMatch) {
    var dy = parseInt(dateMatch[1], 10)
    var dm = parseInt(dateMatch[2], 10) - 1
    var dd = parseInt(dateMatch[3], 10)
    return { year: dy, date: new Date(dy, dm, dd), label: text }
  }

  // 「至YYYY-MM-DD」或仅年份
  var yOnly = text.match(/至?\s*(\d{4})/)
  if (yOnly) {
    var yy = parseInt(yOnly[1], 10)
    return { year: yy, date: new Date(yy, 11, 31), label: text }
  }

  return { year: null, date: null, label: text }
}

module.exports = { parseExpiry }
