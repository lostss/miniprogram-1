/**
 * 图片 md5 缓存「接线」守卫（2026-10-18）
 *
 * 为什么只做接线断言、不做全链路用例：ocrExtract 的完整执行需要 mock 掉
 * operation_logs / agents / ocr_cache 三个集合 + OCR 供应商，成本远高于收益；
 * 而这条缓存的失败模式是**静默降级**（查询失败就走完整 OCR），
 * 真正的风险是"接线被删/传参没接上，缓存永远不命中却没人发现"。
 * 所以这里钉住三处关键接线，行为正确性交给上面的降级设计保证。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

describe('图片 md5 缓存接线', () => {
  test('前端：算 md5 并在 batchOCR 里按 fileId 下标传 hashes', () => {
    const flow = read('miniprogram/utils/ocr-flow.js')
    // wx.getFileInfo 的 digestAlgorithm，避免把图片读进 JS 内存
    expect(flow).toContain("digestAlgorithm: 'md5'")
    expect(flow).toMatch(/hashes\[i\]\s*=\s*h/)
    expect(flow).toContain('return { fileIds: fileIds, localPaths: localPaths, hashes: hashes')
    expect(flow).toMatch(/hashes: hashes\s*\}/) // 传给 ocrExtract
  })

  test('前端：上传结果按 fileIds 下标对齐地填 validHashes（错位会让缓存命中别人的图）', () => {
    const comp = read('miniprogram/components/ocr-flow/index.js')
    expect(comp).toContain('validHashes.push((upResult.hashes && upResult.hashes[i]) || \'\')')
    expect(comp).toContain('hashes: validHashes')
  })

  test('云端：读 ocr_cache 命中则跳过 OCR，未命中写回缓存，并记录 cacheHitCount', () => {
    const h = read('cloudfunctions/ocrService/handlers.js')
    expect(h).toContain("db.collection('ocr_cache')")
    expect(h).toContain('cacheHitCount')
    // 命中分支必须构造与 ocrPhase 同形的结果（否则下游 aiPhase 读不到 ocrText）
    expect(h).toContain('cached: true')
    // 查询失败必须降级为"不命中"，不能影响主链路
    expect(h).toMatch(/catch[\s\S]{0,200}降级为完整识别/)
  })

  test('只缓存 OCR 文本，不缓存 AI 结果（prompt/模型会变，缓存的保单会变脏数据）', () => {
    const h = read('cloudfunctions/ocrService/handlers.js')
    // 写入逻辑集中在 _writeOcrCache（首次部署自动建集合），断言 payload 只含 OCR 文本
    const idx = h.indexOf('function _writeOcrCache')
    expect(idx).toBeGreaterThan(-1)
    const block = h.slice(idx, idx + 620)
    expect(block).toContain('ocrText')
    expect(block).toContain('ocrConfInfo')
    expect(block).not.toContain('policies')
    expect(block).not.toContain('extractRes')
  })
})
