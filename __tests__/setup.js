/**
 * Jest 测试环境设置
 * 在所有测试运行之前执行
 */

// 设置测试环境变量
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret-32-characters-long'
process.env.ENCRYPTION_KEY = '12345678901234567890123456789012' // 32 字符
process.env.REDIS_HOST = 'localhost'
process.env.REDIS_PORT = '6379'
process.env.LOG_LEVEL = 'error' // 测试时只输出错误日志

// 全局测试超时
jest.setTimeout(10000)

// Mock console 方法以减少测试输出噪音（可选）
global.console = {
  ...console,
  // 保留 error 和 warn，屏蔽 info 和 debug
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: console.warn,
  error: console.error
}

// 清理函数（测试后执行）
afterAll(() => {
  // 清理全局资源
})
