/**
 * Bridge Service - AI API 格式桥接服务
 *
 * 职责（简化后）：
 * 1. 按需进行不同 AI API 格式之间的转换（Claude ↔ OpenAI）
 * 2. 账户对象标准化（解密、字段补全、类型标识）
 * 3. 双层模型映射：系统级（Layer 1）+ 账户级（Layer 3）
 *
 * 设计原则：
 * - 按需调用：只在路由层判断需要桥接时才执行
 * - 双层映射：移除了调度器级（Layer 2）的复杂度
 * - 单一职责：只做格式转换，不涉及网络请求
 * - 显式类型：使用明确的类型标识，避免隐式推断
 */

const logger = require('../utils/logger')
const ClaudeToOpenAIResponsesConverter = require('./claudeToOpenAIResponses')
const OpenAIResponsesToClaudeConverter = require('./openaiResponsesToClaude')
const OpenAIToClaudeConverter = require('./openaiToClaude')
const { CODEX_CLI_INSTRUCTIONS, INCOMPATIBLE_FIELDS } = require('../../config/codexInstructions')

class BridgeService {
  constructor() {
    // 转换器缓存
    this._converterCache = new Map()

    // 配置缓存（避免频繁读取）
    this._configCache = null
    this._configCacheTime = 0
    this._configCacheTTL = 60000 // 1分钟
  }

  /**
   * Claude → OpenAI 桥接
   * @param {Object} claudeRequest - Claude API 格式请求
   * @param {String} accountId - 账户ID
   * @param {String} accountType - 账户类型 ('openai' | 'openai-responses')
   * @returns {Promise<BridgeResult>}
   */
  async bridgeClaudeToOpenAI(claudeRequest, accountId, accountType) {
    const startTime = Date.now()

    try {
      logger.info(`🌉 Starting Claude → OpenAI bridge`, {
        accountId,
        accountType,
        model: claudeRequest.model,
        stream: Boolean(claudeRequest.stream)
      })

      // 1. 获取原始账户
      const rawAccount = await this._fetchAccount(accountId, accountType)
      if (!rawAccount) {
        throw new BridgeError(`Account not found: ${accountId}`, 'ACCOUNT_NOT_FOUND', {
          accountId,
          accountType
        })
      }

      // 2. 标准化账户对象
      const standardAccount = this._standardizeOpenAIAccount(rawAccount, accountType)
      logger.debug(`🔧 Account standardized`, {
        accountId: standardAccount.id,
        accountName: standardAccount.name,
        platform: standardAccount.platform,
        hasApiKey: !!standardAccount.apiKey,
        hasProxy: !!standardAccount.proxy
      })

      // 3. 双层模型映射：Layer 1 (系统级) + Layer 3 (账户级)
      const { systemMapping, defaultModel } = await this._getSystemLevelMapping('claude-to-openai')

      // Layer 1: 系统级虚拟模型映射
      const currentModel = claudeRequest.model
      const systemModel = systemMapping[currentModel] || defaultModel
      logger.info(`📍 Layer 1 (System): ${currentModel} → ${systemModel}`)

      // 4. 转换请求格式
      const converter = this._getConverter('ClaudeToOpenAIResponses', {
        modelMapping: systemMapping,
        defaultModel
      })
      const openaiRequest = converter.convertRequest(claudeRequest)
      openaiRequest.model = systemModel // 使用系统级映射的模型

      // Layer 3: 账户级模型能力适配（同平台降级）
      const accountMapping = standardAccount.modelMapping || {}
      const finalModel = accountMapping[systemModel] || systemModel

      if (finalModel !== systemModel) {
        logger.info(
          `📍 Layer 3 (Account): ${systemModel} → ${finalModel} (account capability adaptation)`
        )
        openaiRequest.model = finalModel
      }

      // 6. OpenAI OAuth 特殊处理（Codex CLI instructions）
      if (accountType === 'openai') {
        openaiRequest.store = false

        if (
          !openaiRequest.instructions ||
          !openaiRequest.instructions.startsWith('You are a coding agent')
        ) {
          INCOMPATIBLE_FIELDS.forEach((field) => delete openaiRequest[field])
          openaiRequest.instructions = CODEX_CLI_INSTRUCTIONS
          logger.debug('📝 Added Codex CLI instructions to OpenAI OAuth bridge request')
        }
      }

      // 7. 记录完整映射链
      logger.info(
        `🔄 Complete mapping chain: ${currentModel} → ${layer1Model}${finalModel !== layer1Model ? ` → ${finalModel}` : ''}`
      )

      // 8. 构建桥接信息
      const bridgeInfo = {
        source: 'claude',
        target: 'openai',
        accountType,
        converter: 'ClaudeToOpenAIResponses',
        modelMapping: {
          original: currentModel,
          systemLevel: layer1Model,
          accountLevel: finalModel,
          chain: [currentModel, layer1Model, finalModel].filter(
            (m, i, arr) => i === 0 || m !== arr[i - 1]
          )
        },
        duration: Date.now() - startTime
      }

      logger.info(`✅ Bridge completed in ${bridgeInfo.duration}ms`)

      return {
        request: openaiRequest,
        account: standardAccount,
        bridgeInfo
      }
    } catch (error) {
      logger.error('❌ Bridge service error:', error)
      throw error
    }
  }

