/**
 * OCR 现价表同图绑定 + 页脚残表确定性判据（2026-09-12）
 *
 * 1) 同图绑定：mixed 图（保单正页 + 现价表同屏）提取的现价表携带 from_policy（来源保单键），
 *    供 dataWrite/cash-value-matcher 优先直连该保单；纯现价表图不携带。
 * 2) 页脚残表判据：AI 的"年度自 1 起连续 ≥5 行"对保单页脚残留现价表失效，
 *    此处用 OCR 文本自带的 y 坐标（ocr-extractor._buildLayoutText 输出 `y<num>|x:文本|…`）
 *    复核标题纵向位置，仅在「标题落入页脚区 + 表行数偏少」时否决。
 */
const { extractOne } = require('../cloudfunctions/ocrService/_shared/ocr-core')

function buildExtract(documentType, cashValues) {
  return {
    result: 'success',
    document_type: documentType,
    data: {
      contract_basic: { policy_number: 'P1', insurance_company: '安心人寿', insured_name: '李阳勇' },
      products: [{ product_name: '安心保臻选版定期重大疾病保险', insurance_category: '重疾', sum_assured: 500000, annual_premium: 1830 }],
      field_confidence: { product_name: 0.95 },
      overall_confidence: 0.9
    },
    cash_value_data: cashValues ? { header_info: {}, cash_values: cashValues, overall_confidence: 0.9 } : undefined
  }
}

const cv5 = () => [1, 2, 3, 4, 5].map(y => ({ y, v: y * 100 }))
const cv15 = () => Array.from({ length: 15 }, (_, i) => ({ y: i + 1, v: (i + 1) * 100 }))

/** 构造带坐标的 OCR 文本（与 ocr-extractor._buildLayoutText 同构） */
function layout(rows) {
  return rows.map(r => 'y' + r.y + '|' + (r.x || 40) + ':' + r.text).join('\n')
}

describe('extractOne 同图绑定（mixed → from_policy）', function () {
  test('mixed：现价表携带来源保单键', function () {
    const ex = extractOne(buildExtract('mixed', cv5()), [], '')
    expect(ex.cashValueData).not.toBeNull()
    expect(ex.cashValueData.from_policy).toEqual({
      policy_number: 'P1',
      product_name: '安心保臻选版定期重大疾病保险',
      insured_name: '李阳勇'
    })
  })

  test('cash_value（纯现价表图）：无同图保单 → from_policy 为 null', function () {
    const ex = extractOne(buildExtract('cash_value', cv5()), [], '')
    expect(ex.cashValueData).not.toBeNull()
    expect(ex.cashValueData.from_policy).toBeNull()
  })
})

describe('extractOne 页脚残表确定性判据', function () {
  test('标题落在页脚（0.9）且行数少 → 否决并标记 footer_residue', function () {
    const cv = cv5()
    const text = layout([
      { y: 100, text: '保险单' },
      { y: 300, text: '投保人：李阳勇' },
      { y: 900, text: '现金价值表' }
    ].concat(cv.map((r, i) => ({ y: 920 + i * 10, text: r.y + '  ' + r.v }))))
    const ex = extractOne(buildExtract('mixed', cv), [], text)
    expect(ex.cashValueData).toBeNull()
    expect(ex.cashValueRejected).toBe('footer_residue')
    // docType 仍降级为 policy（同图以保单主体为主）
    expect(ex.docType).toBe('policy')
  })

  test('标题在页面中上部（0.04）→ 正常提取，不误杀', function () {
    const cv = cv5()
    const text = layout([
      { y: 40, text: '现金价值表' }
    ].concat(cv.map((r, i) => ({ y: 80 + i * 20, text: r.y + '  ' + r.v })))
      .concat([{ y: 1000, text: '备注：本表仅供参考' }]))
    const ex = extractOne(buildExtract('cash_value', cv), [], text)
    expect(ex.cashValueData).not.toBeNull()
    expect(ex.cashValueRejected).toBeNull()
  })

  test('标题在页脚但表行数 ≥12（后半页完整大表）→ 不判残留', function () {
    const cv = cv15()
    const text = layout([
      { y: 100, text: '保险单' },
      { y: 850, text: '现金价值表' }
    ].concat(cv.map((r, i) => ({ y: 870 + i * 5, text: r.y + '  ' + r.v })))
      .concat([{ y: 1000, text: '结束' }]))
    const ex = extractOne(buildExtract('mixed', cv), [], text)
    expect(ex.cashValueData).not.toBeNull()
    expect(ex.cashValueRejected).toBeNull()
  })

  test('OCR 文本无 y 坐标 → 判据不生效（保持历史行为）', function () {
    const cv = cv5()
    const ex = extractOne(buildExtract('cash_value', cv), [], '现金价值表\n1  100\n2  200\n3  300')
    expect(ex.cashValueData).not.toBeNull()
    expect(ex.cashValueRejected).toBeNull()
  })

  test('年度不连续（<5 行/非连续）→ 沿用原有 incomplete 判定', function () {
    const ex = extractOne(buildExtract('cash_value', [{ y: 12, v: 100 }, { y: 13, v: 200 }]), [], '')
    expect(ex.cashValueData).toBeNull()
    expect(ex.cashValueRejected).toBe('incomplete')
  })
})
