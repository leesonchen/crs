const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const config = require('../../config/config')
const LRUCache = require('../utils/lruCache')
const {
  normalizeModelMapping,
  resolveMappedModel,
  isModelSupported
} = require('../utils/modelMappingHelper')

class OpenAIChatAccountService {
  constructor() {
    // 加密相关常量
    this.ENCRYPTION_ALGORITHM = 'aes-256-cbc'
    this.ENCRYPTION_SALT = 'openai-chat-salt'

    // Redis 键前缀
    this.ACCOUNT_KEY_PREFIX = 'openai_chat_account:'
    this.SHARED_ACCOUNTS_KEY = 'shared_openai_chat_accounts'

    // 🚀 性能优化：缓存派生的加密密钥，避免每次重复计算
    this._encryptionKeyCache = null

    // 🔄 解密结果缓存，提高解密性能
    this._decryptCache = new LRUCache(500)

    // 🧹 定期清理缓存（每10分钟）
    setInterval(
      () => {
        this._decryptCache.cleanup()
        logger.info('🧹 OpenAI-Chat decrypt cache cleanup completed', this._decryptCache.getStats())
      },
      10 * 60 * 1000
    )
  }

  // 创建账户
  async createAccount(options = {}) {
    const {
      name = 'OpenAI Chat Account',
      description = '',
      baseApi = 'https://chatgpt.com', // Chat账户默认使用ChatGPT网站API
      apiKey = '', // API Key（必填，与Responses一致）
      userAgent = '', // 可选：自定义 User-Agent，空则透传原始请求
      priority = 50, // 调度优先级 (1-100)
      proxy = null,
      isActive = true,
      accountType = 'shared', // 'dedicated' or 'shared'
      schedulable = true, // 是否可被调度
      subscriptionExpiresAt = null, // 订阅过期时间（业务字段）
      supportedModels = [] // 支持的模型列表或映射表，空数组/对象表示支持所有
    } = options

    // 验证必填字段
    if (!baseApi || !apiKey) {
      throw new Error('Base API URL and API Key are required for OpenAI-Chat account')
    }

    // 规范化 baseApi（确保不以 / 结尾）
    const normalizedBaseApi = baseApi.endsWith('/') ? baseApi.slice(0, -1) : baseApi

    const accountId = uuidv4()

    // 处理 supportedModels，确保向后兼容
    const processedModels = this._processModelMapping(supportedModels)

    const accountData = {
      id: accountId,
      platform: 'openai-chat',
      name,
      description,
      baseApi: normalizedBaseApi,
      apiKey: this._encryptSensitiveData(apiKey),
      userAgent,
      priority: priority.toString(),
      proxy: proxy ? JSON.stringify(proxy) : '',
      isActive: isActive.toString(),
      accountType,
      schedulable: schedulable.toString(),

      // 订阅过期时间（业务字段）
      subscriptionExpiresAt,

      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      status: 'active',
      errorMessage: '',
      // 时间戳
      updatedAt: new Date().toISOString(),

      // 模型映射：使用supportedModels字段（与Responses保持一致）
      supportedModels: JSON.stringify(processedModels)
    }

    // 保存到 Redis
    await this._saveAccount(accountId, accountData)

    logger.success(`🚀 Created OpenAI-Chat account: ${name} (${accountId})`)

    return {
      ...accountData,
      apiKey: '***' // 返回时隐藏敏感信息
    }
  }

  // 获取账户
  async getAccount(accountId) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
    const accountData = await client.hgetall(key)

    if (!accountData || !accountData.id) {
      return null
    }

    // 解密敏感数据
    accountData.apiKey = this._decryptSensitiveData(accountData.apiKey)

    // 解析 JSON 字段
    if (accountData.proxy) {
      try {
        accountData.proxy = JSON.parse(accountData.proxy)
      } catch (e) {
        accountData.proxy = null
      }
    }

    // 解析 supportedModels 字段
    if (accountData.supportedModels) {
      try {
        accountData.supportedModels = JSON.parse(accountData.supportedModels || '{}')
      } catch (e) {
        accountData.supportedModels = {}
      }
    } else {
      accountData.supportedModels = {}
    }

