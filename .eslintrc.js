module.exports = {
  root: true,
  env: {
    es6: true,
  },
  parserOptions: {
    ecmaVersion: 2020,
  },
  extends: ['eslint:recommended'],
  rules: {
    'no-var': 'error',
    'prefer-const': 'error',
    'no-console': 'warn',
    'prefer-template': 'error',
    'prefer-arrow-callback': 'warn',
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
      env: { browser: true, node: false },
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
      files: ['**/*.test.js', '**/__tests__/**/*.js'],
      env: { jest: true, node: true },
    },
  ],
}
