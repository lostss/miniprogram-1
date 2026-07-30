/**
 * _shared/config.js — 统一配置常量（单一事实源）
 */
module.exports = {

  // -- 环境 --
  ENV_ID: process.env.TCB_ENV || 'cloud1-3gan2ae3d3b400f1',

  // -- AI 模型 --
  AI: {
    GROUP: 'cloudbase',
    THINK_MODEL: 'hy3',
    CHAT_MODEL: 'hy3',
    OCR_MODEL: 'hy3',
    SDK_TIMEOUT: 60000,
    THINK_TIMEOUT: 55000,
    MAX_RETRIES: 2,
    OCR_MAX_TOKENS: 1200,
    OCR_TEMPERATURE: 0,
  },

  // -- AI 超时（按场景） --
  AI_TIMEOUT: { CHAT: 30000, ANALYSIS: 55000, REPORT: 30000, OCR: 15000 },

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

  // -- 更新 --
  UPDATE: { DEBOUNCE_MS: 5 * 60 * 1000 },

  // -- 费用 --
  // hy3-preview 定价: $0.004/1K tokens
  COST_PER_1K: 0.004
}
