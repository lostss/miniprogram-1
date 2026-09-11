/**
 * _shared/config.js — 统一配置常量（单一事实源）
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

module.exports = {

  // -- 环境 --
  ENV_ID: process.env.TCB_ENV || cloud.DYNAMIC_CURRENT_ENV,

  // -- AI 模型 --
  AI: {
    // GROUP: 小程序成长计划免费额度走 'hunyuan-exp'；'cloudbase' 为付费 TokenHub
    GROUP: 'hunyuan-exp',
    CHAT_MODEL: 'hy3',
    OCR_MODEL: 'hy3',
    SDK_TIMEOUT: 60000,
    // 3000：多产品保单 JSON（products 数组）在 2000 下存在截断 → ai_format 失败风险
    OCR_MAX_TOKENS: 3000,
    OCR_TEMPERATURE: 0,
    // DeepSeek 直连（绕过 TokenHub 限流，并发 2500）
    // 2026-09-10：模型名改用官方推荐名 'deepseek-flash'（= DeepSeek-V4.1-Flash）；
    // 旧名 'deepseek-v4-flash' 官方仍兼容但已下线，实际也由 V4.1 服务
    USE_DIRECT: true,
    DIRECT_BASE_URL: 'https://api.deepseek.com',
    DIRECT_MODEL: 'deepseek-flash',
    DIRECT_API_KEY_ENV: 'DEEPSEEK_API_KEY'
  },

  // -- AI 超时（OCR 专用；CHAT/ANALYSIS/REPORT 无消费者已删） --
  // 实测（2026-09-09 operation_logs 14 天）：AI 提取 avg 4.7s / max 8.2s，零超时 → 15s 余量充足；
  // 25s 只会让失败更晚暴露，已回调（同日内经数据否决，勿再放宽）
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
  // 长期记忆（2026-08-30）：TTL 5min → 30min——基础摘要只在"外部入口更新（版本号校验）或压缩"时重建，
  // 对话内写操作不再 invalidate（写后只失效状态块），前缀缓存（DeepSeek context caching）保持命中
  TOOL_CTX_TTL: 1800000,
  TOOL_CTX_MAX: 20,
  // P1：query 结果缓存（queryPolicies/Members/Facts/MemberProfile，按 familyId+openid 前缀失效）
  QUERY_CACHE_TTL: 300000,
  QUERY_CACHE_MAX: 50,
  // 状态块缓存（写操作后 invalidate 重建；TTL 仅为兜底，防外部更新长时间不感知）
  STATE_BLOCK_TTL: 60000,
  STATE_BLOCK_MAX: 20,
  // 历史注入（append-only 增量记忆）：超过任一预算触发压缩（重建基础摘要 + 读起点后移）
  HISTORY: {
    MAX_MSGS: 300,        // 单 family 注入历史条数上限（压缩触发阈值）
    CHAR_BUDGET: 50000,   // 注入历史总字符预算 ≈ 50K tokens（压缩触发阈值）
    READ_LIMIT: 800       // 单次读取上限（覆盖 MAX_MSGS 后仍需容纳压缩点后增量）
  },

  // -- 费用 --
  // 按模型查价（单位：元/百万 tokens，除 hy3 为美元）。calcTokenUsage 优先用本表，
  // 未命中模型时回落 COST_PER_1K 旧口径（防存量看板断层）。
  // DeepSeek 官方价（2026-09-10 12:00 起生效，此处取"闲时"档，高峰=闲时×2）：
  //   deepseek-flash（V4.1-Flash）: 输入未命中 1 / 缓存命中 0.02 / 输出 4
  //   deepseek-v4-pro            : 输入未命中 4.5 / 缓存命中 0.15 / 输出 13.5
  //   高峰时段：周一至周五 09:00-12:00、14:00-18:00（北京时间）
  // hy3（TokenHub / hunyuan-exp）: $0.004/1K ≈ 4 美元/百万，官方未区分输入输出，沿用旧口径
  PRICING: {
    'deepseek-flash': { in: 1, out: 4, inCached: 0.02, currency: 'CNY' },
    'deepseek-v4-flash': { in: 1, out: 4, inCached: 0.02, currency: 'CNY' },
    'deepseek-v4-pro': { in: 4.5, out: 13.5, inCached: 0.15, currency: 'CNY' },
    hy3: { in: 4, out: 4, inCached: 4, currency: 'USD' }
  },
  DEFAULT_PRICING: { in: 1, out: 4, inCached: 0.02, currency: 'CNY' },
  // 兼容保留（旧口径：hy3-preview $0.004/1K tokens，混合计价）；新代码请用 PRICING
  COST_PER_1K: 0.004
}
