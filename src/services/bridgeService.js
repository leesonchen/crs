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
        defaultModel,
        // 简化架构：禁用流程模拟
        enableFlowSimulation: false,
        clientType: options.clientType || 'unknown'
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
        `🔄 Complete mapping chain: ${currentModel} → ${systemModel}${finalModel !== systemModel ? ` → ${finalModel}` : ''}`
      )

      // 8. 构建桥接信息
      const bridgeInfo = {
        source: 'claude',
        target: 'openai',
        accountType,
        converter: 'ClaudeToOpenAIResponses',
        modelMapping: {
          original: currentModel,
          systemLevel: systemModel,
          accountLevel: finalModel,
          chain: [currentModel, systemModel, finalModel].filter(
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
   * @param {Object} options - 桥接选项
   * @param {String} options.clientType - 客户端类型
   * @returns {Promise<BridgeResult>}
   */
  async bridgeOpenAIToClaude(openaiRequest, accountId, accountType, options = {}) {
    const startTime = Date.now()

    try {
      logger.info(`🌉 Starting OpenAI → Claude bridge`, {
        accountId,
        accountType,
        model: openaiRequest.model,
        stream: Boolean(openaiRequest.stream),
        clientType: options.clientType || 'unknown'
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
      const converter = this._getConverter(converterType, {
        clientType: options.clientType || 'unknown',
        targetFormat: 'claude'
      })
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

      // 7. 记录完整映���链
      logger.info(
        `🔄 Complete mapping chain: ${currentModel} → ${systemModel}${finalModel !== systemModel ? ` → ${finalModel}` : ''}`
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
          systemLevel: systemModel,
          accountLevel: finalModel,
          chain: [currentModel, systemModel, finalModel].filter(
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

    // 🔍 调试日志：检查原始账户数据
    logger.info(`🔍 [Bridge] Raw Claude account data:`, {
      id: account.id,
      name: account.name,
      hasSessionKey: !!account.sessionKey,
      hasAccessToken: !!account.accessToken,
      hasApiKey: !!account.apiKey,
      hasClaudeAiOauth: !!account.claudeAiOauth,
      sessionKeyLength: account.sessionKey ? account.sessionKey.length : 0,
      accessTokenLength: account.accessToken ? account.accessToken.length : 0,
      apiKeyLength: account.apiKey ? account.apiKey.length : 0,
      claudeAiOauthLength: account.claudeAiOauth ? account.claudeAiOauth.length : 0,
      accountType,
      allFields: Object.keys(account)
    })

    // 1. 设置显式类型
    account.accountType = accountType
    account.platform = accountType

    // 2. 处理认证信息
    if (accountType === 'claude-official') {
      // Claude 官方 OAuth 账户
      if (!account.apiKey) {
        logger.info(
          `🔍 [Bridge] No apiKey found, checking sessionKey, accessToken, and claudeAiOauth`
        )

        // 检查 claudeAiOauth 字段（加密的OAuth数据）
        if (account.claudeAiOauth) {
          logger.info(`🔑 [Bridge] Found claudeAiOauth field, attempting to extract accessToken`)
          try {
            let oauthData
            if (typeof account.claudeAiOauth === 'string') {
              oauthData = JSON.parse(account.claudeAiOauth)
            } else {
              oauthData = account.claudeAiOauth
            }

            logger.info(`🔍 [Bridge] OAuth data fields:`, {
              hasAccessToken: !!oauthData.accessToken,
              hasRefreshToken: !!oauthData.refreshToken,
              accessTokenLength: oauthData.accessToken ? oauthData.accessToken.length : 0
            })

            if (oauthData.accessToken) {
              account.apiKey = oauthData.accessToken
              logger.info(
                `✅ [Bridge] Successfully extracted accessToken from claudeAiOauth, length: ${account.apiKey.length}`
              )
            } else {
              logger.warn(`⚠️ [Bridge] No accessToken found in claudeAiOauth`)
            }
          } catch (error) {
            logger.error(`❌ [Bridge] Failed to parse claudeAiOauth:`, error)
          }
        }

        // 回退到 sessionKey
        if (!account.apiKey && account.sessionKey) {
          // 优先使用 sessionKey（加密存储）
          logger.info(`🔑 [Bridge] Using sessionKey to derive apiKey`)
          const claudeAccountService = require('./claudeAccountService')
          try {
            account.apiKey = claudeAccountService.decrypt(account.sessionKey)
            logger.info(
              `✅ [Bridge] Successfully derived apiKey from sessionKey, length: ${account.apiKey.length}`
            )
          } catch (error) {
            logger.error(`❌ [Bridge] Failed to decrypt sessionKey:`, error)
          }
        } else if (!account.apiKey && account.accessToken) {
          // 回退到 accessToken（可能是测试数据或已解密的token）
          logger.info(`🔑 [Bridge] Using accessToken as apiKey directly`)
          account.apiKey = account.accessToken
          logger.info(`✅ [Bridge] Set apiKey from accessToken, length: ${account.apiKey.length}`)
        }

        if (!account.apiKey) {
          logger.warn(
            `⚠️ [Bridge] No sessionKey, accessToken, or claudeAiOauth with accessToken found for account ${account.id}`
          )
        }
      } else {
        logger.info(`✅ [Bridge] Account already has apiKey, length: ${account.apiKey.length}`)
      }
      account.baseApi = 'https://api.anthropic.com'
    } else if (accountType === 'claude-console') {
      // Claude Console 账户 - 优先使用账户配置的 apiUrl
      account.baseApi = account.apiUrl || 'https://api.claude.ai'
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
    let rawAccount = null
    if (accountType === 'claude-official') {
      const claudeAccountService = require('./claudeAccountService')
      rawAccount = await claudeAccountService.getAccount(accountId)
    } else if (accountType === 'claude-console') {
      const claudeConsoleAccountService = require('./claudeConsoleAccountService')
      rawAccount = await claudeConsoleAccountService.getAccount(accountId)
    } else if (accountType === 'bedrock') {
      const bedrockAccountService = require('./bedrockAccountService')
      const result = await bedrockAccountService.getAccount(accountId)
      rawAccount = result.success ? result.data : null
    }

    // 调试日志：检查获取到的原始账户数据
    if (rawAccount) {
      logger.info(`🔍 [Bridge] Fetched raw Claude account:`, {
        id: rawAccount.id,
        name: rawAccount.name,
        accountType,
        hasApiUrl: !!rawAccount.apiUrl,
        apiUrl: rawAccount.apiUrl,
        hasBaseApi: !!rawAccount.baseApi,
        baseApi: rawAccount.baseApi,
        allFields: Object.keys(rawAccount)
      })
    } else {
      logger.warn(`⚠️ [Bridge] No raw account data found for ${accountId} (${accountType})`)
    }

    return rawAccount
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
        converter = new OpenAIResponsesToClaudeConverter(options)
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