  /**
   * OpenAI → Claude 桥接（反向）
   * @param {Object} openaiRequest - OpenAI API 格式请求
   * @param {String} accountId - 账户ID
   * @param {String} accountType - 账户类型 ('claude-official' | 'claude-console' | 'bedrock')
   * @returns {Promise<BridgeResult>}
   */
  async bridgeOpenAIToClaude(openaiRequest, accountId, accountType) {
    const startTime = Date.now()

    try {
      logger.info(`🌉 Starting OpenAI → Claude bridge`, {
        accountId,
        accountType,
        model: openaiRequest.model,
        stream: Boolean(openaiRequest.stream)
      })

      // 1. 获取原始账户
      const rawAccount = await this._fetchClaudeAccount(accountId, accountType)
      if (!rawAccount) {
        throw new BridgeError(`Claude account not found: ${accountId}`, 'ACCOUNT_NOT_FOUND', {
          accountId,
          accountType
        })
      }

      // 2. 标准化账户对象
      const standardAccount = this._standardizeClaudeAccount(rawAccount, accountType)

      // 3. 双层模型映射：Layer 1 (系统级) + Layer 3 (账户级)
      const { systemMapping, defaultModel } = await this._getSystemLevelMapping('openai-to-claude')

      // Layer 1: 系统级虚拟模型映射
      const currentModel = openaiRequest.model
      const systemModel = systemMapping[currentModel] || defaultModel
      logger.info(`📍 Layer 1 (System): ${currentModel} → ${systemModel}`)

      // 4. 检测请求格式并选择合适的转换器
      const isResponsesFormat =
        openaiRequest.input !== undefined || openaiRequest.instructions !== undefined
      const converterType = isResponsesFormat ? 'OpenAIResponsesToClaude' : 'OpenAIToClaude'

      logger.debug(
        `📋 Detected request format: ${isResponsesFormat ? 'OpenAI Responses' : 'OpenAI Chat'}`
      )

      // 5. 转换请求格式
      const converter = this._getConverter(converterType)
      const claudeRequest = converter.convertRequest(openaiRequest)
      claudeRequest.model = systemModel // 使用系统级映射的模型

      // Layer 3: 账户级模型能力适配（同平台降级）
      const accountMapping = standardAccount.modelMapping || {}
      const finalModel = accountMapping[systemModel] || systemModel

      if (finalModel !== systemModel) {
        logger.info(
          `📍 Layer 3 (Account): ${systemModel} → ${finalModel} (account capability adaptation)`
        )
        claudeRequest.model = finalModel
      }

      // 7. 记录完整映射链
      logger.info(
        `🔄 Complete mapping chain: ${currentModel} → ${layer1Model}${finalModel !== layer1Model ? ` → ${finalModel}` : ''}`
      )

      // 8. 构建桥接信息
      const bridgeInfo = {
        source: isResponsesFormat ? 'openai-responses' : 'openai',
        target: 'claude',
        accountType,
        converter: converterType,
        requestFormat: isResponsesFormat ? 'responses' : 'chat',
        modelMapping: {
          original: currentModel,
          systemLevel: layer1Model,
          accountLevel: finalModel,
          chain: [currentModel, layer1Model, finalModel].filter(
            (m, i, arr) => i === 0 || m !== arr[i - 1]
          )
        },
        duration: Date.now() - startTime
      }

      logger.info(`✅ Bridge completed in ${bridgeInfo.duration}ms`)

      return {
        request: claudeRequest,
        account: standardAccount,
        bridgeInfo
      }
    } catch (error) {
      logger.error('❌ Bridge service error:', error)
      throw error
    }
  }

  /**
   * 标准化 OpenAI 账户对象
   * @private
   */
  _standardizeOpenAIAccount(rawAccount, accountType) {
    const account = { ...rawAccount }

    // 1. 设置显式类型
    account.accountType = accountType
    account.platform = accountType === 'openai' ? 'openai-oauth' : 'openai-responses'

    // 2. 处理认证信息
    if (accountType === 'openai') {
      // OAuth 账户：accessToken 加密存储，需解密
      if (account.accessToken && !account.apiKey) {
        const openaiAccountService = require('./openaiAccountService')
        account.apiKey = openaiAccountService.decrypt(account.accessToken)
      }

      // Codex API 特殊配置
      account.baseApi = account.baseApi || 'https://chatgpt.com/backend-api/codex'
      account.chatgptAccountId = account.accountId || account.chatgptUserId

      logger.debug(`🔑 OpenAI OAuth account ID for Codex API: ${account.chatgptAccountId}`)
    } else {
      // API Key 账户：accessToken 就是 apiKey（已解密）
      account.apiKey = account.accessToken || account.apiKey
      account.baseApi = account.baseApi || 'https://api.openai.com'
    }

    // 3. 验证必需字段
    if (!account.apiKey) {
      throw new BridgeError(
        `Account ${account.id} missing apiKey after standardization`,
        'MISSING_CREDENTIALS',
        { accountId: account.id, accountType }
      )
    }

    return account
  }

