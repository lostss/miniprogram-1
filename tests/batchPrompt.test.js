/**
 * buildBatchExtractionPrompt 单元测试
 */
const { buildBatchExtractionPrompt, BATCH_SYSTEM_PROMPT } = require('../cloudfunctions/ocrService/prompts')

describe('buildBatchExtractionPrompt', () => {
  test('单张图：拼接格式正确，含【图片_1】标记', () => {
    const ocrResults = [
      { fileId: 'cloud://f1', ocrText: '投保人李阳勇', ocrConfInfo: [{ text: '投保人李阳勇', ocr_conf: 98 }] }
    ]
    const { systemPrompt, userPrompt } = buildBatchExtractionPrompt(ocrResults)
    expect(systemPrompt).toContain('JSON 数组')
    expect(systemPrompt).toContain('idx')
    expect(userPrompt).toContain('【图片_1】')
    expect(userPrompt).toContain('投保人李阳勇')
  })

  test('多张图：每张图都有独立的【图片_N】标记', () => {
    const ocrResults = [
      { fileId: 'cloud://f1', ocrText: '保单A', ocrConfInfo: [] },
      { fileId: 'cloud://f2', ocrText: '保单B', ocrConfInfo: [] },
      { fileId: 'cloud://f3', ocrText: '现价表C', ocrConfInfo: [] }
    ]
    const { userPrompt } = buildBatchExtractionPrompt(ocrResults)
    expect(userPrompt).toContain('【图片_1】')
    expect(userPrompt).toContain('【图片_2】')
    expect(userPrompt).toContain('【图片_3】')
    expect(userPrompt).toContain('保单A')
    expect(userPrompt).toContain('保单B')
    expect(userPrompt).toContain('现价表C')
  })

  test('置信度独立标注：每张图的置信度附在该图块下方（含高置信项，全保留）', () => {
    const ocrResults = [
      { fileId: 'cloud://f1', ocrText: 'text1', ocrConfInfo: [{ text: '张三', ocr_conf: 95 }] },
      { fileId: 'cloud://f2', ocrText: 'text2', ocrConfInfo: [{ text: '李四', ocr_conf: 88 }] }
    ]
    const { userPrompt } = buildBatchExtractionPrompt(ocrResults)
    expect(userPrompt).toContain('[图片_1 字符级置信度参考]')
    expect(userPrompt).toContain('[图片_2 字符级置信度参考]')
    expect(userPrompt).toContain('张三')
    expect(userPrompt).toContain('李四')
    // 全保留：高置信项（95/88）不被过滤
    expect(userPrompt).toContain('95%')
    expect(userPrompt).toContain('88%')
  })

  test('空 ocrConfInfo：显示无置信度信息', () => {
    const ocrResults = [
      { fileId: 'cloud://f1', ocrText: 'text', ocrConfInfo: [] }
    ]
    const { userPrompt } = buildBatchExtractionPrompt(ocrResults)
    expect(userPrompt).toContain('无字符级置信度信息')
  })

  test('systemPrompt 包含批量输出契约关键约束', () => {
    const { systemPrompt } = buildBatchExtractionPrompt([])
    expect(systemPrompt).toContain('JSON 数组')
    expect(systemPrompt).toContain('idx')
    expect(systemPrompt).toContain('单张图失败不影响其他图')
  })

  test('systemPrompt 包含输入特征说明（OCR表格语义还原）', () => {
    const { systemPrompt } = buildBatchExtractionPrompt([])
    expect(systemPrompt).toContain('输入特征')
    expect(systemPrompt).toContain('N 型排布')
    expect(systemPrompt).toContain('提取重点')
    expect(systemPrompt).toContain('保单号/保险合同号')
    expect(systemPrompt).toContain('换行或分页撕裂')
  })

  test('OCR 文本不截断：超长 ocrText 完整保留', () => {
    const longText = 'A'.repeat(5000)
    const ocrResults = [
      { fileId: 'cloud://f1', ocrText: longText, ocrConfInfo: [] }
    ]
    const { userPrompt } = buildBatchExtractionPrompt(ocrResults)
    // 不截断：5000 个 A 应全部保留
    const aCount = (userPrompt.match(/A/g) || []).length
    expect(aCount).toBe(5000)
  })
})