    return accountData
  }

  // 更新账户
  async updateAccount(accountId, updates) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    // 处理敏感字段加密
    if (updates.apiKey) {
      updates.apiKey = this._encryptSensitiveData(updates.apiKey)
    }

    // 处理 JSON 字段
    if (updates.proxy !== undefined) {
      updates.proxy = updates.proxy ? JSON.stringify(updates.proxy) : ''
    }

    // 处理 supportedModels 字段
    if (updates.supportedModels !== undefined) {
      const processedModels = this._processModelMapping(updates.supportedModels)
      updates.supportedModels = JSON.stringify(processedModels)
    }

    // 更新时间戳
    updates.updatedAt = new Date().toISOString()

    // 更新 Redis
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
    await client.hset(key, updates)

    logger.info(`📝 Updated OpenAI-Chat account: ${account.name}`)

    return { success: true }
  }

  // 删除账户
  async deleteAccount(accountId) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`

    // 从共享账户列表中移除
    await client.srem(this.SHARED_ACCOUNTS_KEY, accountId)

    // 删除账户数据
    await client.del(key)

    logger.info(`🗑️ Deleted OpenAI-Chat account: ${accountId}`)

    return { success: true }
  }

  // 获取所有账户
  async getAllAccounts(includeInactive = false) {
    const client = redis.getClientSafe()
    const accountIds = await client.smembers(this.SHARED_ACCOUNTS_KEY)
    const accounts = []

    for (const accountId of accountIds) {
      const account = await this.getAccount(accountId)
      if (account) {
        // 过滤非活跃账户
        if (includeInactive || account.isActive === 'true') {
          // 隐藏敏感信息
          account.apiKey = '***'

          // 转换布尔值字段
          account.schedulable = account.schedulable !== 'false'
          account.isActive = account.isActive === 'true'

          // 前端显示字段
          account.expiresAt = account.subscriptionExpiresAt || null
          account.platform = account.platform || 'openai-chat'

          accounts.push(account)
        }
      }
    }

    // 直接从 Redis 获取所有账户（包括非共享账户）
    const keys = await client.keys(`${this.ACCOUNT_KEY_PREFIX}*`)
    for (const key of keys) {
      const accountId = key.replace(this.ACCOUNT_KEY_PREFIX, '')
      if (!accountIds.includes(accountId)) {
        const accountData = await client.hgetall(key)
        if (accountData && accountData.id) {
          // 过滤非活跃账户
          if (includeInactive || accountData.isActive === 'true') {
            // 隐藏敏感信息
            accountData.apiKey = '***'

            // 解析 JSON 字段
            if (accountData.proxy) {
              try {
                accountData.proxy = JSON.parse(accountData.proxy)
              } catch (e) {
                accountData.proxy = null
              }
            }

            // 解析 supportedModels 字段
            if (accountData.supportedModels) {
              try {
                accountData.supportedModels = JSON.parse(accountData.supportedModels || '{}')
              } catch (e) {
                accountData.supportedModels = {}
              }
            } else {
              accountData.supportedModels = {}
            }

            // 转换布尔值字段
            accountData.schedulable = accountData.schedulable !== 'false'
            accountData.isActive = accountData.isActive === 'true'

            // 前端显示字段
            accountData.expiresAt = accountData.subscriptionExpiresAt || null
            accountData.platform = accountData.platform || 'openai-chat'

            accounts.push(accountData)
          }
        }
      }
    }

    return accounts
  }

  // 🚫 标记账户为未授权状态（401错误）
  async markAccountUnauthorized(accountId, reason = 'OpenAI Chat账号认证失败（401错误）') {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    const now = new Date().toISOString()
    const currentCount = parseInt(account.unauthorizedCount || '0', 10)
    const unauthorizedCount = Number.isFinite(currentCount) ? currentCount + 1 : 1

    await this.updateAccount(accountId, {
      status: 'unauthorized',
      schedulable: 'false',
      errorMessage: reason,
      unauthorizedAt: now,
      unauthorizedCount: unauthorizedCount.toString()
    })

    logger.warn(
      `🚫 OpenAI-Chat account ${account.name || accountId} marked as unauthorized due to 401 error`
    )

    try {
      const webhookNotifier = require('../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account.name || accountId,
        platform: 'openai-chat',
        status: 'unauthorized',
        errorCode: 'OPENAI_CHAT_UNAUTHORIZED',
        reason,
        timestamp: now
      })
      logger.info(
        `📢 Webhook notification sent for OpenAI-Chat account ${account.name || accountId} unauthorized state`
      )
    } catch (webhookError) {
      logger.error('Failed to send unauthorized webhook notification:', webhookError)
    }
  }

  // 重置账户状态（清除所有异常状态）
  async resetAccountStatus(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    const updates = {
      // 根据是否有有效的 apiKey 来设置 status
      status: account.apiKey ? 'active' : 'created',
      // 恢复可调度状态
      schedulable: 'true',
      // 清除错误相关字段
      errorMessage: '',
      unauthorizedAt: '',
      unauthorizedCount: '0'
    }

    await this.updateAccount(accountId, updates)
    logger.info(`✅ Reset all error status for OpenAI-Chat account ${accountId}`)

    // 发送 Webhook 通知
    try {
      const webhookNotifier = require('../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account.name || accountId,
        platform: 'openai-chat',
        status: 'recovered',
        errorCode: 'STATUS_RESET',
        reason: 'Account status manually reset',
        timestamp: new Date().toISOString()
      })
      logger.info(
        `📢 Webhook notification sent for OpenAI-Chat account ${account.name} status reset`
      )
    } catch (webhookError) {
      logger.error('Failed to send status reset webhook notification:', webhookError)
    }

    return { success: true, message: 'Account status reset successfully' }
  }

  // 更新账户使用统计（记录 token 使用量）
  async updateAccountUsage(accountId, tokens = 0) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    const updates = {
      lastUsedAt: new Date().toISOString()
    }

    // 如果有 tokens 参数且大于0，同时更新使用统计
    if (tokens > 0) {
      const currentTokens = parseInt(account.totalUsedTokens) || 0
      updates.totalUsedTokens = (currentTokens + tokens).toString()
    }

    await this.updateAccount(accountId, updates)
  }

  // 记录使用量（为了兼容性的别名）
  async recordUsage(accountId, tokens = 0) {
    return this.updateAccountUsage(accountId, tokens)
  }

  // 切换调度状态
  async toggleSchedulable(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    const newSchedulableStatus = account.schedulable === 'true' ? 'false' : 'true'
    await this.updateAccount(accountId, {
      schedulable: newSchedulableStatus
    })

    logger.info(
      `🔄 Toggled schedulable status for account ${account.name}: ${newSchedulableStatus}`
    )

    return {
      success: true,
      schedulable: newSchedulableStatus === 'true'
    }
  }

  // ⏰ 检查账户订阅是否已过期
  isSubscriptionExpired(account) {
    if (!account.subscriptionExpiresAt) {
      return false // 未设置过期时间，视为永不过期
    }

    const expiryDate = new Date(account.subscriptionExpiresAt)
    const now = new Date()

    if (expiryDate <= now) {
      logger.debug(
        `⏰ OpenAI-Chat Account ${account.name} (${account.id}) subscription expired at ${account.subscriptionExpiresAt}`
      )
      return true
    }

    return false
  }

  // 加密敏感数据
  _encryptSensitiveData(text) {
    if (!text) {
      return ''
    }

    const key = this._getEncryptionKey()
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(this.ENCRYPTION_ALGORITHM, key, iv)

    let encrypted = cipher.update(text)
    encrypted = Buffer.concat([encrypted, cipher.final()])

    return `${iv.toString('hex')}:${encrypted.toString('hex')}`
  }

  // 解密敏感数据
  _decryptSensitiveData(text) {
    if (!text || text === '') {
      return ''
    }

    // 检查缓存
    const cacheKey = crypto.createHash('sha256').update(text).digest('hex')
    const cached = this._decryptCache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    try {
      const key = this._getEncryptionKey()
      const [ivHex, encryptedHex] = text.split(':')

      const iv = Buffer.from(ivHex, 'hex')
      const encryptedText = Buffer.from(encryptedHex, 'hex')

      const decipher = crypto.createDecipheriv(this.ENCRYPTION_ALGORITHM, key, iv)
      let decrypted = decipher.update(encryptedText)
      decrypted = Buffer.concat([decrypted, decipher.final()])

      const result = decrypted.toString()

      // 存入缓存（5分钟过期）
      this._decryptCache.set(cacheKey, result, 5 * 60 * 1000)

      return result
    } catch (error) {
      logger.error('Decryption error:', error)
      return ''
    }
  }

  // 获取加密密钥
  _getEncryptionKey() {
    if (!this._encryptionKeyCache) {
      this._encryptionKeyCache = crypto.scryptSync(
        config.security.encryptionKey,
        this.ENCRYPTION_SALT,
        32
      )
    }
    return this._encryptionKeyCache
  }

  // 保存账户到 Redis
  async _saveAccount(accountId, accountData) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`

    // 保存账户数据
    await client.hset(key, accountData)

    // 添加到共享账户列表
    if (accountData.accountType === 'shared') {
      await client.sadd(this.SHARED_ACCOUNTS_KEY, accountId)
    }
  }

  // 🔄 处理模型映射，确保向后兼容
  _processModelMapping(supportedModels) {
    return normalizeModelMapping(supportedModels)
  }

  // 🔍 检查模型是否支持
  isModelSupported(supportedModels, requestedModel) {
    return isModelSupported(supportedModels, requestedModel)
  }

  // 🔄 获取映射后的模型名称
  getMappedModel(supportedModels, requestedModel) {
    return resolveMappedModel(supportedModels, requestedModel).mappedModel || requestedModel
  }
}

module.exports = new OpenAIChatAccountService()