  /**
   * 标准化 Claude 账户对象
   * @private
   */
  _standardizeClaudeAccount(rawAccount, accountType) {
    const account = { ...rawAccount }

    // 1. 设置显式类型
    account.accountType = accountType
    account.platform = accountType

    // 2. 处理认证信息
    if (accountType === 'claude-official') {
      // Claude 官方 OAuth 账户
      if (account.sessionKey && !account.apiKey) {
        const claudeAccountService = require('./claudeAccountService')
        account.apiKey = claudeAccountService.decrypt(account.sessionKey)
      }
      account.baseApi = 'https://api.anthropic.com'
    } else if (accountType === 'claude-console') {
      // Claude Console 账户
      account.baseApi = 'https://api.claude.ai'
    } else if (accountType === 'bedrock') {
      // AWS Bedrock
      account.baseApi = account.baseApi || 'bedrock-runtime'
    }

    // 3. 验证必需字段（Bedrock 不需要 apiKey）
    if (!account.apiKey && accountType !== 'bedrock') {
      throw new BridgeError(`Claude account ${account.id} missing apiKey`, 'MISSING_CREDENTIALS', {
        accountId: account.id,
        accountType
      })
    }

    return account
  }

  /**
   * 获取账户（OpenAI）
   * @private
   */
  async _fetchAccount(accountId, accountType) {
    if (accountType === 'openai') {
      const openaiAccountService = require('./openaiAccountService')
      return await openaiAccountService.getAccount(accountId)
    } else {
      const openaiResponsesAccountService = require('./openaiResponsesAccountService')
      return await openaiResponsesAccountService.getAccount(accountId)
    }
  }

  /**
   * 获取账户（Claude）
   * @private
   */
  async _fetchClaudeAccount(accountId, accountType) {
    if (accountType === 'claude-official') {
      const claudeAccountService = require('./claudeAccountService')
      return await claudeAccountService.getAccount(accountId)
    } else if (accountType === 'claude-console') {
      const claudeConsoleAccountService = require('./claudeConsoleAccountService')
      return await claudeConsoleAccountService.getAccount(accountId)
    } else if (accountType === 'bedrock') {
      const bedrockAccountService = require('./bedrockAccountService')
      const result = await bedrockAccountService.getAccount(accountId)
      return result.success ? result.data : null
    }
    return null
  }

  /**
   * 获取系统级模型映射配置（Layer 1）
   * @private
   * @param {String} direction - 'claude-to-openai' 或 'openai-to-claude'
   * @returns {Object} { systemMapping, defaultModel }
   */
  async _getSystemLevelMapping(direction) {
    try {
      const redis = require('../models/redis')
      const client = redis.getClientSafe()
      const bridgeConfigStr = await client.get('system:bridge_config')

      let systemMapping = {}
      let defaultModel = 'gpt-5'

      if (bridgeConfigStr) {
        const bridgeConfig = JSON.parse(bridgeConfigStr)

        if (direction === 'claude-to-openai') {
          systemMapping = bridgeConfig.claudeToOpenai?.modelMapping || {}
          defaultModel = bridgeConfig.claudeToOpenai?.defaultModel || 'gpt-5'
        } else if (direction === 'openai-to-claude') {
          systemMapping = bridgeConfig.openaiToClaude?.modelMapping || {}
          defaultModel = bridgeConfig.openaiToClaude?.defaultModel || 'claude-3-5-sonnet-20241022'
        }
      } else {
        // 如果没有配置，使用默认值
        logger.warn(`⚠️ No system bridge config found, using defaults for ${direction}`)
        if (direction === 'claude-to-openai') {
          defaultModel = 'gpt-5'
        } else {
          defaultModel = 'claude-3-5-sonnet-20241022'
        }
      }

      return { systemMapping, defaultModel }
    } catch (error) {
      logger.error(`❌ Failed to get system-level mapping for ${direction}:`, error)
      // 返回默认值
      return {
        systemMapping: {},
        defaultModel: direction === 'claude-to-openai' ? 'gpt-5' : 'claude-3-5-sonnet-20241022'
      }
    }
  }

  /**
   * 获取转换器实例（带缓存）
   * @private
   */
  _getConverter(type, options = {}) {
    const key = `${type}-${JSON.stringify(options)}`

    if (!this._converterCache.has(key)) {
      let converter

      if (type === 'ClaudeToOpenAIResponses') {
        converter = new ClaudeToOpenAIResponsesConverter(options)
      } else if (type === 'OpenAIResponsesToClaude') {
        converter = new OpenAIResponsesToClaudeConverter()
      } else if (type === 'OpenAIToClaude') {
        converter = new OpenAIToClaudeConverter()
      } else {
        throw new Error(`Unknown converter type: ${type}`)
      }

      this._converterCache.set(key, converter)
    }

    return this._converterCache.get(key)
  }
}

/**
 * Bridge Error 类
 */
class BridgeError extends Error {
  constructor(message, code, details) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

// 导出单例
module.exports = new BridgeService()
module.exports.BridgeService = BridgeService
module.exports.BridgeError = BridgeError
