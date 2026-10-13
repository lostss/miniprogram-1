/**
 * ai-purposes — AI 调用用途枚举（观测/成本归因的单一事实源）
 *
 * 2026-09-15（架构审查候选 3）：原先是 10 个字面量散落在 ai-client / ocr-extractor /
 * tool-orchestration / reportAI/index 四个文件里，新增调用点靠手打字面量，
 * 聚合查询时拼写漂移无从察觉。
 *
 * ⚠️ 本文件**刻意不依赖任何东西**（尤其不 require config）：
 * config.js 在模块顶层执行 `cloud.init()`，任何 require 它的模块在加载期就需要 wx-server-sdk。
 * tool-orchestration 这类"懒加载以避免启动期炸裂"的模块必须能在不初始化 SDK 的前提下拿到枚举。
 * 需要从 config 取值的调用方仍可用 `config.AI_PURPOSE`（config 从这里 re-export）。
 */
const AI_PURPOSE = {
  CHAT: 'chat',                            // callChat 默认
  CHAT_TOOLS: 'chat_tools',                // callChatWithTools 默认
  CHAT_TOOLS_DIRECT: 'chat_tools_direct',  // callChatWithToolsDirect 默认
  DIRECT: 'direct',                        // callChatDirect 默认
  OCR_EXTRACT: 'ocr_extract',              // OCR 字段提取
  CONVERSATION_PHASE1: 'conversation_phase1',             // 对话主通道（DeepSeek 直连）
  CONVERSATION_PHASE1_HY3: 'conversation_phase1_hy3',     // 同上，hy3 兜底路径
  CONVERSATION_RETRY_DIRECT: 'conversation_retry_direct', // 强指令重试（直连）
  CONVERSATION_RETRY_HY3: 'conversation_retry_hy3',
  REPORT_GENERATE: 'report_generate'       // 报告生成
}

module.exports = { AI_PURPOSE }
