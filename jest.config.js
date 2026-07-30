// jest.config.js
// 微信小程序项目 Jest 配置

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  // 模块路径映射（模拟小程序 require 路径）
  moduleNameMapper: {
    '^wx-server-sdk$': '<rootDir>/tests/__mocks__/cloudSDKMock.js',
    '^@cloudbase/node-sdk$': '<rootDir>/tests/__mocks__/cloudbaseNodeSDKMock.js'
  },
  // 超时设置（云函数测试可能需要更长时间）
  testTimeout: 60000,
  // 覆盖率配置
  collectCoverageFrom: [
    'cloudfunctions/**/*.js',
    'miniprogram/services/**/*.js',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary']
};
