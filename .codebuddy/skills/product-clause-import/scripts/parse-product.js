/**
 * parse-product.js — AI 概念化提取（产品条款导入 skill）
 * 用法：node scripts/parse-product.js <text-file> --name <产品名> [--category 重疾|医疗|寿险|意外] [--out out.json]
 * 依赖环境变量 DEEPSEEK_API_KEY；输出经 lib/schema-validate.js 校验（null 不编造）。
 * 产物 status='parsing'，人工确认后（经 cloudbase 写入 products 时）置 confirmed + confirm_log。
 */
const fs = require('fs')
const path = require('path')
const { CONCEPT_DICT } = require('../lib/concept-dict')
const { validateProduct } = require('../lib/schema-validate')

const API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions'
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
const MAX_TEXT_CHARS = 20000 // 条款文本截断上限（长条款分块聚合为后续版本，v1 取前 2 万字符）

async function main() {
  const args = process.argv.slice(2)
  const input = args.find(a => !a.startsWith('--'))
  const nameIdx = args.indexOf('--name'); const name = nameIdx > -1 ? args[nameIdx + 1] : ''
  const catIdx = args.indexOf('--category'); const category = catIdx > -1 ? args[catIdx + 1] : ''
  const outIdx = args.indexOf('--out'); const out = outIdx > -1 ? args[outIdx + 1] : null
  const apiKey = process.env.DEEPSEEK_API_KEY

  if (!input || !name) {
    console.error('用法: node scripts/parse-product.js <text-file> --name <产品名> [--category 重疾|医疗|寿险|意外] [--out out.json]')
    process.exit(1)
  }
  if (!apiKey) { console.error('缺少 DEEPSEEK_API_KEY 环境变量'); process.exit(1) }

  const text = fs.readFileSync(input, 'utf8').trim()
  if (!text) { console.error('条款文本为空'); process.exit(1) }

  // 概念字典：指定险种用该险种概念，未指定则全量合并（AI 按条款内容取舍）
  const dict = category && CONCEPT_DICT.categories[category]
    ? CONCEPT_DICT.categories[category].concepts
    : Object.assign({}, ...Object.values(CONCEPT_DICT.categories).map(c => c.concepts))

  const system = '你是保险条款分析助手。从条款文本中提取概念，仅输出 JSON（纯对象，无注释）。' +
    '硬规则：1) 条款中未找到的概念必须输出 null，禁止凭产品常识补值；2) 只输出概念字典中的键，不得额外发明字段；' +
    '3) 数值保留单位；4) 存在/不存在类概念用 true/false。概念字典：' + JSON.stringify(dict)

  console.log('AI 概念化:', name, '(' + (category || '自动识别险种') + ')', '文本 ' + text.length + ' 字符')
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: '产品：' + name + '\n条款文本：\n' + text.substring(0, MAX_TEXT_CHARS) }
      ],
      max_tokens: 2000,
      temperature: 0
    })
  })
  if (!res.ok) { console.error('AI 调用失败 HTTP ' + res.status + ': ' + (await res.text()).substring(0, 300)); process.exit(1) }
  const j = await res.json()
  const content = (j.choices && j.choices[0] && j.choices[0].message.content) || ''
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) { console.error('AI 未输出 JSON'); process.exit(1) }

  let product
  try { product = JSON.parse(jsonMatch[0]) } catch (e) { console.error('JSON 解析失败:', e.message); process.exit(1) }
  const v = validateProduct(product)
  if (!v.valid) { console.error('校验失败:', v.errors.join('; ')); process.exit(1) }
  if (v.unrecognized.length) console.warn('WARN 未识别概念（请人工补录回写 concept-dict）:', v.unrecognized.join(', '))

  const finalJson = {
    product_name: name,
    category: category || 'unknown',
    schema_version: CONCEPT_DICT.schema_version,
    liability: product,
    status: 'parsing', // 人工确认后置 confirmed + confirm_log + source.url（写库时由 cloudbase 完成）
    parsed_at: new Date().toISOString()
  }
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(finalJson, null, 2), 'utf8')
    console.log('OK ->', out)
  } else {
    console.log(JSON.stringify(finalJson, null, 2))
  }
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1) })
