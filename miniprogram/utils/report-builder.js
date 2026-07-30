/**
 * report-builder.js — 向后兼容 barrel
 *
 * 核心逻辑已拆分到 utils/report/ 各子模块：
 *   - data-normalizer.js  公共数据预处理
 *   - gap-engine.js       保障缺口计算
 *   - timeline-builder.js  时间轴构建
 *   - chapter-builder.js  章节编排
 *
 * 本文件负责 re-export + 保留未迁移的小型导出函数。
 */

var { buildChapters, buildGaps, buildGapMatrix, buildTimeline, parseMilestonesToTimeline } = require('./report/index')

/**
 * 根据报告数据生成追问建议
 */
function makeHints(report, family) {
  var h = []
  if (report.hints && report.hints.length > 0) {
    for (var i = 0; i < report.hints.length; i++) {
      if (report.hints[i] && report.hints[i].text) {
        h.push({ text: report.hints[i].text, q: report.hints[i].q || report.hints[i].text })
      }
    }
  }
  return h
}

/**
 * 评估数据完整度（返回结构化对象以兼容旧调用方）
 */
function assessDataCompleteness(family) {
  var members = (family && family.members) || []
  var items = []
  var okCount = 0; var totalCount = 0
  function _check(name, ok, hint) { items.push({ name: name, ok: ok, hint: hint || '' }); if (ok) okCount++; totalCount++ }

  _check('家庭成员', members.length > 0, members.length === 0 ? '请添加至少一个家庭成员' : '')
  var hasPolicy = (family && family.policies && family.policies.length > 0)
  _check('保单', hasPolicy, hasPolicy ? '' : '请导入至少一份保单')

  // 按成员检查（兼容旧测试：name = '年收入' 不带成员名前缀）
  var hasIncome = members.some(function(m) { return m.income > 0 }) || parseInt(family && family.family_income) > 0
  _check('年收入', hasIncome, hasIncome ? '' : '收入缺失将影响寿险/意外险缺口计算')
  var hasBirth = members.some(function(m) { return !!m.birth_date })
  _check('出生日期', hasBirth, hasBirth ? '' : '用于判断年龄阶段（成年/老年）')
  var hasRole = members.some(function(m) { return !!m.role })
  _check('角色身份', hasRole, hasRole ? '' : '角色决定保险需求类型（本人/配偶/子女/父母）')

  var completePercent = totalCount > 0 ? Math.min(100, Math.round(okCount / totalCount * 100)) : 0
  return { complete: okCount === totalCount, items: items }
}

/**
 * 计算报告元信息
 */
function computeReportMeta(family) {
  var d = new Date()
  var dateStr = d.getFullYear() + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + ('0' + d.getDate()).slice(-2)
  return { date: dateStr, no: (family.report_no || ''), version: family.report_version || 1 }
}

module.exports = {
  buildChapters: buildChapters,
  buildGaps: buildGaps,
  buildGapMatrix: buildGapMatrix,
  buildTimeline: buildTimeline,
  parseMilestonesToTimeline: parseMilestonesToTimeline,
  makeHints: makeHints,
  assessDataCompleteness: assessDataCompleteness,
  computeReportMeta: computeReportMeta
}
