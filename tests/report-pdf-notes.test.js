/**
 * reportPdf 报告级披露与期限口径（2026-09-20 PDF 审计修复）
 *
 * 覆盖三类"会印在纸上、发出去就收不回"的问题：
 *   ① _termYear：coverage_term=105（AI 工具契约里的终身哨兵）此前漏判
 *      → PDF「保障节点」出现 ~2130 年"保障期满"的荒谬条目，而页面无此节点（口径分裂）
 *   ② _qualitativeNote：定性模式报告此前**完全没有**披露
 *      → 客户拿到一份一个金额都没有的分析，纸面上没有任何解释
 *   ③ _analysisNote：封面只有"生成时间"（导出时刻），而深度分析是 AI 快照
 *      → 读者会把一个月前的分析当成今天的
 *
 * 后两条另加"接线断言"：纯函数存在但 buildPdf 忘了调用，是这类披露最典型的失效方式。
 */
jest.mock('wx-server-sdk', () => ({
  init: jest.fn(),
  DYNAMIC_CURRENT_ENV: 'env-mock',
  database: jest.fn(() => ({ collection: jest.fn(() => ({})) })),
  getWXContext: jest.fn(() => ({ OPENID: 'o1' }))
}))

const fs = require('fs')
const path = require('path')
const { _termYear, _qualitativeNote, _analysisNote, _mdPlain, _expiryNote, _shortNote } = require('../cloudfunctions/reportPdf/index')

describe('_termYear — 保障/缴费期满年（含 105 终身哨兵）', () => {
  test('文本优先：insurance_period 存在时忽略数字字段', () => {
    expect(_termYear('至2045-12-31', 105, 2020, 30)).toBe(2045)
  })

  test('文本"终身/长期" → null（无到期节点）', () => {
    expect(_termYear('终身', undefined, 2020, 30)).toBeNull()
  })

  // ← 本次修复点。105 是对话录入的"终身"编码（AI 工具 schema 明文约定），
  //   原实现只排除 0/'0' → 会算出 startY+105。
  test('coverage_term=105（终身）→ null（修复前返回 startY+105 = 2125）', () => {
    expect(_termYear('', 105, 2020, 30)).toBeNull()
    expect(_termYear('', '105', 2020, 30)).toBeNull()
  })

  test('旧哨兵 0 / "0" 仍是"未填" → null', () => {
    expect(_termYear('', 0, 2020, 30)).toBeNull()
    expect(_termYear('', '0', 2020, 30)).toBeNull()
  })

  test('普通年限照常：30 → startY+30；空值 → null', () => {
    expect(_termYear('', 30, 2020, 30)).toBe(2050)
    expect(_termYear('', undefined, 2020, 30)).toBeNull()
    expect(_termYear('', '', 2020, 30)).toBeNull()
  })

  test('趸交（premium_term=1）仅在 singleYearEnd 下无"缴完"节点', () => {
    expect(_termYear('', 1, 2020, 30, { singleYearEnd: true })).toBeNull()
    expect(_termYear('', 1, 2020, 30)).toBe(2021)
  })
})

describe('_qualitativeNote — 定性模式披露', () => {
  test('tier=degraded → 出披露文案（含"未做量化测算"的口径说明）', () => {
    const n = _qualitativeNote({ readiness_tier: 'degraded' })
    expect(n).toContain('定性分析')
    expect(n).toContain('未做缺口金额')
  })

  test('tier=ok / 字段缺失（老报告）→ 空串（不猜、不误报）', () => {
    expect(_qualitativeNote({ readiness_tier: 'ok' })).toBe('')
    expect(_qualitativeNote({})).toBe('')
    expect(_qualitativeNote(null)).toBe('')
  })
})

describe('_analysisNote — 分析时点 + 数据口径', () => {
  test('有 last_analysis_at → 含分析时刻与"其余章节是实时数据"的说明', () => {
    const n = _analysisNote({ last_analysis_at: new Date(2026, 7, 8, 14, 30) })
    expect(n).toContain('分析生成于 2026-08-08 14:30')
    expect(n).toContain('实时数据')
  })

  test('无分析时间 / 脏值 → 空串', () => {
    expect(_analysisNote({})).toBe('')
    expect(_analysisNote(null)).toBe('')
    expect(_analysisNote({ last_analysis_at: 'not-a-date' })).toBe('')
  })
})

