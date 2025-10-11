const crypto = require('crypto')
const Redis = require('ioredis')

async function createApiKey() {
  const redis = new Redis({
    host: 'localhost',
    port: 6379,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3,
    lazyConnect: true
  })

  try {
    await redis.connect()

    // 生成API key
    const apiKey = 'cr_' + crypto.randomBytes(32).toString('hex')

    // 使用与apiKeyService相同的哈希方法（包含加密密钥）
    const encryptionKey = 'CHANGE-THIS-32-CHARACTER-KEY-NOW' // 从config.js读取的默认值
    const keyHash = crypto.createHash('sha256').update(apiKey + encryptionKey).digest('hex')

    const keyId = 'key_' + Date.now()
    const now = new Date().toISOString()

    // 使用项目中的正确字段格式
    const keyData = {
      id: keyId,
      name: 'Stream Test Key',
      description: 'For testing streaming responses',
      apiKey: keyHash, // 存储哈希值而不是原始key
      createdAt: now,
      updatedAt: now,
      isActive: 'true',
      dailyQuota: '1000',
      usedToday: '0',
      lastUsedAt: '',
      expiresAt: ''
    }

    // 存储到apikey:{keyId}
    await redis.hset(`apikey:${keyId}`, keyData)
    await redis.expire(`apikey:${keyId}`, 86400 * 365)

    // 存储哈希映射到apikey:hash_map
    await redis.hset('apikey:hash_map', keyHash, keyId)

    console.log('✅ Generated new API Key:', apiKey)
    console.log('📝 Key Info:', {
      name: keyData.name,
      id: keyId,
      quota: keyData.dailyQuota,
      description: keyData.description,
      keyHash: keyHash
    })

    // 保存API key到文件以便测试
    require('fs').writeFileSync('/tmp/test-api-key.txt', apiKey)
    console.log('💾 API Key saved to /tmp/test-api-key.txt')

    return apiKey
  } catch (error) {
    console.error('❌ Error creating API key:', error)
  } finally {
    await redis.quit()
  }
}

createApiKey()