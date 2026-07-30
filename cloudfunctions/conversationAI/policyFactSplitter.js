/**
 * policyFactSplitter — 将对话自由文本中的保障描述拆为结构化三元组（facts）。
 *
 * 架构审计第 13 轮候选 #1：从 conversationAI/_shared/ 迁移至顶级目录。
 *   原因：仅 conversationAI/tool-orchestration.js 引用，单调用方不应占用 _shared 心智模型，
 *   且权威源 cloudfunctions/_shared/policyFactSplitter.js 已不存在，副本属于"伪共享残留"。
 *
 * 与 policyToFacts 的区别（C1）：
 *   - policyToFacts：输入结构化保单文档（addPolicy 已解析的字段），输出封闭谓词
 *   - policyFactSplitter：输入对话自由文本（如"我有重疾险50万，还有医疗险"），规则预拆分
 *
 * C2：纯规则拆不开的无分隔口语，保持原样并降一档 confidence，不强行拆错。
 * 本函数只做规则预提取，不写库；结果仅供 conversationAI 的 AI 工具调用参考。
 */
const COVERAGE_CATS = [
  ['重疾', '重疾险'], ['重大疾', '重疾险'],
  ['医疗', '医疗险'], ['住院', '医疗险'],
  ['寿险', '寿险'], ['定期寿', '寿险'], ['终身寿', '寿险'],
  ['意外', '意外险'],
  ['年金', '年金险'], ['养老', '年金险'],
  ['防癌', '防癌险'],
  ['护理', '护理险'],
  ['教育金', '教育金'], ['教育', '教育金']
]

function _matchCat(text) {
  for (const [kw, cat] of COVERAGE_CATS) {
    if (text.indexOf(kw) !== -1) return cat
  }
  return ''
}

function _extractAmount(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(万|万元|w|元|块)/)
  if (!m) return ''
  const num = m[1]
  const unit = m[2]
  return (unit === '万' || unit === '万元' || unit === 'w') ? num + '万' : num + '元'
}

function splitCoverageText(text, opts = {}) {
  if (!text || typeof text !== 'string') return []
  const baseConf = (typeof opts.confidence === 'number') ? opts.confidence : 0.9
  const isCompany = /(公司|单位|团险|团体|雇主|企业)/.test(text)
  const predicate = isCompany ? '公司提供保障' : '拥有保障'

  const segs = text
    .split(/[，,；;、\n]+|(?:\s*和\s*)|(?:以及)|(?:还有)|(?:另外)|(?:加上)|(?:\s*及\s*)/)
    .map(s => s.trim())
    .filter(Boolean)

  const facts = []
  const seen = {}

  if (segs.length <= 1) {
    // C2：无分隔口语（单块）——能识别险种则整块成一条；识别不出则保持原样降一档
    const cat = _matchCat(text)
    const amount = _extractAmount(text)
    if (cat) {
      facts.push({ predicate, objectValue: amount ? `${cat},保额${amount}` : cat, confidence: baseConf })
    } else {
      facts.push({ predicate, objectValue: text, confidence: Math.max(0.5, baseConf - 0.2) })
    }
    return facts
  }

  for (const seg of segs) {
    const cat = _matchCat(seg)
    if (!cat) continue
    const amount = _extractAmount(seg)
    const ov = amount ? `${cat},保额${amount}` : cat
    if (seen[ov]) continue
    seen[ov] = true
    facts.push({ predicate, objectValue: ov, confidence: baseConf })
  }

  // C2：规则完全没拆出任何块，保持原样降一档（不拆错）
  if (facts.length === 0) {
    facts.push({ predicate, objectValue: text, confidence: Math.max(0.5, baseConf - 0.2) })
  }
  return facts
}

module.exports = { splitCoverageText, policyFactSplitter: splitCoverageText }
