/**
 * write-tools 契约测试 — 对话"写工具集合"的单一事实源（流程审计 2026-09-18 P2-5）。
 *
 * 原状：前端 chat-panel 自持一份手写白名单（判断"本轮工具是否产生写入"→ 是否通知报告刷新），
 * 漏了 deletePolicy / deleteMember / deleteFact → 用户确认删除后小秘回"已删除"、报告不刷新。
 * 后端 conversationAI 另有完整一份（query 缓存失效用）。两份人工同步必然漂移。
 */
const fs = require('fs')
const path = require('path')
const { WRITE_TOOLS, isWriteTool } = require('../cloudfunctions/_shared/write-tools')

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
}

describe('write-tools 契约', () => {
  test('覆盖全部会产生写入的对话工具（含删除类——原前端镜像漏的正是这三个）', () => {
    const expectWrite = ['upsertMember', 'updateFinances', 'addPolicy', 'updatePolicy', 'addFact', 'createFamily', 'deletePolicy', 'deleteMember', 'deleteFact']
    expectWrite.forEach(t => expect(isWriteTool(t)).toBe(true))
  })

  test('只读/分析工具不在集合内（避免无谓刷新与语义混淆）', () => {
    // triggerAnalysis 会改报告但**不是写工具**（另有 hasReportRefresh 分支承担），刻意不并入
    ;['queryPolicies', 'queryMembers', 'queryFacts', 'queryMemberProfile', 'triggerAnalysis'].forEach(t => {
      expect(isWriteTool(t)).toBe(false)
    })
  })

  test('每个工具名都真实存在于 conversationAI 工具 schema（防拼写漂移）', () => {
    const src = read('cloudfunctions/conversationAI/tools.js')
    WRITE_TOOLS.forEach(t => expect(src).toContain("name: '" + t + "'"))
  })

  test('前端副本与主源一致（sync-shared 分叉守护）', () => {
    const front = require('../miniprogram/utils/write-tools')
    expect(front.WRITE_TOOLS).toEqual(WRITE_TOOLS)
  })

  test('前端经契约判定，不得复现内联手写工具数组（分叉守护）', () => {
    const src = read('miniprogram/components/chat-panel/index.js')
    expect(src).toContain("require('../../utils/write-tools')")
    expect(src).toContain('isWriteTool(')
    // 反向守卫：原镜像的特征（手写五个工具名的字面量数组）不得复现
    expect(src).not.toMatch(/\[\s*'upsertMember'\s*,\s*'updateFinances'/)
  })

  test('后端 conversationAI 亦消费契约（不再自持 Set 字面量）', () => {
    const src = read('cloudfunctions/conversationAI/index.js')
    expect(src).toContain("require('./_shared/write-tools')")
    expect(src).not.toMatch(/new Set\(\['upsertMember'/)
  })
})