describe('披露接线（防"函数定义了但 buildPdf 没调用"）', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '../cloudfunctions/reportPdf/index.js'), 'utf8')

  test('buildPdf 内确实渲染两条披露', () => {
    expect(SRC).toContain('const qualNote = _qualitativeNote(family)')
    expect(SRC).toContain('const anaNote = _analysisNote(family)')
  })

  test('定性披露位于正文最前（保障摘要之前，与报告页页头卡片同位置）', () => {
    const qualIdx = SRC.indexOf('const qualNote = _qualitativeNote(family)')
    const sumIdx = SRC.indexOf("_sec('保障摘要')")
    expect(qualIdx).toBeGreaterThan(-1)
    expect(sumIdx).toBeGreaterThan(qualIdx)
  })

  test('分析时点披露位于深度分析节内', () => {
    const deepIdx = SRC.indexOf("_sec('深度分析（AI 解读）')")
    const anaIdx = SRC.indexOf('const anaNote = _analysisNote(family)')
    expect(deepIdx).toBeGreaterThan(-1)
    expect(anaIdx).toBeGreaterThan(deepIdx)
  })
})

// ===========================================================================
// 2026-09-22（PDF 审计 P2-2）：emoji 通用剔除
//   EMOJI 表只映射 9 个常用标记，其余 emoji 在 NotoSansSC 里没有字形 → PDF 上是空白/豆腐块。
//   ⚠️ 剔除区间必须**绕过 U+2713（✓）** —— 它是 EMOJI 映射的输出（'\u2705' → '✓ '），
//   若一并删掉，报告里所有对勾都会消失（这是本组用例首要保护的性质）。
// ===========================================================================
describe('_mdPlain — markdown 纯文本化与 emoji 剔除', () => {
  test('白名单标记转成符号，且映射出的 ✓ 不被后续剔除误删', () => {
    const out = _mdPlain('✅ 已配置 ⚠️ 注意 📌 优先级')
    expect(out).toContain('✓')
    expect(out).toContain('!')
    expect(out).not.toContain('\u2705')
    expect(out).not.toContain('\u{1F4CC}')
  })

  test('白名单外的 emoji 被剔除（正文文字保留）', () => {
    const out = _mdPlain('保障充足🙂家庭年收入💰约30万🚗')
    expect(out).toContain('保障充足')
    expect(out).toContain('家庭年收入')
    expect(out).toContain('约30万')
    expect(out).not.toMatch(/[\u{1F000}-\u{1FAFF}]/u)
  })

  test('中文与全角标点不受影响（不误删正文）', () => {
    const src = '「家庭年收入」未填写（建议补全），缺口无法测算。'
    expect(_mdPlain(src)).toBe(src)
  })

  test('markdown 语法仍被清理（标题/加粗/列表）', () => {
    const out = _mdPlain('## 标题\n**加粗**\n- 项目')
    expect(out).not.toContain('##')
    expect(out).not.toContain('**')
    expect(out).toContain('加粗')
    expect(out).toContain('• 项目')
  })

  test('{{URGENT}} 占位符仍被替换（剔除不早于映射）', () => {
    expect(_mdPlain('{{URGENT}} 补充寿险')).toContain('【立即】')
  })

  // 2026-09-25 审计：箭头/数学/几何符号此前是**删除**，会把两侧的词粘成一个：
  // 「缺口合计约 80 万→需要补充定期寿险」渲染成「80 万需要补充…」，语义被改坏（已复现）。
  // 改为替换为空格；装饰性 emoji 仍直接删（不插空格，避免正文里凭空多出空格）。
  test('符号类替换为空格而不是删除（防两侧词粘连）', () => {
    const out = _mdPlain('缺口合计约 80 万→需要补充定期寿险')
    expect(out).not.toContain('万需要')
    expect(out).toContain('80 万 需要补充定期寿险')
    expect(_mdPlain('保额≈年收入10倍')).toContain('保额 年收入10倍')
  })
})

