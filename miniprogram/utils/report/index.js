/**
 * index.js — utils/report barrel export
 *
 * 拆分后的报告构建模块入口。为保持向后兼容，
 * report-builder.js 直接桥接到此文件。
 */

var { buildGaps, buildCoverageMatrix } = require('./gap-engine')
var { buildTimeline } = require('./timeline-builder')
var { buildChapters } = require('./chapter-builder')
var { normalizeFamilyData } = require('./data-normalizer')

module.exports = {
  buildChapters: buildChapters,
  buildGaps: buildGaps,
  buildCoverageMatrix: buildCoverageMatrix,
  buildTimeline: buildTimeline,
  normalizeFamilyData: normalizeFamilyData
}
