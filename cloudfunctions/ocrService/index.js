/**
 * ocrService 入口 — 薄路由，委托给 createHandler + handlers
 *
 * ponytail: 入口只做路由，逻辑在 handlers.js
 */
const createHandler = require('./_shared/createHandler')
const handlers = require('./handlers')

exports.main = createHandler(handlers, 'OCR')
