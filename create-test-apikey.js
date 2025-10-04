// 快速创建测试API Key的脚本
// 需要从项目根目录运行: node create-test-apikey.js

// 设置NODE_PATH让模块解析正确工作
process.env.NODE_PATH = __dirname

async function createTestKey() {
  try {
    // 先初始化 Redis 连接
    const redis = require('./src/models/redis')
    await redis.connect()

    // 再加载 apiKeyService
    const apiKeyService = require('./src/services/apiKeyService')

    const result = await apiKeyService.generateApiKey({
      name: 'BridgeTest',
      description: 'Test API key for Claude bridge functionality',
      tokenLimit: 10000000,
      permissions: 'all',
      isActive: true
    })

    console.log('\n✅ API Key created successfully!')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🔑 API Key:', result.apiKey)
    console.log('📝 Name:', result.name)
    console.log('🆔 ID:', result.id)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    await redis.disconnect()
    process.exit(0)
  } catch (error) {
    console.error('\n❌ Failed to create API key:', error.message)
    console.error('Stack:', error.stack)
    process.exit(1)
  }
}

createTestKey()