// ===========================================================================
// 2026-09-22 产品决策：一年期产品默认是续保的，但要在文中给出提醒
//   客户拿到的纸面上必须有一行说明 —— 否则「总保额」把已过期保单算进去，读者无从知道。
//   状态不改（保证续保假设），只披露。
// ===========================================================================
describe('_expiryNote — 载明期限已过的提醒', () => {
  test('无过期保单 / 空输入 → 空串（不渲染噪声）', () => {
    expect(_expiryNote([])).toBe('')
    expect(_expiryNote([{ status: 'active', insurance_period: '终身' }])).toBe('')
    expect(_expiryNote([{ status: 'surrendered', insurance_period: '至2021年05月19日' }])).toBe('')
  })

  test('一年期已过 → 含保单名、到期日、"续保"字样', () => {
    const note = _expiryNote([{
      status: 'active', product_name: '康健华尊医疗保险', insured_name: '李阳勇',
      insurance_period: '至2022年05月25日', effective_date: '2021-05-26'
    }])
    expect(note).toContain('康健华尊医疗保险·李阳勇')
    expect(note).toContain('2022-05-25')
    expect(note).toContain('续保')
  })

  test('非一年期已过 → 提醒措辞更强调核实（不套用"默认仍有效"）', () => {
    const note = _expiryNote([{
      status: 'active', product_name: '某长期重疾', insured_name: '张三',
      insurance_period: '至2020年09月27日', effective_date: '2005-09-28'
    }])
    expect(note).toContain('非一年期产品')
    expect(note).toContain('核实')
  })
})

// ===========================================================================
// 2026-09-22：一年期短险单列（沿用 2026-09-04「防总保额虚高误导」决策）
//   该决策原先只落到报告页摘要卡 → PDF（客户纸面）与 AI 上下文都没有。
//   注意判据必须认**日期区间形态** —— 线上真实数据的一年期全是这个形态。
// ===========================================================================
describe('_shortNote', () => {
  test('无一年期短险 → 空串（不渲染噪声）', () => {
    expect(_shortNote([])).toBe('')
    expect(_shortNote([{ insurance_period: '终身', sum_assured: 500000 }])).toBe('')
    expect(_shortNote([{ insurance_period: '30年', effective_date: '2020-01-01', sum_assured: 1000000 }])).toBe('')
  })

  test('日期区间形态的一年期也认 → 金额为万', () => {
    const n = _shortNote([{ insurance_period: '2025年03月20日零时起至2026年03月19日二十四时止', effective_date: '2025-03-20', sum_assured: 8000000 }])
    expect(n).toContain('800')
    expect(n).toContain('短险')
    expect(n).toContain('续保')
  })

  test('只累加一年期部分，非一年期不计入', () => {
    const n = _shortNote([
      { insurance_period: '终身', sum_assured: 500000 },
      { insurance_period: '至2022年07月09日', effective_date: '2021-07-10', sum_assured: 4000000 }
    ])
    expect(n).toContain('400')
    expect(n).not.toContain('450')
  })
})

// ===========================================================================
// 2026-09-25 PDF 全面审计（客户视角）—— 回归锁定
//   审计方式：接内存 DB + 真实字体跑通 exports.main，再用 PyMuPDF 逐页出图并提取文本
//   坐标（span bbox）核对。本组用例锁住其中可用纯函数/源码断言表达的部分；
//   「格子换行压到下一行」这类几何问题由末尾的接线断言兜住（pdfkit 的 ellipsis 只在
//   传了 height 时才生效，不传就是死参数 → 超宽文本换行重叠）。
// ===========================================================================
describe('_stripLeadHeading — 正文首行 markdown 标题（防标题连印两次）', () => {
  const { _stripLeadHeading } = require('../cloudfunctions/reportPdf/index')

  test('首行标题被剥掉（PDF 自己已有小节标题）', () => {
    expect(_stripLeadHeading('## 保障缺口分析\n寿险缺口 200 万。')).toBe('寿险缺口 200 万。')
    expect(_stripLeadHeading('# 标题')).toBe('')
  })

  test('正文中间的标题保留（可能是 AI 的子分段）', () => {
    const out = _stripLeadHeading('第一段。\n## 子分段\n第二段。')
    expect(out).toContain('第一段。')
    expect(out).toContain('## 子分段')
  })

  test('无标题正文原样返回；空值安全', () => {
    expect(_stripLeadHeading('就是一段话。')).toBe('就是一段话。')
    expect(_stripLeadHeading('')).toBe('')
    expect(_stripLeadHeading(null)).toBe('')
  })
})

describe('_insuredCount — 保障人数（空被保人不得算成同一个人）', () => {
  const { _insuredCount } = require('../cloudfunctions/reportPdf/index')

  test('只数非空姓名并去重', () => {
    expect(_insuredCount([{ insured_name: '张三' }, { insured_name: '张三' }, { insured_name: '李四' }])).toBe('2')
    expect(_insuredCount([{ insured_name: ' 张三 ' }, { insured_name: '李四' }])).toBe('2')
  })

  test('全部缺姓名 → 待补（原实现返回 1，与明细表多行「—」矛盾）', () => {
    expect(_insuredCount([{ insured_name: '' }, { insured_name: '' }, {}])).toBe('待补')
  })

  test('无保单 → 0；非数组安全', () => {
    expect(_insuredCount([])).toBe('0')
    expect(_insuredCount(null)).toBe('0')
  })
})

