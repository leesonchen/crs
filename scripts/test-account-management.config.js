/**
 * 账户管理测试配置文件
 * 用于配置测试脚本的各种参数和凭据
 */

// 配置模板 - 复制此文件为 test-account-management.config.js 并填入实际值
const config = {
  // 服务配置
  service: {
    // API 基础 URL (默认本地开发环境)
    baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000',
    // 请求超时时间 (毫秒)
    timeout: parseInt(process.env.TEST_TIMEOUT) || 30000,
    // 重试次数
    maxRetries: parseInt(process.env.TEST_MAX_RETRIES) || 3,
    // 重试延迟 (毫秒)
    retryDelay: parseInt(process.env.TEST_RETRY_DELAY) || 1000
  },

  // 管理员配置
  admin: {
    // 管理员用户名
    username: process.env.ADMIN_USERNAME || 'admin',
    // 管理员密码
    password: process.env.ADMIN_PASSWORD || 'admin123',
    // JWT Token (可选，如果不提供会自动登录获取)
    token: process.env.ADMIN_TOKEN || null
  },

  // API Key 配置 (用于测试 API 调用)
  apiKey: {
    // 测试用的 API Key
    key: process.env.TEST_API_KEY || 'cr_test_key_for_account_validation',
    // 如果没有提供，会尝试创建一个新的
    createIfMissing: true,
    // API Key 配额限制
    quota: {
      daily: parseInt(process.env.TEST_API_DAILY_QUOTA) || 1000,
      hourly: parseInt(process.env.TEST_API_HOURLY_QUOTA) || 100
    }
  },

  // 测试用例配置
  testCases: {
    // 是否启用账户禁用测试
    testAccountDisabling: true,
    // 是否启用 API 测试
    testAPICalls: true,
    // 是否启用桥接测试
    testBridgeCalls: true,
    // 是否启用并发测试
    testConcurrent: false,
    // 并发测试数量
    concurrentLimit: 3,

    // Claude API 测试配置
    claude: {
      // 测试模型
      model: 'claude-3-5-haiku-20241022',
      // 最大 tokens
      maxTokens: 100,
      // 测试消息
      messages: [
        {
          role: 'user',
          content: 'Hello, this is a test message for account validation.'
        }
      ]
    },

    // OpenAI API 测试配置
    openai: {
      // 测试模型
      model: 'gpt-4o-mini',
      // 最大 tokens
      maxTokens: 100,
      // 测试输入
      input: [
        {
          role: 'user',
          content: 'Hello, this is a test message for account validation.'
        }
      ],
      // 是否启用工具
      tools: [
        {
          type: 'web_search'
        }
      ]
    },

    // Gemini API 测试配置
    gemini: {
      // 测试模型
      model: 'gemini-pro',
      // 生成配置
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.7
      },
      // 测试内容
      contents: [
        {
          parts: [
            {
              text: 'Hello, this is a test message for account validation.'
            }
          ]
        }
      ]
    },

    // 桥接测试配置
    bridge: {
      // Claude → OpenAI 桥���测试
      claudeToOpenAI: {
        model: 'claude-3-5-haiku-20241022',
        maxTokens: 100,
        messages: [
          {
            role: 'user',
            content: 'Hello, this is a bridge test message from Claude to OpenAI.'
          }
        ]
      },

      // OpenAI → Claude 桥接测试
      openaiToClaude: {
        model: 'gpt-5',
        input: [
          {
            role: 'user',
            content: 'Hello, this is a bridge test message from OpenAI to Claude.'
          }
        ]
      }
    }
  },

  // 输出配置
  output: {
    // 报告输出目录
    reportDir: process.env.TEST_REPORT_DIR || './test-reports',
    // 是否输出详细日志
    verbose: process.env.TEST_VERBOSE === 'true' || false,
    // 是否输出 JSON 格式报告
    jsonOutput: process.env.TEST_JSON_OUTPUT === 'true' || false,
    // 是否保存详细的测试日志
    saveDetailedLogs: process.env.TEST_SAVE_LOGS === 'true' || true,
    // 控制台输出级别 (error, warn, info, debug)
    logLevel: process.env.TEST_LOG_LEVEL || 'info'
  },

  // 账户测试选项
  accountTesting: {
    // 账户启用后的等待时间 (毫秒)
    enableDelay: 500,
    // 测试之间的延迟 (毫秒)
    testDelay: 1000,
    // 失败后重试次数
    maxTestRetries: 2,
    // 跳过特定账户类型 (数组)
    skipAccountTypes: [],
    // 只测试特定账户类型 (数组，为空则测试所有)
    onlyAccountTypes: [],
    // 跳过特定账户 ID (数组)
    skipAccountIds: [],
    // 是否测试不活跃账户
    testInactiveAccounts: false
  },

  // 安全配置
  security: {
    // 是否验证 HTTPS 证书
    verifySSL: process.env.TEST_VERIFY_SSL !== 'false',
    // 是否启用代理
    useProxy: process.env.TEST_USE_PROXY === 'true',
    // 代理配置
    proxy: {
      host: process.env.TEST_PROXY_HOST,
      port: parseInt(process.env.TEST_PROXY_PORT),
      protocol: process.env.TEST_PROXY_PROTOCOL || 'http',
      auth: {
        username: process.env.TEST_PROXY_USERNAME,
        password: process.env.TEST_PROXY_PASSWORD
      }
    }
  }
}

// 验证必需的环境变量或配置
function validateConfig() {
  const errors = []

  if (!config.service.baseURL) {
    errors.push('Service baseURL is required')
  }

  if (!config.admin.username || !config.admin.password) {
    errors.push('Admin username and password are required')
  }

  if (!config.apiKey.key && !config.apiKey.createIfMissing) {
    errors.push('Either API key or createIfMissing flag is required')
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`)
  }
}

// 如果直接运行此文件，执行验证
if (require.main === module) {
  try {
    validateConfig()
    console.log('✅ Configuration is valid')
  } catch (error) {
    console.error('❌ Configuration validation failed:', error.message)
    process.exit(1)
  }
}

module.exports = {
  config,
  validateConfig
}
