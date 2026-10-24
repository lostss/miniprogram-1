/**
 * 报告页空态（刚建完客户、还没有保单）守卫 —— 2026-10-17
 *
 * 截图实况：页头「AI 辅助生成」+ 空态卡「暂无保单」+ 页尾「分享剩余 7 天 / 转发报告给客户 / 导出 PDF」，
 * 而空态文案写的是"点击**下方金色按钮**上传保单"—— 主任务入口是底栏里 88rpx 的图标，
 * 且靠"下方"这种空间指代（页面一滚就失效）。
 *
 * 本次改动三条不变式：
 *   ① 空态必须有**卡内主按钮**（带文字）走同一个 onUploadFab；
 *   ② 空态**不得出现**只在报告生成后才有意义的控件（转发 / 导出 / 分享有效期）；
 *   ③ 建档填的「人数」要有可见结果（占位成员回显 + 去补充入口）。
 */
const fs = require('fs')
const path = require('path')
const { buildMemberEcho } = require('../miniprogram/utils/member-echo')

const WXML = path.join(__dirname, '..', 'miniprogram', 'pages', 'report', 'index.wxml')
const raw = fs.readFileSync(WXML, 'utf8')
const lines = raw.split(/\r?\n/)

/** 空态块 `<view class="empty-report" wx:if="{{!hasPolicy}}">` 的行范围（嵌套计数配对） */
function emptyBlockRange() {
  const start = lines.findIndex((l) => l.includes('class="empty-report"') && l.includes('!hasPolicy'))
  expect(start).toBeGreaterThan(-1)
  let depth = 0
  const re = /<view\b|<\/view>/g
  re.lastIndex = 0
  // 从起始行开始按标签配对
  let i = start
  let m
  const text = lines.slice(start).join('\n')
  while ((m = re.exec(text))) {
    depth += m[0] === '<view' ? 1 : -1
    if (depth === 0) {
      const consumed = text.slice(0, m.index).split('\n').length - 1
      i = start + consumed
      break
    }
  }
  return { start: start + 1, end: i + 1, text: lines.slice(start, i + 1).join('\n') }
}

describe('报告页空态：主任务入口必须在卡内', () => {
  const range = emptyBlockRange()
  // 断言"某文案不存在"必须先剥注释：本文件的注释会引用被移除的旧文案
  //（"原文案写的是'下方金色按钮'"），否则文字断言被注释命中 —— 本次写测试又踩了一次。
  const clean = range.text.replace(/<!--[\s\S]*?-->/g, '')

  test('卡内有上传主按钮，且复用 onUploadFab（不新增上传链路）', () => {
    expect(clean).toContain('empty-report-upload')
    expect(clean).toMatch(/bindtap="onUploadFab"/)
    // 按钮必须带文字：图标 + 空间指代（"下方金色按钮"）是本次要消除的问题
    expect(clean).toContain('上传保单</button>')
  })

  test('文案不再依赖空间指代（"下方金色按钮"）', () => {
    expect(clean).not.toContain('下方金色按钮')
    expect(clean).toContain('拍照或从相册选保单')
  })

  test('客户版（isShared）不显示上传按钮（客户无法自助上传）', () => {
    // 上传按钮所在的 cta 容器必须带 !isShared
    const ctaLine = clean.split(/\r?\n/).find((l) => l.includes('empty-report-cta'))
    expect(ctaLine).toBeTruthy()
    expect(ctaLine).toContain('!isShared')
  })

  test('页头副标题点明"待生成"（否则像"有报告但空的"）', () => {
    // 2026-10-24：报告改名「家庭保单化验单」，"待生成"后缀保留（空态不能看起来像有报告）
  expect(raw).toContain("{{hasPolicy ? '家庭保单化验单' : '家庭保单化验单 · 待生成'}}")
  })

  test('任何时刻只有一个上传入口：空态时底栏的上传图标隐藏', () => {
    const line = lines.find((l) => l.includes('class="fab-upload'))
    expect(line).toBeTruthy()
    expect(line).toContain('wx:if="{{hasPolicy}}"')
  })
})

describe('报告页空态：不得出现"报告已就绪"才成立的控件', () => {
  test('转发 / 导出仅在 hasPolicy 时出现', () => {
    const shareLine = lines.find((l) => l.includes('footer-share'))
    const exportLine = lines.find((l) => l.includes('footer-export'))
    expect(shareLine).toBeTruthy()
    expect(exportLine).toBeTruthy()
    // 条件写在包裹它们的 <block> 上：找到该 block 并断言含 hasPolicy
    const blockIdx = lines.findIndex((l) => l.includes('wx:if="{{!isShared && hasPolicy}}"'))
    expect(blockIdx).toBeGreaterThan(-1)
    expect(blockIdx).toBeLessThan(lines.indexOf(shareLine))
    expect(blockIdx).toBeLessThan(lines.indexOf(exportLine))
  })

  test('分享链接有效期仅在 hasPolicy 时出现（否则被读成"报告已就绪、7 天后过期"）', () => {
    const line = lines.find((l) => l.includes('shareExpireHint}}'))
    expect(line).toBeTruthy()
    expect(line).toContain('hasPolicy')
  })

  test('"转发报告给客户"改为"转发给客户"（原读法像"把刚生成的报告转发出去"）', () => {
    expect(raw).toContain('>转发给客户</button>')
    expect(raw).not.toContain('转发报告给客户')
  })
})

describe('空态成员回显：建档填的人数必须有可见结果', () => {
  test('全是占位成员 → 提示姓名待补', () => {
    const e = buildMemberEcho([{ name: '成员1' }, { name: '成员2' }, { name: '成员3' }])
    expect(e).toEqual({ total: 3, skeleton: 3, text: '已建 3 位家庭成员，姓名待补' })
  })

  test('部分已命名 → 报出待补人数', () => {
    const e = buildMemberEcho([{ name: '李阳勇' }, { name: '成员2' }])
    expect(e.text).toBe('已建 2 位家庭成员，其中 1 位姓名待补')
    expect(e.skeleton).toBe(1)
  })

  test('都已命名 → 只报人数（不虚构"待补"）', () => {
    expect(buildMemberEcho([{ name: '李阳勇' }, { name: '谢敏' }]).text).toBe('已建 2 位家庭成员')
  })

  test('软删成员不计入；空数组/空名不产出文案', () => {
    expect(buildMemberEcho([{ name: '成员1', status: 'deleted' }]).total).toBe(0)
    expect(buildMemberEcho([{ name: '' }]).text).toBe('')
    expect(buildMemberEcho([]).text).toBe('')
    expect(buildMemberEcho(null).text).toBe('')
  })

  test('回显入口接在成员管理 Sheet（复用 onChapterEdit family 分支，不另写一套）', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'report', 'index.js'), 'utf8')
    expect(js).toContain('onEmptyEditMembers')
    expect(js).toMatch(/onEmptyEditMembers\(\)\s*\{\s*this\.onChapterEdit\(\{\s*detail:\s*\{\s*mode:\s*'family'/)
    expect(raw).toContain('bindtap="onEmptyEditMembers"')
  })
})
