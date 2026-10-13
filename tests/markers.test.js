/**
 * markers 契约测试（架构审查候选 5）
 *
 * 背景：旧协议标记（[TOOL:]/[CARD:]/[INTENT]/{TOOL_INTENT:}）清理此前是**人工镜像**——
 * 后端 `conversationAI/prompts.stripToolCardMarkers` 与前端 `miniprogram/utils/markers.cleanMarkers`
 * 各持一份正则、靠人工同步，且**已实际漂移**（前端缺 `{TOOL_INTENT:}` 规则 → 残留会漏给用户看）。
 * 现抽为跨树契约 `_shared/markers.js`，本测试锁三件事：
 *   1. 每条标记规则的行为（含前端曾漏的那条 —— 回归护栏）；
 *   2. 三处消费点（后端 prompts / 前端 utils / 契约源）行为同源；
 *   3. 前端副本与权威源**逐字一致**（分叉即失败，与 sync-shared --check 互为双保险）。
 */
const fs = require('fs')
const path = require('path')
const { cleanMarkers, stripToolCardMarkers, MARKER_TAGS } = require('../cloudfunctions/_shared/markers')
const { stripToolCardMarkers: backendStrip } = require('../cloudfunctions/conversationAI/prompts')
const feMarkers = require('../miniprogram/utils/markers')

describe('markers 契约：旧协议标记清理', () => {
  test('闭合标记整段删除（标记与其协议载荷一起丢）', () => {
    expect(cleanMarkers('前[TOOL:addFact]{"a":1}[/TOOL]后')).toBe('前后')
    expect(cleanMarkers('前[CARD:confirm]确认内容[/CARD]后')).toBe('前后')
  })

  test('残缺/单点标记只删标记本身，保留正文', () => {
    expect(cleanMarkers('前[TOOL:addFact]正文')).toBe('前正文')
    expect(cleanMarkers('前[/TOOL]后')).toBe('前后')
    expect(cleanMarkers('前[INTENT:write]后')).toBe('前后')
    expect(cleanMarkers('前[INTENT]后')).toBe('前后')
  })

  test('{TOOL_INTENT:...} 残留必须清掉（前端曾漏此规则 → 回归护栏）', () => {
    expect(cleanMarkers('前{TOOL_INTENT:"addFact"}后')).toBe('前后')
  })

  test('默认 trim；trim:false 保留首尾空白', () => {
    expect(cleanMarkers('  x  ')).toBe('x')
    expect(cleanMarkers('  x  ', { trim: false })).toBe('  x  ')
  })

  test('partial：未闭合标记起截断，且不 trim（流式在途，尾部空白有意义）', () => {
    expect(cleanMarkers('正文[TOOL:add', { partial: true })).toBe('正文')
    expect(cleanMarkers(' 正文[CARD:x', { partial: true })).toBe(' 正文')
    // 无未闭合标记时原样返回（不 trim）
    expect(cleanMarkers(' 正文 ', { partial: true })).toBe(' 正文 ')
  })

  test('空输入安全', () => {
    expect(cleanMarkers('')).toBe('')
    expect(cleanMarkers(null)).toBe('')
    expect(cleanMarkers(undefined)).toBe('')
  })
})

describe('markers 契约：消费点同源（防再次分叉）', () => {
  const SAMPLE = '前{TOOL_INTENT:"x"}[TOOL:a]载荷[/TOOL]中[INTENT:w]后'

  test('后端 prompts.stripToolCardMarkers 行为 == 契约源', () => {
    expect(backendStrip(SAMPLE)).toBe(cleanMarkers(SAMPLE))
    // 旧名是契约实现的转发（行为一致即可，跨目录副本故不断言引用相等）
    expect(backendStrip('  x  ')).toBe(stripToolCardMarkers('  x  '))
  })

  test('前端 utils/markers.cleanMarkers 行为 == 契约源（含前端曾漏的 {TOOL_INTENT:}）', () => {
    expect(feMarkers.cleanMarkers(SAMPLE)).toBe(cleanMarkers(SAMPLE))
    expect(feMarkers.cleanMarkers('前{TOOL_INTENT:"addFact"}后')).toBe('前后')
  })

  test('前端副本与权威源逐字一致（分叉即失败）', () => {
    const authority = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', '_shared', 'markers.js'), 'utf-8')
    const copy = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'markers.js'), 'utf-8')
    expect(copy).toBe(authority)
  })

  test('MARKER_TAGS 是 partial 截断锚点的派生来源（新增标记只改一处）', () => {
    expect(MARKER_TAGS).toEqual(['TOOL', 'CARD', 'INTENT'])
    // 每个 tag 都参与 partial 锚点匹配
    for (const tag of MARKER_TAGS) {
      expect(cleanMarkers('正文[' + tag + ':x', { partial: true })).toBe('正文')
    }
  })
})
