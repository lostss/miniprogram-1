/**
 * _shared/config.js — 统一配置常量（单一事实源）
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

module.exports = {

  // -- 环境 --
  // I-1 修复：移除硬编码生产 ENV_ID 兜底（避免本地误连生产）；IS_DEV 由部署时 NODE_ENV 注入
  ENV_ID: process.env.TCB_ENV || cloud.DYNAMIC_CURRENT_ENV,
  IS_DEV: process.env.NODE_ENV !== 'production',

  // -- AI 模型 --
  AI: {
    // GROUP: 小程序成长计划免费额度走 'hunyuan-exp'；'cloudbase' 为付费 TokenHub
    GROUP: 'hunyuan-exp',
    CHAT_MODEL: 'hy3',
    OCR_MODEL: 'hy3',
    SDK_TIMEOUT: 60000,
    OCR_MAX_TOKENS: 2000,
    OCR_TEMPERATURE: 0,
    // 批量提取（aiExtractBatch，R2 后仅服务单图）
    OCR_BATCH_MAX_TOKENS: 4000,       // 单图提取输出 token 上限（实际需求 ~2-4K；R2 单图化后不再需要 16000）
    OCR_BATCH_TIMEOUT: 55000,         // 单图 AI 超时（实际 7-30s；必须 < SDK_TIMEOUT 60s，否则 SDK 先断）
    OCR_BATCH_TEMPERATURE: 0,
    // DeepSeek 直连（绕过 TokenHub 限流，并发 2500）
    USE_DIRECT: true,
    DIRECT_BASE_URL: 'https://api.deepseek.com',
    DIRECT_MODEL: 'deepseek-v4-flash',
    DIRECT_API_KEY_ENV: 'DEEPSEEK_API_KEY'
  },

  // -- AI 超时（OCR 专用；CHAT/ANALYSIS/REPORT 无消费者已删） --
  AI_TIMEOUT: { OCR: 15000 },

  // -- 安全 --
  SECURITY: {
    MAX_INPUT: 16000,
    RATE_LIMIT_WINDOW_MS: 60000,
    RATE_LIMIT_MAX: 60,
    CONTENT_AUDIT_TRUNCATE: 5000,
  },

  // -- OCR --
  OCR: {
    REGION: 'ap-guangzhou',
    ENDPOINT: 'ocr.tencentcloudapi.com',
  },

  // -- 画像 --
  PORTRAIT: {
    DECAY_MONTHS: 6,
    DECAY_STEP: 0.2,
  },

  // -- 报告 --
  REPORT_THROTTLE_MS: 30 * 1000,
  REPORT_KEEP_VERSIONS: 3,

  // -- 工具上下文缓存（R3v2 #5：参数外移，原硬编码在 conversationAI/index.js） --
  // TTL 30s（原 5s）：postProcess 每轮全量查 5 集合，5s 仅覆盖连击消息；写工具成功已 invalidate，TTL 长不引入脏数据
  TOOL_CTX_TTL: 30000,
  TOOL_CTX_MAX: 20,

  // -- 费用 --
  // hy3-preview 定价: $0.004/1K tokens
  COST_PER_1K: 0.004
}
