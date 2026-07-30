// ponytail: 见 _shared/createHandler.js
const createHandler = require('./_shared/createHandler')
const handlers = require('./handlers')
exports.main = createHandler(handlers, '查询')
