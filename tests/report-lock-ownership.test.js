/**
 * reportAI CAS 锁所有权契约（2026-09-20 复核批次 A）
 *
 * 背景：analysis_lock_at 是 30s 节流 + 并发互斥的 CAS 占用字段。原实现**四处**释放
 * （解析失败 / 内层 catch / 外层 catch / **成功写**）都按 {_id,_openid} 无条件删除 ——
 * 而 AI 失败重试最坏可到 80s（40s×2），远超 30s 节流窗口：本次调用迟到收尾时，别的请求
 * 可能已占用**新锁**，这条写操作会把新锁删掉 → 节流失效、第三方可立即重跑
 * （双倍计费 + 重复归档）。四处里成功路径最危险（耗时最长、迟到概率最高）。
 *
 * 修法：释放统一走 `_releaseLock()`，where 带 `analysis_lock_at: casNow`（本次占用值）；
 * casNow 提到 try 之前声明（外层 catch 需要它），未占用时为 null → 整体跳过。
 *
 * 为什么用源码断言而非行为测试：`exports.main` 需 mock 整个 wx-server-sdk + 5 个集合，
 * 成本远高于收益；本不变量属于"写操作形态"层面，静态断言即可锁死
 * （同 `report-prompt-contract.test.js` 的做法）。
 */
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '../cloudfunctions/reportAI/index.js'), 'utf8')

// 断言前先剔除**整行注释**：注释里引用的旧写法（"原实现是 analysis_lock_at: _.remove()"）
// 否则会被正则当成真实代码 —— 本用例第一版就因此误报过一次。
// 只剔整行注释、不做行内 `//` 截断：项目文件是 CRLF，`/\/\/.*$/` 里的 `$` 不匹配 `\r`
// 之前的位置（JS 的 `$` 无 m 标志只认串尾/末尾 \n 前），会静默失效；整行过滤既稳，
// 又不会误伤字符串里的 `//`（如 URL）。
const CODE = SRC.split('\n')
  .filter(l => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  })
  .join('\n')

describe('reportAI 锁释放：必须带所有权校验', () => {
  test('释放锁的写操作只允许出现在 _releaseLock 内（防有人再加无条件删除）', () => {
    const lines = CODE.split('\n')
    const writes = lines
      .map((l, i) => ({ l, i }))
      .filter(x => /analysis_lock_at\s*:.*remove\(\)/.test(x.l))
    expect(writes.length).toBe(1) // 唯一实现点
    const releaseIdx = lines.findIndex(l => l.includes('const _releaseLock'))
    expect(releaseIdx).toBeGreaterThan(-1)
    expect(writes[0].i).toBeGreaterThan(releaseIdx) // 且确实在 _releaseLock 函数体内
  })

  test('_releaseLock 的 where 条件含本次占用值（analysis_lock_at: casNow）', () => {
    const body = CODE.slice(CODE.indexOf('const _releaseLock'))
    expect(body).toMatch(/analysis_lock_at:\s*casNow/)
    // 未占用则跳过（外层 catch 在 CAS 之前触发时 casNow 仍为 null）
    expect(body).toMatch(/if\s*\(!casNow\)\s*return/)
  })

  test('五处释放分支均改调 _releaseLock（不再各自直接写 analysis_lock_at）', () => {
    // ① 解析失败 ② 内层 catch ③ 外层 catch ④ 成功路径 ⑤ 审查链拦截（_blockedReportResult，2026-09-28）
    // 本用例最初按"三处"写，被断言当场抓出漏改的第 4 处（成功写里夹带的 analysis_lock_at: _.remove()）。
    // 2026-09-28 新增第 ⑤ 处：guard 拦截（配额/限流/注入）原先伪装成"解析失败"走 ①，
    // 拆出独立分支后它自己必须释放锁，否则用户重试会撞 30s 节流。
    expect((CODE.match(/await _releaseLock\(\)/g) || []).length).toBe(5)
  })

  test('成功路径的 bulk write 不再夹带锁释放（拆分后由 _releaseLock 单独负责）', () => {
    const start = CODE.indexOf('const ws = writeSeam(db, openid, familyId)')
    // 从成功写向后找**第一个**释放调用（不能用 lastIndexOf：文件后面还有内层/外层 catch 两处）
    const end = CODE.indexOf('await _releaseLock()', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const bulk = CODE.slice(start, end)
    expect(bulk).toContain('last_analysis_at: now')
    expect(bulk).not.toContain('analysis_lock_at')
  })

  test('casNow 在占用之前声明且非 const（外层 catch 需引用同一变量）', () => {
    expect(CODE).toContain('let casNow = null')
    const decl = CODE.indexOf('let casNow = null')
    const assign = CODE.indexOf('casNow = new Date()')
    expect(decl).toBeGreaterThan(-1)
    expect(assign).toBeGreaterThan(decl) // 先声明、后赋值
    expect(CODE).not.toContain('const casNow = new Date()')
  })
})
