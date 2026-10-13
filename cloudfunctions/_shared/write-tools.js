/**
 * write-tools.js — 「对话工具中哪些属于写操作」的单一事实源（跨树契约）。
 *
 * 背景（流程审计 2026-09-18 P2-5）：前端 chat-panel 用一个**手写镜像**的白名单判断
 * "本轮工具是否产生了写入"，据此决定要不要通知报告页刷新。该镜像漏了三个删除类工具
 * （deletePolicy / deleteMember / deleteFact）→ 用户确认删除后小秘回"已删除"，
 * 报告却仍显示那张保单，直到手动下拉。而后端 `conversationAI` 早已另有一份
 * 完整集合（含删除类）用于 query 缓存失效 —— 两份人工同步的清单，注定漂移。
 *
 * 现收敛为单一事实源，两侧共同 consume（前端经 sync-shared 同步副本）：
 *   - 后端：`conversationAI/index.js`（写工具成功后按前缀失效 query 缓存）
 *   - 前端：`components/chat-panel/index.js`（写工具成功 → 通知报告页刷新）
 *
 * 注意语义边界：本集合只回答"该工具是否会产生写入"，**不**回答"是否需要确认卡"——
 * 确认策略另有其表（CONFIRM_TOOLS / confirm-handler），两者刻意不合并：
 * addFact 是写操作但免确认；triggerAnalysis 会改报告但不是写工具。
 */

// 与 conversationAI/tools.js 暴露的工具名一一对应（新增写工具必须同步此处，否则前端漏刷新）
const WRITE_TOOLS = [
  'upsertMember', 'updateFinances', 'addPolicy', 'updatePolicy', 'addFact', 'createFamily',
  'deletePolicy', 'deleteMember', 'deleteFact'
]

/** 是否写操作（对话工具名） */
function isWriteTool(name) {
  return WRITE_TOOLS.indexOf(name) !== -1
}

module.exports = { WRITE_TOOLS, isWriteTool }
