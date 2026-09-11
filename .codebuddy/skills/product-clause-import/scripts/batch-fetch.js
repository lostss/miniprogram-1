/**
 * batch-fetch.js — 批量下载官方条款 PDF（product-clause-import skill）
 *
 * 用法：node scripts/batch-fetch.js
 * 产物：out/clauses/<产品名>.pdf（%PDF 魔数校验；失败打印 FAIL/NOTPDF 不中断）
 *
 * 用法说明：
 * 1. 新增产品 → 向 LIST 追加 { name, url }（url 须为官方利益条款直链，禁第三方转载）
 * 2. 下载后逐个 `node scripts/extract-pdf.js out/clauses/<name>.pdf --out out/clauses/<name>.txt`
 * 3. 概念化见 SKILL.md「批量建档」章节
 *
 * LIST 内含已验证样本（2026-08-27，新华人寿官方 CDN，8 产品 / 7 份条款，"华贵B(计划二)"共用华贵B条款）。
 */
const fs = require('fs')
const path = require('path')

const LIST = [
  // 重疾类
  { name: '多倍保障青少年重大疾病保险(A1款)', url: 'https://static-cdn.newchinalife.com/ncl/pdf/20191105/d6350b15-00fc-4859-81c6-c8fdfdf2e84d.pdf' },
  { name: '安立宝少儿重大疾病保险', url: 'https://static-cdn.newchinalife.com/ncl/pdf/20240428/666f0e39-8a51-4f2c-864a-c77e9781ba88.pdf' },
  { name: '康爱无忧A款恶性肿瘤疾病保险', url: 'https://static-cdn.newchinalife.com/ncl/%E5%BA%B7%E7%88%B1%E6%97%A0%E5%BF%A7A%E6%AC%BE%E6%81%B6%E6%80%A7%E8%82%BF%E7%98%A4%E7%96%BE%E7%97%85%E4%BF%9D%E9%99%A9_1544407811310.pdf' },
  { name: '附加特定心脑血管疾病保险', url: 'https://static-cdn.newchinalife.com/ncl/%E9%99%84%E5%8A%A0%E7%89%B9%E5%AE%9A%E5%BF%83%E8%84%91%E8%A1%80%E7%AE%A1%E7%96%BE%E7%97%85%E4%BF%9D%E9%99%A9_1545112191134.pdf' },
  // 医疗类
  { name: '康健华贵B款医疗保险', url: 'https://static-cdn.newchinalife.com/ncl/pdf/20200330/7bdd000b-f05f-441c-9ce3-e0e70bed094c.pdf' },
  { name: '康健华尊医疗保险', url: 'https://static-cdn.newchinalife.com/ncl/pdf/20230922/44564ee4-4054-4203-80a1-b730f32663ba.pdf' },
  { name: '附加住院补贴A款医疗保险', url: 'https://static-cdn.newchinalife.com/ncl/pdf/20220304/ad21e749-ee4f-42e5-be43-c101a7f45e5e.pdf' }
]

async function main() {
  const outDir = path.join(__dirname, '..', 'out', 'clauses')
  fs.mkdirSync(outDir, { recursive: true })
  for (const p of LIST) {
    try {
      const res = await fetch(p.url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.newchinalife.com/' }
      })
      if (!res.ok) { console.log('FAIL', p.name, res.status); continue }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 5 || buf.slice(0, 4).toString('latin1') !== '%PDF') { console.log('NOTPDF', p.name, buf.length); continue }
      const file = path.join(outDir, p.name.replace(/[\\/:*?"<>|()]/g, '_') + '.pdf')
      fs.writeFileSync(file, buf)
      console.log('OK', p.name, buf.length)
    } catch (e) { console.log('ERR', p.name, e.message) }
  }
  console.log('->', outDir)
}
main()
