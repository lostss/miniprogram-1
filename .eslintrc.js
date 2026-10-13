module.exports = {
  root: true,
  env: {
    es6: true,
  },
  parserOptions: {
    ecmaVersion: 2020,
  },
  extends: ['eslint:recommended'],
  // 2026-09-28 复审（dsh 审计项⑥「三道门形同装饰」）：关掉三条**纯风格**规则 ——
  // 实测 2991 条问题里 prefer-template 984 / prefer-arrow-callback 931 / no-var 908，
  // 三条占 94%，把 lint 变成"永远红着的墙"，于是没人看，真正会崩的错（no-undef 等）被淹没。
  // 例：本轮 dsh 新增的 `reportAI._blockedReportResult` 引用 handler 作用域的 const（必 ReferenceError），
  // 就只被 no-undef 抓到，而它当时埋在那 2900 条里没人跑。
  // 取舍：不再假装强制风格（改风格靠 code review），保留其余全部规则 —— 目标是让 lint 重新成为
  // "崩溃前最后一道门"。prettier 未接入（461 文件待格式化），刻意不做全仓重排（diff 会掩盖真实改动）。
  rules: {
    'no-var': 'off',
    'prefer-template': 'off',
    'prefer-arrow-callback': 'off',
    'prefer-const': 'error',
    'no-console': 'warn',
    'no-throw-literal': 'error',
    'prefer-promise-reject-errors': 'error',
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  overrides: [
    {
      files: ['cloudfunctions/**/*.js'],
      env: { node: true },
      globals: {
        cloud: 'readonly',
        wx: 'readonly',
      },
      rules: {
        'no-console': 'off',
      },
    },
    {
      files: ['miniprogram/**/*.js'],
      // 2026-09-22 全面审计：小程序宿主提供 CommonJS（require/module.exports），
      // 不声明 node env 时 133 条 no-undef 全是 require/module 误报 —— 真正的未定义变量
      // （如本次修掉的 dataWrite/member-write.js 的 memberField）被淹没在噪声里，
      // lint 作为"崩溃前最后一道门"实际失效。开 node env 后 no-undef 归零，真问题一眼可见。
      env: { browser: true, node: true },
      globals: {
        wx: 'readonly',
        App: 'readonly',
        Page: 'readonly',
        Component: 'readonly',
        getApp: 'readonly',
        getCurrentPages: 'readonly',
        cloud: 'readonly',
      },
    },
    {
      files: ['**/*.test.js', 'tests/**/*.js', '**/__tests__/**/*.js'],
      env: { jest: true, node: true },
      // 测试在运行时挂 global.wx（小程序 API 桩），静态检查需声明为只读全局
      globals: { wx: 'readonly' },
    },
  ],
}
