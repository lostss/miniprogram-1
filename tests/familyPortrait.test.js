/**
 * familyPortrait compact 渲染测试
 * 覆盖：保费/生效日注入、截断分档（≤4 完整摘要 / >4 全保单名）
 */

const { buildPortrait, renderPortraitMarkdown } = require('../cloudfunctions/_shared/familyPortrait')

// 构造最小画像（直接走 buildPortrait 的输入形状：members + facts）
function makePortrait(facts) {
  const members = [
    { member_id: 'm1', name: '李阳勇', role: '本人', birth_date: '1990-06-15', status: 'active' }
  ]
  return buildPortrait(members, facts)
}

// facts 三元组（policy 节点属性 + 成员边；buildPortrait 读取 snake_case + status:active）
function policyFacts(id, attrs) {
  const ref = `${attrs['产品名']}(${id.slice(-6)})`
  const out = [
    { subject_type: 'member', subject_id: 'm1', subject_name: '李阳勇', predicate: '拥有保障', object_type: 'policy', object_id: id, object_value: ref, source: 'ocr', confidence: 0.9, status: 'active' },
    { subject_type: 'policy', subject_id: id, subject_name: ref, predicate: '险种', object_type: 'literal', object_value: attrs['险种'], source: 'ocr', confidence: 0.9, status: 'active' }
  ]
  if (attrs['保额']) out.push({ subject_type: 'policy', subject_id: id, subject_name: ref, predicate: '保额', object_type: 'literal', object_value: attrs['保额'], source: 'ocr', confidence: 0.9, status: 'active' })
  if (attrs['年缴保费']) out.push({ subject_type: 'policy', subject_id: id, subject_name: ref, predicate: '年缴保费', object_type: 'literal', object_value: attrs['年缴保费'], source: 'ocr', confidence: 0.9, status: 'active' })
  if (attrs['生效日']) out.push({ subject_type: 'policy', subject_id: id, subject_name: ref, predicate: '生效日', object_type: 'literal', object_value: attrs['生效日'], source: 'ocr', confidence: 0.9, status: 'active' })
  return out
}

describe('renderPortraitMarkdown compact 渲染', () => {

  test('≤4 份保单：完整摘要含保费/生效日', () => {
    const facts = policyFacts('pol_1', { '产品名': '平安福', '险种': '重疾', '保额': '50万', '年缴保费': '8000元', '生效日': '2024-01-15' })
    const portrait = makePortrait(facts)
    const md = renderPortraitMarkdown(portrait, { compact: true })
    expect(md).toContain('平安福')
    expect(md).toContain('重疾')
    expect(md).toContain('50万')
    expect(md).toContain('保费8000元')
    expect(md).toContain('生效2024-01-15')
  })

  test('>4 份保单：列出全部保单名，不截断', () => {
    let facts = []
    for (let i = 1; i <= 6; i++) {
      facts = facts.concat(policyFacts(`pol_${i}`, { '产品名': `保单${i}号`, '险种': '重疾' }))
    }
    const portrait = makePortrait(facts)
    const md = renderPortraitMarkdown(portrait, { compact: true })
    expect(md).toContain('已有保障（6份）')
    for (let i = 1; i <= 6; i++) expect(md).toContain(`保单${i}号`)
  })

  test('无保费/生效日：不输出空占位', () => {
    const facts = policyFacts('pol_1', { '产品名': '守护者', '险种': '意外' })
    const portrait = makePortrait(facts)
    const md = renderPortraitMarkdown(portrait, { compact: true })
    expect(md).toContain('守护者(pol_1)(意外,待确认,有效)')
    expect(md).not.toContain('保费,')
    expect(md).not.toContain('生效,')
  })

})
