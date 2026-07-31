/**
 * index.js — utils/report barrel export
 *
 * 拆分后的报告构建模块入口。为保持向后兼容，
 * report-builder.js 直接桥接到此文件。
 */

var { buildGaps, buildGapMatrix, buildCoverageMatrix } = require('./gap-engine')
var { buildTimeline, parseMilestonesToTimeline } = require('./timeline-builder')
var { buildChapters, buildConfidenceAlerts } = require('./chapter-builder')
var { normalizeFamilyData, createNumbering } = require('./data-normalizer')

module.exports = {
  buildChapters: buildChapters,
  buildGaps: buildGaps,
  buildGapMatrix: buildGapMatrix,
  buildCoverageMatrix: buildCoverageMatrix,
  buildConfidenceAlerts: buildConfidenceAlerts,
  buildTimeline: buildTimeline,
  parseMilestonesToTimeline: parseMilestonesToTimeline,
  normalizeFamilyData: normalizeFamilyData,
  createNumbering: createNumbering
}