describe('buildPayMonths — 缴费月历（趸交/已缴满期/缴费频次）', () => {
  const { buildPayMonths } = require('../cloudfunctions/reportPdf/index')
  const THIS_YEAR = new Date().getFullYear()
  const effMay = (THIS_YEAR - 1) + '-05-20'   // 去年 5 月生效 → 落在 5 月
  const pick = (months, m) => months[m - 1]

  test('趸交保单不进月历（原实现把它列成每年固定支出）', () => {
    const months = buildPayMonths([
      { product_name: '趸交终身寿险', annual_premium: 35000, premium_term: 1, contract_effective_date: effMay }
    ])
    expect(pick(months, 5).items).toEqual([])
  })

  test('已缴满期的保单不进月历（10 年缴、早已交完）', () => {
    const months = buildPayMonths([
      { product_name: '十年缴已期满', annual_premium: 12000, payment_period: '10年', contract_effective_date: (THIS_YEAR - 12) + '-05-20' }
    ])
    expect(pick(months, 5).items).toEqual([])
  })

  test('仍在缴费期的照常列出（含单期金额与同频次合计）', () => {
    const months = buildPayMonths([
      { product_name: '二十年缴', annual_premium: 12800, payment_period: '20年', contract_effective_date: (THIS_YEAR - 3) + '-05-20', insured_name: '李梅' }
    ])
    const m = pick(months, 5)
    expect(m.items).toHaveLength(1)
    expect(m.items[0].premium).toBe(12800)
    expect(m.items[0].unit).toBe('年')
    expect(m.total).toBe(12800)
  })

  test('月交按 12 折算单期金额（原实现显示年保费，放大 12 倍）', () => {
    const m = pick(buildPayMonths([
      { product_name: '意外险', annual_premium: 1200, payment_method: '月交', contract_effective_date: effMay }
    ]), 5)
    expect(m.items[0]).toMatchObject({ premium: 100, unit: '月' })
  })

  test('季交/半年交分别按 4/2 折算', () => {
    const q = buildPayMonths([{ annual_premium: 4000, payment_method: '季交', contract_effective_date: effMay }])
    const h = buildPayMonths([{ annual_premium: 4000, payment_method: '半年交', contract_effective_date: effMay }])
    expect(pick(q, 5).items[0]).toMatchObject({ premium: 1000, unit: '季' })
    expect(pick(h, 5).items[0]).toMatchObject({ premium: 2000, unit: '半年' })
  })

  test('同月混频不给合计（相加会得出无意义数字）', () => {
    const m = pick(buildPayMonths([
      { annual_premium: 1200, payment_method: '月交', contract_effective_date: effMay },
      { annual_premium: 12000, payment_method: '年交', contract_effective_date: effMay }
    ]), 5)
    expect(m.items).toHaveLength(2)
    expect(m.total).toBe(0)
  })

  test('无生效日的保单不进任何月份', () => {
    const months = buildPayMonths([{ product_name: '无生效日', annual_premium: 999 }])
    expect(months.reduce((s, m) => s + m.items.length, 0)).toBe(0)
  })
})

describe('保单明细几何接线（防「格子换行压到下一行」回归）', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '../cloudfunctions/reportPdf/index.js'), 'utf8')

  test('产品名列必须同时传 height 与 ellipsis（pdfkit 只在 height != null 时才省略）', () => {
    // 反例即本次审计的 P0：原实现只传 ellipsis 不传 height → pdfkit 直接换行，
    // 而主行行高固定 20pt → 第二行压在下方的「公司/保险期间」行上，逐字重叠。
    expect(SRC).toMatch(/height:\s*rowHActual\s*-\s*8,\s*ellipsis:\s*true/)
  })

  test('其余列走单行裁剪 _clip（不再依赖失效的 ellipsis）', () => {
    expect(SRC).toContain('doc.text(_clip(cells[i], widths[i] - 6)')
  })

  test('副行高度按 heightOfString 实测推进（固定 subH 会被换行撑破）', () => {
    expect(SRC).toContain('const subHActual = Math.max(subH, doc.heightOfString(subTxt')
  })

  test('页脚不再印内部构建标记（客户可见文档）', () => {
    const footLine = SRC.split('\n').find(l => l.indexOf("'保小秘生成 · 家庭保障检视报告 · 第 '") !== -1)
    expect(footLine).toBeTruthy()
    expect(footLine).not.toContain('_BUILD')
    expect(SRC).toContain("Keywords: 'baoxiaomi build ' + _BUILD")
  })
})

