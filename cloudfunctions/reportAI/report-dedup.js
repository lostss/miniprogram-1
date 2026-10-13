/**
 * report-dedup — 报告正文的重复度检查（2026-09-22 数据质量批次 2）
 *
 * 为什么存在：prompt 第 9 条早已写明「同一句判断或口号全篇最多出现 2 次」
 * （2026-09-10 线上实测：同一结论在 7 个模块各说一遍），但**那只是一句话，没有任何机器校验**。
 * 2026-09-22 对真实报告的客观计数：同一结论出现在 5 个模块
 * （「寿险为零／拿不到一分寿险赔付」5 处、「航空意外专属」4 处）→ 报告读起来又长又重。
 * 本模块把该规则变成机器可答的问题。
 *
 * 实现：对 7 段正文各取长度 N 的字符 n-gram，统计每个 gram 出现在**几段**里，
 * ≥ threshold 段即判为重复（prompt 规定 ≤2 次 → 出现在 ≥3 段即违规）。
 *
 * 已知局限（刻意接受，勿当成 bug）：
 *   - 只能抓**字面**重复，抓不到改写（"寿险为零" vs "拿不到一分寿险赔付"）→ 会漏报；
 *   - 因此它是"可观测性 + 重试触发器"，**不是质量门禁**：调用方在违反时最多提示重写一次，
 *     绝不能让报告失败——一份略显啰嗦的报告远好过没有报告。
 */

// 与 FIELD_KEYS（_shared/report-fields.js）对应的 7 段正文
const FIELDS = ['portrait', 'summary', 'review', 'analysis', 'plan', 'conclusion', 'suggestions']
const NGRAM = 6       // 字符窗口；太短会撞常见词，太长会漏
const MIN_FIELDS = 3  // 出现在 ≥3 段即违规（prompt 规定"最多出现 2 次"）→ 记日志
const MAX_HITS = 8    // 回传上限：提示语要短，只给最有代表性的
// 触发**重写**的门槛（高于记日志门槛）。理由：合法术语/关键事实（如"医疗险400万"）
// 也可能自然出现在 3 段里，而重写要烧两次 AI 调用 —— 只有 4 段以上才算明确失控。
// 真实报告实测的违规项是 5 处与 4 处，均能触发。需要更保守/更激进时改这一个数即可。
const RETRY_MIN_FIELDS = 4

// 标点/空白/标记不进 gram（否则"寿险为零，"和"寿险为零。"算两个）
const STRIP_RE = /[\s，。！？、；：""''（）()【】\[\]…—·*#>－-]/g

function _grams(text) {
  const out = new Set()
  for (let i = 0; i + NGRAM <= text.length; i++) out.add(text.slice(i, i + NGRAM))
  return out
}

/**
 * 把命中的 N-gram 在其**所有出现文本**里向左右扩到最长。
 * 不做这一步，提示语会是被截断的滑窗（"李阳勇寿险为"），既难读也难让模型定位。
 * 扩展要求所有出现文本在同一侧的下一个字符都相同，否则停下（不同上下文即不同表述）。
 */
function _extend(phrase, texts) {
  let p = phrase
  const grow = function (dir) {
    for (;;) {
      let ch = null
      let ok = true
      for (const t of texts) {
        const i = t.indexOf(p)
        if (dir === 'right' ? (i === -1 || i + p.length >= t.length) : (i <= 0)) { ok = false; break }
        const c = dir === 'right' ? t.charAt(i + p.length) : t.charAt(i - 1)
        if (ch === null) ch = c
        else if (ch !== c) { ok = false; break }
      }
      if (!ok || ch === null) return
      p = dir === 'right' ? p + ch : ch + p
    }
  }
  grow('right')
  grow('left')
  return p
}

/**
 * @param {object} report - 解析后的报告对象（{portrait, summary, review, analysis, plan, conclusion, suggestions}）
 * @param {object} [opts] - { minFields } 覆盖阈值（测试用）
 * @returns {Array<{phrase:string, fields:string[], count:number}>} 按"跨段数"降序
 */
function findRepetitions(report, opts) {
  const threshold = (opts && opts.minFields) || MIN_FIELDS
  const src = report || {}
  const where = {}
  const texts = {}
  for (const f of FIELDS) {
    const raw = src[f]
    const joined = Array.isArray(raw) ? raw.join('\n') : raw
    const text = joined ? String(joined).replace(STRIP_RE, '') : ''
    if (!text) continue
    texts[f] = text
    for (const g of _grams(text)) {
      if (!where[g]) where[g] = []
      where[g].push(f)
    }
  }
  const hits = Object.keys(where).filter(g => where[g].length >= threshold)
  // 同一处重复会产生一串滑窗 gram（长度相同、彼此重叠一个字符）→ 合并成一条，
  // 否则提示语里会列出多个几乎一样的片段（如 "李阳勇寿险为零" / "阳勇寿险为零"）。
  const _overlaps = (a, b) => a.slice(1) === b.slice(0, NGRAM - 1) || b.slice(1) === a.slice(0, NGRAM - 1)
  const ordered = hits.sort((a, b) => (where[b].length - where[a].length) || (b.length - a.length))
  const kept = []
  for (const g of ordered) {
    const sameSet = where[g].join()
    // 已被更长的命中项包含，或与同字段集的已保留项首尾重叠 → 视为同一处重复
    if (hits.some(o => o !== g && o.indexOf(g) !== -1 && where[o].length >= where[g].length)) continue
    if (kept.some(k => k.fields.join() === sameSet && _overlaps(k.phrase, g))) continue
    const phrase = _extend(g, where[g].map(f => texts[f]))
    if (kept.some(k => k.phrase === phrase)) continue // 扩展后可能与已有项重合
    kept.push({ phrase: phrase, fields: where[g], count: where[g].length })
  }
  return kept.slice(0, MAX_HITS)
}

/**
 * 生成给第二次调用的硬约束提示（列出被检测到的重复串）。
 * 与 prompts.js 的"模块分工与去重"呼应，但把**具体**重复项点出来——泛泛说"不要重复"已经无效。
 */
function buildRetryHint(hits) {
  const list = (hits || []).map(h => '「' + h.phrase + '」（已出现在 ' + h.count + ' 个模块：' + h.fields.join('/') + '）')
  return '\n\n## ⚠️ 上次输出违反篇幅与去重约束，请重写并严格做到\n' +
    '- 下列表述被检测到在多处重复，**只在最贴合的一个模块保留**，其余位置删掉或换角度改写：\n' +
    list.map(x => '  - ' + x).join('\n') + '\n' +
    '- 全篇正文（不含 disclaimer）1800-2400 字；plan 不超过 450 字（最多 2 个深度分析维度向 plan 贡献内容）。\n' +
    '- 只输出一个 JSON 对象，键与上次完全一致，不要额外的 Markdown 代码块或说明文字。'
}

module.exports = { findRepetitions, buildRetryHint, FIELDS, NGRAM, MIN_FIELDS, RETRY_MIN_FIELDS }
