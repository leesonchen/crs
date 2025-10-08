module.exports = {
  // 测试环境
  testEnvironment: 'node',

  // 测试文件匹配模式
  testMatch: ['**/__tests__/**/*.test.js', '**/__tests__/**/*.spec.js'],

  // 覆盖率收集
  collectCoverage: false, // 默认关闭，运行时使用 --coverage 开启
  collectCoverageFrom: [
    'src/services/bridgeService.js',
    'src/services/openaiResponsesRelayService.js',
    'src/routes/api.js',
    '!src/**/*.test.js',
    '!src/**/*.spec.js'
  ],

  // 覆盖率阈值
  coverageThreshold: {
    'src/services/bridgeService.js': {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },

  // 覆盖率报告格式
  coverageReporters: ['text', 'lcov', 'html'],

  // 测试超时时间（毫秒）
  testTimeout: 10000,

  // 设置文件（在运行测试之前执行）
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],

  // 模块路径别名（可选，用于简化导入）
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/__tests__/$1'
  },

  // 详细输出
  verbose: true,

  // 清除 mock 状态
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true
}