// ===========================================================================
// 2026-09-25 PDF 审计（第二批：客户视角文案与版面）
//   —— 封面客户名、免责声明措辞与对比度、过期提醒措辞、目录与总页数
// ===========================================================================
describe('_displayName — 封面客户名（不得印代理人的内部档案名）', () => {
  const { _displayName } = require('../cloudfunctions/reportPdf/index')

  test('优先「本人/经济支柱」姓名 + 家庭', () => {
    expect(_displayName({
      family_name: '李姐-转介绍（老客户）',
      members: [{ name: '李梅', role: '配偶' }, { name: '王强', role: '本人' }]
    })).toBe('王强家庭')
    expect(_displayName({ family_name: 'x', members: [{ name: '张三', role: '经济支柱' }] })).toBe('张三家庭')
  })

  test('无角色命中时取首个有姓名的成员；软删成员不参与', () => {
    expect(_displayName({ members: [{ name: '已删除', role: '本人', status: 'deleted' }, { name: '李四', role: '子女' }] })).toBe('李四家庭')
  })

  test('一个姓名都取不到 → 回退 family_name（不猜、不出现「undefined家庭」）', () => {
    expect(_displayName({ family_name: '王先生一家', members: [] })).toBe('王先生一家')
    expect(_displayName({ family_name: '王先生一家', members: [{ name: '  ', role: '本人' }] })).toBe('王先生一家')
    expect(_displayName({})).toBe('家庭')
  })
})

describe('DISCLAIMER — 数据来源不得虚报（手工/对话录入的保单也要被覆盖）', () => {
  const { DISCLAIMER } = require('../cloudfunctions/reportPdf/index')

  test('不再声称「基于 OCR 识别结果」', () => {
    expect(DISCLAIMER).not.toContain('OCR')
    expect(DISCLAIMER).toContain('代理人录入')
  })

  test('三条必备免责表述仍在（仅供参考 / 不构成投保建议 / 以保单原件为准）', () => {
    expect(DISCLAIMER).toContain('仅供参考')
    expect(DISCLAIMER).toContain('不构成投保建议')
    expect(DISCLAIMER).toContain('以保单原件为准')
  })
})

describe('版面接线（目录 / 总页数 / 免责声明可读性）', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '../cloudfunctions/reportPdf/index.js'), 'utf8')

  test('目录清单与源码里的 _sec() 小节一一对应（新增小节必须同步进目录）', () => {
    const labels = [...SRC.matchAll(/_sec\('([^']+)'\)/g)].map(m => m[1])
    expect(labels.length).toBeGreaterThanOrEqual(6)
    const staticToc = ['保障摘要', '家庭成员', '保单明细', '保障节点（未来关键时点）', '缴费月历（每年固定缴费月）', '经济状况']
    labels.forEach(l => {
      if (l === '深度分析（AI 解读）') return   // 条件小节：按 deep 动态进目录
      expect(staticToc).toContain(l)
    })
    expect(SRC).toContain("['家庭成员', '保单明细', '保障节点（未来关键时点）', '缴费月历（每年固定缴费月）', '经济状况']")
  })

  test('页脚含总页数且走 bufferPages + switchToPage 回填', () => {
    expect(SRC).toContain('bufferPages: true')
    expect(SRC).toContain('doc.bufferedPageRange()')
    expect(SRC).toContain("' / ' + total + ' 页'")
  })

  test('finalize 必须在 doc.end() 之前调用（否则缓冲页写不回）', () => {
    const i = SRC.indexOf('L.finalize()')
    // 用「行首 4 空格缩进的调用」定位，避免命中注释里提到的 doc.end()
    const j = SRC.indexOf('\n    doc.end()')
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
  })

  test('免责声明提到 9pt/#666666（原 8pt/#999999 对比度不足 3:1）', () => {
    expect(SRC).toContain("_para(DISCLAIMER, 9, { color: '#666666' })")
  })

  test('一年期过期提醒不再断言「保证续保」（判据判不出是否保证续保）', () => {
    expect(SRC).toContain('是否保证续保以条款为准')
    const note = _expiryNote([{
      status: 'active', product_name: '某意外险', insured_name: '王强',
      insurance_period: '至2025年05月20日', effective_date: '2024-05-20'
    }])
    expect(note).toContain('续保')
    expect(note).not.toContain('保证续保默认仍有效')
  })
})
