const express = require('express')
const axios = require('axios')
const claudeRelayService = require('../services/claudeRelayService')
const claudeConsoleRelayService = require('../services/claudeConsoleRelayService')
const bedrockRelayService = require('../services/bedrockRelayService')
const ccrRelayService = require('../services/ccrRelayService')
const bedrockAccountService = require('../services/bedrockAccountService')
const unifiedClaudeScheduler = require('../services/unifiedClaudeScheduler')
const apiKeyService = require('../services/apiKeyService')
const pricingService = require('../services/pricingService')
const { authenticateApiKey } = require('../middleware/auth')
const logger = require('../utils/logger')
const redis = require('../models/redis')
const { getEffectiveModel, parseVendorPrefixedModel } = require('../utils/modelHelper')
const sessionHelper = require('../utils/sessionHelper')
const ProxyHelper = require('../utils/proxyHelper')
const config = require('../../config/config')

const router = express.Router()

// 🔧 共享的消息处理函数
async function handleMessagesRequest(req, res) {
  try {
    const startTime = Date.now()

    // Claude 服务权限校验，阻止未授权的 Key
    if (
      req.apiKey.permissions &&
      req.apiKey.permissions !== 'all' &&
      req.apiKey.permissions !== 'claude'
    ) {
      return res.status(403).json({
        error: {
          type: 'permission_error',
          message: '此 API Key 无权访问 Claude 服务'
        }
      })
    }

    // 严格的输入验证
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Request body must be a valid JSON object'
      })
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Missing or invalid field: messages (must be an array)'
      })
    }

    if (req.body.messages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Messages array cannot be empty'
      })
    }

    // 模型限制（黑名单）校验：统一在此处处理（去除供应商前缀）
    if (
      req.apiKey.enableModelRestriction &&
      Array.isArray(req.apiKey.restrictedModels) &&
      req.apiKey.restrictedModels.length > 0
    ) {
      const effectiveModel = getEffectiveModel(req.body.model || '')
      if (req.apiKey.restrictedModels.includes(effectiveModel)) {
        return res.status(403).json({
          error: {
            type: 'forbidden',
            message: '暂无该模型访问权限'
          }
        })
      }
    }

    // 检查是否为流式请求
    const isStream = req.body.stream === true

    logger.api(
      `🚀 Processing ${isStream ? 'stream' : 'non-stream'} request for key: ${req.apiKey.name}`
    )

    if (isStream) {
      // 流式响应 - 只使用官方真实usage数据
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('X-Accel-Buffering', 'no') // 禁用 Nginx 缓冲

      // 禁用 Nagle 算法，确保数据立即发送
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true)
      }

      // 流式响应不需要额外处理，中间件已经设置了监听器

      let usageDataCaptured = false

      // 生成会话哈希用于sticky会话
      const sessionHash = sessionHelper.generateSessionHash(req.body)

      // 使用统一调度选择账号（传递请求的模型）
      const requestedModel = req.body.model
      const { accountId, accountType } = await unifiedClaudeScheduler.selectAccountForApiKey(
        req.apiKey,
        sessionHash,
        requestedModel
      )

      // 根据账号类型选择对应的转发服务并调用
      if (accountType === 'claude-official') {
        // 官方Claude账号使用原有的转发服务（会自己选择账号）
        await claudeRelayService.relayStreamRequestWithUsageCapture(
          req.body,
          req.apiKey,
          res,
          req.headers,
          (usageData) => {
            // 回调函数：当检测到完整usage数据时记录真实token使用量
            logger.info(
              '🎯 Usage callback triggered with complete data:',
              JSON.stringify(usageData, null, 2)
            )

            if (
              usageData &&
              usageData.input_tokens !== undefined &&
              usageData.output_tokens !== undefined
            ) {
              const inputTokens = usageData.input_tokens || 0
              const outputTokens = usageData.output_tokens || 0
              // 兼容处理：如果有详细的 cache_creation 对象，使用它；否则使用总的 cache_creation_input_tokens
              let cacheCreateTokens = usageData.cache_creation_input_tokens || 0
              let ephemeral5mTokens = 0
              let ephemeral1hTokens = 0

              if (usageData.cache_creation && typeof usageData.cache_creation === 'object') {
                ephemeral5mTokens = usageData.cache_creation.ephemeral_5m_input_tokens || 0
                ephemeral1hTokens = usageData.cache_creation.ephemeral_1h_input_tokens || 0
                // 总的缓存创建 tokens 是两者之和
                cacheCreateTokens = ephemeral5mTokens + ephemeral1hTokens
              }

              const cacheReadTokens = usageData.cache_read_input_tokens || 0
              const model = usageData.model || 'unknown'

              // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
              const { accountId: usageAccountId } = usageData

              // 构建 usage 对象以传递给 recordUsage
              const usageObject = {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_creation_input_tokens: cacheCreateTokens,
                cache_read_input_tokens: cacheReadTokens
              }

              // 如果有详细的缓存创建数据，添加到 usage 对象中
              if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
                usageObject.cache_creation = {
                  ephemeral_5m_input_tokens: ephemeral5mTokens,
                  ephemeral_1h_input_tokens: ephemeral1hTokens
                }
              }

              apiKeyService
                .recordUsageWithDetails(req.apiKey.id, usageObject, model, usageAccountId, 'claude')
                .catch((error) => {
                  logger.error('❌ Failed to record stream usage:', error)
                })

              // 更新时间窗口内的token计数和费用
              if (req.rateLimitInfo) {
                const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

                // 更新Token计数（向后兼容）
                redis
                  .getClient()
                  .incrby(req.rateLimitInfo.tokenCountKey, totalTokens)
                  .catch((error) => {
                    logger.error('❌ Failed to update rate limit token count:', error)
                  })
                logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`)

                // 计算并更新费用计数（新功能）
                if (req.rateLimitInfo.costCountKey) {
                  const costInfo = pricingService.calculateCost(usageData, model)
                  if (costInfo.totalCost > 0) {
                    redis
                      .getClient()
                      .incrbyfloat(req.rateLimitInfo.costCountKey, costInfo.totalCost)
                      .catch((error) => {
                        logger.error('❌ Failed to update rate limit cost count:', error)
                      })
                    logger.api(
                      `💰 Updated rate limit cost count: +$${costInfo.totalCost.toFixed(6)}`
                    )
                  }
                }
              }

              usageDataCaptured = true
              logger.api(
                `📊 Stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
              )
            } else {
              logger.warn(
                '⚠️ Usage callback triggered but data is incomplete:',
                JSON.stringify(usageData)
              )
            }
          }
        )
      } else if (accountType === 'claude-console') {
        // Claude Console账号使用Console转发服务（需要传递accountId）
        await claudeConsoleRelayService.relayStreamRequestWithUsageCapture(
          req.body,
          req.apiKey,
          res,
          req.headers,
          (usageData) => {
            // 回调函数：当检测到完整usage数据时记录真实token使用量
            logger.info(
              '🎯 Usage callback triggered with complete data:',
              JSON.stringify(usageData, null, 2)
            )

            if (
              usageData &&
              usageData.input_tokens !== undefined &&
              usageData.output_tokens !== undefined
            ) {
              const inputTokens = usageData.input_tokens || 0
              const outputTokens = usageData.output_tokens || 0
              // 兼容处理：如果有详细的 cache_creation 对象，使用它；否则使用总的 cache_creation_input_tokens
              let cacheCreateTokens = usageData.cache_creation_input_tokens || 0
              let ephemeral5mTokens = 0
              let ephemeral1hTokens = 0

              if (usageData.cache_creation && typeof usageData.cache_creation === 'object') {
                ephemeral5mTokens = usageData.cache_creation.ephemeral_5m_input_tokens || 0
                ephemeral1hTokens = usageData.cache_creation.ephemeral_1h_input_tokens || 0
                // 总的缓存创建 tokens 是两者之和
                cacheCreateTokens = ephemeral5mTokens + ephemeral1hTokens
              }

              const cacheReadTokens = usageData.cache_read_input_tokens || 0
              const model = usageData.model || 'unknown'

              // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
              const usageAccountId = usageData.accountId

              // 构建 usage 对象以传递给 recordUsage
              const usageObject = {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_creation_input_tokens: cacheCreateTokens,
                cache_read_input_tokens: cacheReadTokens
              }

              // 如果有详细的缓存创建数据，添加到 usage 对象中
              if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
                usageObject.cache_creation = {
                  ephemeral_5m_input_tokens: ephemeral5mTokens,
                  ephemeral_1h_input_tokens: ephemeral1hTokens
                }
              }

              apiKeyService
                .recordUsageWithDetails(
                  req.apiKey.id,
                  usageObject,
                  model,
                  usageAccountId,
                  'claude-console'
                )
                .catch((error) => {
                  logger.error('❌ Failed to record stream usage:', error)
                })

              // 更新时间窗口内的token计数和费用
              if (req.rateLimitInfo) {
                const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

                // 更新Token计数（向后兼容）
                redis
                  .getClient()
                  .incrby(req.rateLimitInfo.tokenCountKey, totalTokens)
                  .catch((error) => {
                    logger.error('❌ Failed to update rate limit token count:', error)
                  })
                logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`)

                // 计算并更新费用计数（新功能）
                if (req.rateLimitInfo.costCountKey) {
                  const costInfo = pricingService.calculateCost(usageData, model)
                  if (costInfo.totalCost > 0) {
                    redis
                      .getClient()
                      .incrbyfloat(req.rateLimitInfo.costCountKey, costInfo.totalCost)
                      .catch((error) => {
                        logger.error('❌ Failed to update rate limit cost count:', error)
                      })
                    logger.api(
                      `💰 Updated rate limit cost count: +$${costInfo.totalCost.toFixed(6)}`
                    )
                  }
                }
              }

              usageDataCaptured = true
              logger.api(
                `📊 Stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
              )
            } else {
              logger.warn(
                '⚠️ Usage callback triggered but data is incomplete:',
                JSON.stringify(usageData)
              )
            }
          },
          accountId
        )
      } else if (accountType === 'bedrock') {
        // Bedrock账号使用Bedrock转发服务
        try {
          const bedrockAccountResult = await bedrockAccountService.getAccount(accountId)
          if (!bedrockAccountResult.success) {
            throw new Error('Failed to get Bedrock account details')
          }

          const result = await bedrockRelayService.handleStreamRequest(
            req.body,
            bedrockAccountResult.data,
            res
          )

          // 记录Bedrock使用统计
          if (result.usage) {
            const inputTokens = result.usage.input_tokens || 0
            const outputTokens = result.usage.output_tokens || 0

            apiKeyService
              .recordUsage(req.apiKey.id, inputTokens, outputTokens, 0, 0, result.model, accountId)
              .catch((error) => {
                logger.error('❌ Failed to record Bedrock stream usage:', error)
              })

            // 更新时间窗口内的token计数和费用
            if (req.rateLimitInfo) {
              const totalTokens = inputTokens + outputTokens

              // 更新Token计数（向后兼容）
              redis
                .getClient()
                .incrby(req.rateLimitInfo.tokenCountKey, totalTokens)
                .catch((error) => {
                  logger.error('❌ Failed to update rate limit token count:', error)
                })
              logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`)

              // 计算并更新费用计数（新功能）
              if (req.rateLimitInfo.costCountKey) {
                const costInfo = pricingService.calculateCost(result.usage, result.model)
                if (costInfo.totalCost > 0) {
                  redis
                    .getClient()
                    .incrbyfloat(req.rateLimitInfo.costCountKey, costInfo.totalCost)
                    .catch((error) => {
                      logger.error('❌ Failed to update rate limit cost count:', error)
                    })
                  logger.api(`💰 Updated rate limit cost count: +$${costInfo.totalCost.toFixed(6)}`)
                }
              }
            }

            usageDataCaptured = true
            logger.api(
              `📊 Bedrock stream usage recorded - Model: ${result.model}, Input: ${inputTokens}, Output: ${outputTokens}, Total: ${inputTokens + outputTokens} tokens`
            )
          }
        } catch (error) {
          logger.error('❌ Bedrock stream request failed:', error)
          if (!res.headersSent) {
            return res.status(500).json({ error: 'Bedrock service error', message: error.message })
          }
          return undefined
        }
      } else if (accountType === 'ccr') {
        // CCR账号使用CCR转发服务（需要传递accountId）
        await ccrRelayService.relayStreamRequestWithUsageCapture(
          req.body,
          req.apiKey,
          res,
          req.headers,
          (usageData) => {
            // 回调函数：当检测到完整usage数据时记录真实token使用量
            logger.info(
              '🎯 CCR usage callback triggered with complete data:',
              JSON.stringify(usageData, null, 2)
            )

            if (
              usageData &&
              usageData.input_tokens !== undefined &&
              usageData.output_tokens !== undefined
            ) {
              const inputTokens = usageData.input_tokens || 0
              const outputTokens = usageData.output_tokens || 0
              // 兼容处理：如果有详细的 cache_creation 对象，使用它；否则使用总的 cache_creation_input_tokens
              let cacheCreateTokens = usageData.cache_creation_input_tokens || 0
              let ephemeral5mTokens = 0
              let ephemeral1hTokens = 0

              if (usageData.cache_creation && typeof usageData.cache_creation === 'object') {
                ephemeral5mTokens = usageData.cache_creation.ephemeral_5m_input_tokens || 0
                ephemeral1hTokens = usageData.cache_creation.ephemeral_1h_input_tokens || 0
                // 总的缓存创建 tokens 是两者之和
                cacheCreateTokens = ephemeral5mTokens + ephemeral1hTokens
              }

              const cacheReadTokens = usageData.cache_read_input_tokens || 0
              const model = usageData.model || 'unknown'

              // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
              const usageAccountId = usageData.accountId

              // 构建 usage 对象以传递给 recordUsage
              const usageObject = {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_creation_input_tokens: cacheCreateTokens,
                cache_read_input_tokens: cacheReadTokens
              }

              // 如果有详细的缓存创建数据，添加到 usage 对象中
              if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
                usageObject.cache_creation = {
                  ephemeral_5m_input_tokens: ephemeral5mTokens,
                  ephemeral_1h_input_tokens: ephemeral1hTokens
                }
              }

              apiKeyService
                .recordUsageWithDetails(req.apiKey.id, usageObject, model, usageAccountId, 'ccr')
                .catch((error) => {
                  logger.error('❌ Failed to record CCR stream usage:', error)
                })

              // 更新时间窗口内的token计数和费用
              if (req.rateLimitInfo) {
                const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

                // 更新Token计数（向后兼容）
                redis
                  .getClient()
                  .incrby(req.rateLimitInfo.tokenCountKey, totalTokens)
                  .catch((error) => {
                    logger.error('❌ Failed to update rate limit token count:', error)
                  })
                logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`)

                // 计算并更新费用计数（新功能）
                if (req.rateLimitInfo.costCountKey) {
                  const costInfo = pricingService.calculateCost(usageData, model)
                  if (costInfo.totalCost > 0) {
                    redis
                      .getClient()
                      .incrbyfloat(req.rateLimitInfo.costCountKey, costInfo.totalCost)
                      .catch((error) => {
                        logger.error('❌ Failed to update rate limit cost count:', error)
                      })
                    logger.api(
                      `💰 Updated rate limit cost count: +$${costInfo.totalCost.toFixed(6)}`
                    )
                  }
                }
              }

              usageDataCaptured = true
              logger.api(
                `📊 CCR stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
              )
            } else {
              logger.warn(
                '⚠️ CCR usage callback triggered but data is incomplete:',
                JSON.stringify(usageData)
              )
            }
          },
          accountId
        )
      } else if (accountType === 'openai' || accountType === 'openai-responses') {
        // 🌉 OpenAI 桥接：将 Claude 请求转换为 OpenAI 请求
        logger.info(
          `🌉 Using OpenAI bridge for Claude request - Account: ${accountId}, Type: ${accountType}`
        )

        // 导入必要的服务和转换器
        const config = require('../../config/config')
        const ClaudeToOpenAIResponsesConverter = require('../services/claudeToOpenAIResponses')
        const OpenAIResponsesToClaudeConverter = require('../services/openaiResponsesToClaude')

        // 获取账户信息以获取模型映射
        const accountService =
          accountType === 'openai'
            ? require('../services/openaiAccountService')
            : require('../services/openaiResponsesAccountService')
        const fullAccount = await accountService.getAccount(accountId)

        // 构建模型映射：账户级 → 全局 → 默认
        // claudeModelMapping 已经在 getAccount() 中被解析为对象，直接使用
        const accountMapping =
          fullAccount.claudeModelMapping && typeof fullAccount.claudeModelMapping === 'object'
            ? fullAccount.claudeModelMapping
            : {}
        const globalMapping = config.claudeBridgeDefaults?.modelMapping || {}
        const modelMapping = { ...globalMapping, ...accountMapping }
        const defaultModel = config.claudeBridgeDefaults?.defaultModel || 'gpt-5'

        // 记录映射信息
        const claudeModel = req.body.model
        const mappedModel = modelMapping[claudeModel] || defaultModel
        const mappingSource = modelMapping[claudeModel]
          ? Object.keys(accountMapping).includes(claudeModel)
            ? 'account'
            : 'global'
          : 'default'
        logger.info(`🔄 Model mapping: ${claudeModel} → ${mappedModel} (source: ${mappingSource})`)

        // 转换 Claude 请求为 OpenAI 请求
        const toOpenAI = new ClaudeToOpenAIResponsesConverter({ modelMapping, defaultModel })
        const toClaude = new OpenAIResponsesToClaudeConverter()
        const originalStream = Boolean(req.body && req.body.stream)

        let openaiRequest
        if (accountType === 'openai-responses') {
          openaiRequest = toOpenAI.convertRequest(req.body)
        } else {
          // OpenAI 直连账户：简化转换
          openaiRequest = {
            model: mappedModel,
            messages: req.body.messages || [],
            stream: Boolean(req.body.stream)
          }
          if (req.body.system) {
            openaiRequest.messages.unshift({ role: 'system', content: req.body.system })
          }
        }

        // 设置桥接元数据
        req._bridgeForceNonStream = !originalStream
        req._bridgeConverter = toClaude
        req._bridgeStreamTransform = (chunkStr) => {
          return toClaude.convertStreamChunk(chunkStr)
        }
        req._bridgeStreamFinalize = () => {
          return toClaude.finalizeStream()
        }
        req._bridgeNonStreamConvert = (responseData) => {
          // responseData 是从 OpenAI API 返回的响应数据
          return toClaude.convertNonStream({ response: responseData })
        }

        // 覆写请求体
        req.body = openaiRequest

        // 设置 baseApi 和 apiKey（OpenAI OAuth 账户没有baseApi字段，且accessToken需要解密）
        if (accountType === 'openai') {
          if (!fullAccount.baseApi) {
            // OpenAI OAuth 账户默认使用 ChatGPT Codex API（与 /openai/responses 路由一致）
            fullAccount.baseApi = 'https://chatgpt.com/backend-api/codex'
          }
          // OpenAI OAuth 账户使用 accessToken 作为 apiKey，需要解密
          if (fullAccount.accessToken && !fullAccount.apiKey) {
            const { decrypt } = accountService
            fullAccount.apiKey = decrypt(fullAccount.accessToken)
            logger.info(
              `🔑 Set OpenAI apiKey from accessToken, length: ${fullAccount.apiKey?.length || 0}`
            )
          }
          logger.info(
            `🌐 OpenAI bridge config: baseApi=${fullAccount.baseApi}, hasApiKey=${!!fullAccount.apiKey}`
          )
        }

        // 根据账户类型选择不同的处理方式
        if (accountType === 'openai') {
          // OpenAI OAuth 账户：直接使用类似 openaiRoutes.js 的逻辑
          logger.info(`🎬 Using OpenAI OAuth bridge mode for account: ${fullAccount.name}`)

          // 获取 accessToken（已解密）
          const accessToken = fullAccount.apiKey
          if (!accessToken) {
            throw new Error('OpenAI account missing accessToken')
          }

          // 构建符合 ChatGPT Codex API 要求的请求头
          const headers = {
            'authorization': `Bearer ${accessToken}`,
            'chatgpt-account-id': fullAccount.accountId || fullAccount.chatgptUserId,
            'host': 'chatgpt.com',
            'accept': req.body?.stream ? 'text/event-stream' : 'application/json',
            'content-type': 'application/json'
          }

          // 设置 store=false（ChatGPT Codex API 要求）
          req.body.store = false

          // 添加 Codex CLI instructions（如果请求中没有）
          if (!req.body.instructions || !req.body.instructions.startsWith('You are a coding agent running in the Codex CLI')) {
            // 移除不需要的请求体字段（与 openaiRoutes.js 保持一���）
            const fieldsToRemove = [
              'temperature',
              'top_p',
              'max_output_tokens',
              'user',
              'text_formatting',
              'truncation',
              'text',
              'service_tier'
            ]
            fieldsToRemove.forEach((field) => {
              delete req.body[field]
            })

            // 设置固定的 Codex CLI instructions
            req.body.instructions =
              `You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.

Your capabilities:
- Receive user prompts and other context provided by the harness, such as files in the workspace.
- Communicate with the user by streaming thinking & responses, and by making & updating plans.
- Emit function calls to run terminal commands and apply patches. Depending on how this specific run is configured, you can request that these function calls be escalated to the user for approval before running. More on this in the "Sandbox and approvals" section.

Within this context, Codex refers to the open-source agentic coding interface (not the old Codex language model built by OpenAI).

# How you work

## Personality

Your default personality and tone is concise, direct, and friendly. You communicate efficiently, always keeping the user clearly informed about ongoing actions without unnecessary detail. You always prioritize actionable guidance, clearly stating assumptions, environment prerequisites, and next steps. Unless explicitly asked, you avoid excessively verbose explanations about your work.

## Responsiveness

### Preamble messages

Before making tool calls, send a brief preamble to the user explaining what you're about to do. When sending preamble messages, follow these principles and examples:

- **Logically group related actions**: if you're about to run several related commands, describe them together in one preamble rather than sending a separate note for each.
- **Keep it concise**: be no more than 1-2 sentences (8–12 words for quick updates).
- **Build on prior context**: if this is not your first tool call, use the preamble message to connect the dots with what's been done so far and create a sense of momentum and clarity for the user to understand your next actions.
- **Keep your tone light, friendly and curious**: add small touches of personality in preambles feel collaborative and engaging.

**Examples:**
- "I've explored the repo; now checking the API route definitions."
- "Next, I'll patch the config and update the related tests."
- "I'm about to scaffold the CLI commands and helper functions."
- "Ok cool, so I've wrapped my head around the repo. Now digging into the API routes."
- "Config's looking tidy. Next up is patching helpers to keep things in sync."
- "Finished poking at the DB gateway. I will now chase down error handling."
- "Alright, build pipeline order is interesting. Checking how it reports failures."
- "Spotted a clever caching util; now hunting where it gets used."

**Avoiding a preamble for every trivial read (e.g., \`cat\` a single file) unless it's part of a larger grouped action.
- Jumping straight into tool calls without explaining what's about to happen.
- Writing overly long or speculative preambles — focus on immediate, tangible next steps.

## Planning

You have access to an \`update_plan\` tool which tracks steps and progress and renders them to the user. Using the tool helps demonstrate that you've understood the task and convey how you're approaching it. Plans can help to make complex, ambiguous, or multi-phase work clearer and more collaborative for the user. A good plan should break the task into meaningful, logically ordered steps that are easy to verify as you go. Note that plans are not for padding out simple work with filler steps or stating the obvious. Do not repeat the full contents of the plan after an \`update_plan\` call — the harness already displays it. Instead, summarize the change made and highlight any important context or next step.

Use a plan when:
- The task is non-trivial and will require multiple actions over a long time horizon.
- There are logical phases or dependencies where sequencing matters.
- The work has ambiguity that benefits from outlining high-level goals.
- You want intermediate checkpoints for feedback and validation.
- When the user asked you to do more than one thing in a single prompt
- The user has asked you to use the plan tool (aka "TODOs")
- You generate additional steps while working, and plan to do them before yielding to the user

Skip a plan when:
- The task is simple and direct.
- Breaking it down would only produce literal or trivial steps.

Planning steps are called "steps" in the tool, but really they're more like tasks or TODOs. As such they should be very concise descriptions of non-obvious work that an engineer might do like "Write the API spec", then "Update the backend", then "Implement the frontend". On the other hand, it's obvious that you'll usually have to "Explore the codebase" or "Implement the changes", so those are not worth tracking in your plan.

It may be the case that you complete all steps in your plan after a single pass of implementation. If this is the case, you can simply mark all the planned steps as completed. The content of your plan should not involve doing anything that you aren't capable of doing (i.e. don't try to test things that you can't test). Do not use plans for simple or single-step queries that you can just do or answer immediately.

### Examples

**High-quality plans**

Example 1:

1. Add CLI entry with file args
2. Parse Markdown via CommonMark library
3. Apply semantic HTML template
4. Handle code blocks, images, links
5. Add error handling for invalid files

Example 2:

1. Define CSS variables for colors
2. Add toggle with localStorage state
3. Refactor components to use variables
4. Verify all views for readability
5. Add smooth theme-change transition

Example 3:

1. Set up Node.js + WebSocket server
2. Add join/leave broadcast events
3. Implement messaging with timestamps
4. Add usernames + mention highlighting
5. Persist messages in lightweight DB
6. Add typing indicators + unread count

**Low-quality plans**

Example 1:

1. Create CLI tool
2. Add Markdown parser
3. Convert to HTML

Example 2:

1. Add dark mode toggle
2. Save preference
3. Make styles look good

Example 3:

1. Create single-file HTML game
2. Run quick sanity check
3. Summarize usage instructions

If you need to write a plan, only write high quality plans, not low quality ones.

## Task execution

You are a coding agent. Please keep going until the query is completely resolved, before ending your turn and yielding back to the user. Only terminate your turn when you are sure that the problem is solved. Autonomously resolve the query to the best of your ability, using the tools available to you, before coming back to the user. Do NOT guess or make up an answer.

You MUST adhere to the following criteria when solving queries:
- Working on the repo(s) in the current environment is allowed, even if they are proprietary.
- Analyzing code for vulnerabilities is allowed.
- Showing user code and tool call details is allowed.
- Use the \`apply_patch\` tool to edit files (NEVER try \`applypatch\` or \`apply-patch\`, only \`apply_patch\`): {"command":["apply_patch","*** Begin Patch\\\\n*** Update File: path/to/file.py\\\\n@@ def example():\\\\n-  pass\\\\n+  return 123\\\\n*** End Patch"]}

If completing the user's task requires writing or modifying files, your code and final answer should follow these coding guidelines, though user instructions (i.e. AGENTS.md) may override these guidelines:

- Fix the problem at the root cause rather than applying surface-level patches, when possible.
- Avoid unneeded complexity in your solution.
- Do not attempt to fix unrelated bugs or broken tests. It is not your responsibility to fix them. (You may mention them to the user in your final message though.)
- Update documentation as necessary.
- Keep changes consistent with the style of the existing codebase. Changes should be minimal and focused on the task.
- Use \`git log\` and \`git blame\` to search the history of the codebase if additional context is required.
- NEVER add copyright or license headers unless specifically requested.
- Do not waste tokens by re-reading files after calling \`apply_patch\` on them. The tool call will fail if it didn't work. The same goes for making folders, deleting folders, etc.
- Do not \`git commit\` your changes or create new git branches unless explicitly requested.
- Do not add inline comments within code unless explicitly requested.
- Do not use one-letter variable names unless explicitly requested.
- NEVER output inline citations like "【F:README.md†L5-L14】" in your outputs. The CLI is not able to render these so they will just be broken in the UI. Instead, if you output valid filepaths, users will be able to click on them to open the files in their editor.

## Testing your work

If the codebase has tests or the ability to build or run, you should use them to verify that your work is complete. Generally, your testing philosophy should be to start as specific as possible to the code you changed so that you can catch issues efficiently, then make your way to broader tests as you build confidence. If there's no test for the code you changed, and if the adjacent patterns in the codebases show that there's a logical place for you to add a test, you may do so. However, do not add tests to codebases with no tests, or where the patterns don't indicate so.

Once you're confident in correctness, use formatting commands to ensure that your code is well formatted. These commands can take time so you should run them on as precise a target as possible. If there are issues you can iterate up to 3 times to get formatting right, but if you still can't manage it's better to save the user time and present them a correct solution where you call out the formatting in your final message. If the codebase does not have a formatter configured, do not add one.

For all of testing, running, building, and formatting, do not attempt to fix unrelated bugs. It is not your responsibility to fix them. (You may mention them to the user in your final message though.)

## Sandbox and approvals

The Codex CLI harness supports several different sandboxing, and approval configurations that the user can choose from.

Filesystem sandboxing prevents you from editing files without user approval. The options are:
- *read-only*: You can only read files.
- *workspace-write*: You can read files. You can write to files in your workspace folder, but not outside it.
- *danger-full-access*: No filesystem sandboxing.

Network sandboxing prevents you from accessing network without approval. Options are
- *ON*
- *OFF*

Approvals are your mechanism to get user consent to perform more privileged actions. Although they introduce friction to the user because your work is paused until the user responds, you should leverage them to accomplish your important work. Do not let these settings or the sandbox deter you from attempting to accomplish the user's task. Approval options are
- *untrusted*: The harness will escalate most commands for user approval, apart from a limited allowlist of safe "read" commands.
- *on-failure*: The harness will allow all commands to run in the sandbox (if enabled), and failures will be escalated to the user for approval to run again without the sandbox.
- *on-request*: Commands will be run in the sandbox by default, and you can specify in your tool call if you want to escalate a command to run without sandboxing. (Note that this mode is not always available. If it is, you'll see parameters for it in the \`shell\` command description.)
- *never*: This is a non-interactive mode where you may NEVER ask the user for approval to run commands. Instead, you must always persist and work around constraints to solve the task for the user. You MUST do your utmost best to finish the task and validate your work before yielding. If this mode is pared with \`danger-full-access\`, take advantage of it to deliver the best outcome for the user. Further, in this mode, your default testing philosophy is overridden: Even if you don't see local patterns for testing, you may add tests and scripts to validate your work. Just remove them before yielding.

When you are running with approvals \`on-request\`, and sandboxing enabled, here are scenarios where you'll need to request approval:
- You need to run a command that writes to a directory that requires it (e.g. running tests that write to /tmp)
- You need to run a GUI app (e.g., open/xdg-open/osascript) to open browsers or files.
- You are running sandboxed and need to run a command that requires network access (e.g. installing packages)
- If you run a command that is important to solving the user's query, but it fails because of sandboxing, rerun the command with approval.
- You are about to take a potentially destructive action such as an \`rm\` or \`git reset\` that the user did not explicitly ask for
- (For all of these, you should weigh alternative paths that do not require approval.)

Note that when sandboxing is set to read-only, you'll need to request approval for any command that isn't a read.

You will be told what filesystem sandboxing, network sandboxing, and approval mode are active in a developer or user message. If you are not told about this, assume that you are running with workspace-write, network sandboxing ON, and approval on-failure.

## Ambition vs. precision

For tasks that have no prior context (i.e. the user is starting something brand new), you should feel free to be ambitious and demonstrate creativity with your implementation.

If you're operating in an existing codebase, you should make sure you do exactly what the user asks with surgical precision. Treat the surrounding codebase with respect, and don't overstep (i.e. changing filenames or variables unnecessarily). You should balance being sufficiently ambitious and proactive when completing tasks of this nature.

You should use judicious initiative to decide on the right level of detail and complexity to deliver based on the user's needs. This means showing good judgment that you're capable of doing the right extras without gold-plating. This might be demonstrated by high-value, creative touches when scope of the task is vague; while being surgical and targeted when scope is tightly specified.

## Sharing progress updates

For especially longer tasks that you work on (i.e. requiring many tool calls, or a plan with multiple steps), you should provide progress updates back to the user at reasonable intervals. These updates should be structured as a concise sentence or two (no more than 8-10 words long) recapping progress so far in plain language: this update demonstrates your understanding of what needs to be done, progress so far (i.e. files explores, subtasks complete), and where you're going next.

Before doing large chunks of work that may incur latency as experienced by the user (i.e. writing a new file), you should send a concise message to the user with an update indicating what you're about to do to ensure they know what you're spending time on. Don't start editing or writing large files before informing the user what you are doing and why.

The messages you send before tool calls should describe what is immediately about to be done next in very concise language. If there was previous work done, this preamble message should also include a note about the work done so far to bring the user along.

## Presenting your work and final message

Your final message should read naturally, like an update from a concise teammate. For casual conversation, brainstorming tasks, or quick questions from the user, respond in a friendly, conversational tone. You should ask questions, suggest ideas, and adapt to the user's style. If you've finished a large amount of work, when describing what you've done to the user, you should follow the final answer formatting guidelines to communicate substantive changes. You don't need to add structured formatting for one-word answers, greetings, or purely conversational exchanges.

You can skip heavy formatting for single, simple actions or confirmations. In these cases, respond in plain sentences with any relevant next step or quick option. Reserve multi-section structured responses for results that need grouping or explanation.

The user is working on the same computer as you, and has access to your work. As such there's no need to show the full contents of large files you have already written unless the user explicitly asks for them. Similarly, if you've created or modified files using \`apply_patch\`, there's no need to tell users to "save the file" or "copy the code into a file"—just reference the file path.

If there's something that you think you could help with as a logical next step, concisely ask the user if they want you to do so. Good examples of this are running tests, committing changes, or building out the next logical component. If there's something that you couldn't do (even with approval) but that the user might want to do (such as verifying changes by running the app), include those instructions succinctly.

Brevity is very important as a default. You should be very concise (i.e. no more than 10 lines), but can relax this requirement for tasks where additional detail and comprehensiveness is important for the user's understanding.

### Final answer structure and style guidelines

You are producing plain text that will later be styled by the CLI. Follow these rules exactly. Formatting should make results easy to scan, but not feel mechanical. Use judgment to decide how much structure adds value.

**Section Headers**
- Use only when they improve clarity — they are not mandatory for every answer.
- Choose descriptive names that fit the content
- Keep headers short (1–3 words) and in \`**Title Case**\`. Always start headers with \`**\` and end with \`**\`
- Leave no blank line before the first bullet under a header.
- Section headers should only be used where they genuinely improve scanability; avoid fragmenting the answer.

**Bullets**
- Use \`-\` followed by a space for every bullet.
- Bold the keyword, then colon + concise description.
- Merge related points when possible; avoid a bullet for every trivial detail.
- Keep bullets to one line unless breaking for clarity is unavoidable.
- Group into short lists (4–6 bullets) ordered by importance.
- Use consistent keyword phrasing and formatting across sections.

**Monospace**
- Wrap all commands, file paths, env vars, and code identifiers in backticks (\`\` \`...\` \`\`).
- Apply to inline examples and to bullet keywords if the keyword itself is a literal file/command.
- Never mix monospace and bold markers; choose one based on whether it's a keyword (\`**\`) or inline code/path (\`\` \` \`\`).

**Structure**
- Place related bullets together; don't mix unrelated concepts in the same section.
- Order sections from general → specific → supporting info.
- For subsections (e.g., "Binaries" under "Rust Workspace"), introduce with a bolded keyword bullet, then list items under it.
- Match structure to complexity:
  - Multi-part or detailed results → use clear headers and grouped bullets.
  - Simple results → minimal headers, possibly just a short list or paragraph.

**Tone**
- Keep the voice collaborative and natural, like a coding partner handing off work.
- Be concise and factual — no filler or conversational commentary and avoid unnecessary repetition
- Use present tense and active voice (e.g., "Runs tests" not "This will run tests").
- Keep descriptions self-contained; don't refer to "above" or "below".
- Use parallel structure in lists for consistency.

**Don't**
- Don't use literal words "bold" or "monospace" in the content.
- Don't nest bullets or create deep hierarchies.
- Don't output ANSI escape codes directly — the CLI renderer applies them.
- Don't cram unrelated keywords into a single bullet; split for clarity.
- Don't let keyword lists run long — wrap or reformat for scanability.

Generally, ensure your final answers adapt their shape and depth to the request. For example, answers to code explanations should have a precise, structured explanation with code references that answer the question directly. For tasks with a simple implementation, lead with the outcome and supplement only with what's needed for clarity. Larger changes can be presented as a logical walkthrough of your approach, grouping related steps, explaining rationale where it adds value, and highlighting next actions to accelerate the user. Your answers should provide the right level of detail while being easily scannable.

For casual greetings, acknowledgements, or other one-off conversational messages that are not delivering substantive information or structured results, respond naturally without section headers or bullet formatting.

# Tools

## \`apply_patch\`

Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

**_ Begin Patch
[ one or more file sections ]
_** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

**_ Add File: <path> - create a new file. Every following line is a + line (the initial contents).
_** Delete File: <path> - remove an existing file. Nothing follows.
\\*\\*\\* Update File: <path> - patch an existing file in place (optionally with a rename).

May be immediately followed by \\*\\*\\* Move to: <new path> if you want to rename the file.
Then one or more "hunks", each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:
+ for inserted text,
- for removed text, or
  space ( ) for context.
  At the end of a truncated hunk you can emit \\*\\*\\* End of File.

Patch := Begin { FileOp } End
Begin := "**_ Begin Patch" NEWLINE
End := "_** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "**_ Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "_** Delete File: " path NEWLINE
UpdateFile := "**_ Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "_** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

A full patch can combine several operations:

**_ Begin Patch
_** Add File: hello.txt
+Hello world
**_ Update File: src/app.py
_** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
**_ Delete File: obsolete.txt
_** End Patch

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file

You can invoke apply_patch like:

\`\`\`
shell {"command":["apply_patch","*** Begin Patch\\n*** Add File: hello.txt\\n+Hello, world!\\n*** End Patch\\n"]}
\`\`\`

## \`update_plan\`

A tool named \`update_plan\` is available to you. You can use it to keep an up‑to‑date, step‑by‑step plan for the task.

To create a new plan, call \`update_plan\` with a short list of 1‑sentence steps (no more than 5-7 words each) with a \`status\` for each step (\`pending\`, \`in_progress\`, or \`completed\`).

When steps have been completed, use \`update_plan\` to mark each finished step as \`completed\` and the next step you are working on as \`in_progress\`. There should always be exactly one \`in_progress\` step until everything is done. You can mark multiple items as complete in a single \`update_plan\` call.

If all steps are complete, ensure you call \`update_plan\` to mark all steps as \`completed\`.
`
            logger.debug('📝 Added Codex CLI instructions to bridge request')
          }

          // 创建代理配置
          const proxyAgent = fullAccount.proxy ? ProxyHelper.createProxyAgent(fullAccount.proxy) : null
          const axiosConfig = {
            headers,
            timeout: config.requestTimeout || 600000,
            validateStatus: () => true
          }

          if (proxyAgent) {
            axiosConfig.httpsAgent = proxyAgent
            axiosConfig.proxy = false
            logger.info(`🌐 Using proxy for OpenAI bridge: ${ProxyHelper.getProxyDescription(fullAccount.proxy)}`)
          }

          // 发送请求到 ChatGPT Codex API
          const targetUrl = 'https://chatgpt.com/backend-api/codex/responses'
          logger.info(`🎯 Forwarding to: ${targetUrl}`)

          let upstream
          if (req.body?.stream) {
            // 流式请求
            upstream = await axios.post(targetUrl, req.body, {
              ...axiosConfig,
              responseType: 'stream'
            })

            // 处理流式响应并转换回 Claude 格式
            if (upstream.status >= 400) {
              logger.error(`❌ OpenAI bridge upstream error: ${upstream.status} ${upstream.statusText}`)
              return res.status(upstream.status).json({
                type: 'error',
                error: {
                  type: 'api_error',
                  message: `Upstream API error: ${upstream.status} ${upstream.statusText}`
                }
              })
            }

            // 设置 Claude SSE 响应头
            res.setHeader('Content-Type', 'text/event-stream')
            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('Connection', 'keep-alive')
            res.setHeader('X-Accel-Buffering', 'no')
            if (typeof res.flushHeaders === 'function') {
              res.flushHeaders()
            }

            // 转发流式数据（应用转换器）
            upstream.data.on('data', (chunk) => {
              try {
                const chunkStr = chunk.toString()
                const transform = req._bridgeStreamTransform
                if (typeof transform === 'function') {
                  const converted = transform(chunkStr)
                  if (converted && !res.destroyed) {
                    res.write(converted)
                    if (typeof res.flush === 'function') {
                      res.flush()
                    }
                  }
                } else {
                  if (!res.destroyed) {
                    res.write(chunk)
                  }
                }
              } catch (error) {
                logger.error('Error processing OpenAI bridge stream chunk:', error)
              }
            })

            upstream.data.on('end', () => {
              if (typeof req._bridgeStreamFinalize === 'function') {
                try {
                  const trailing = req._bridgeStreamFinalize()
                  if (trailing && !res.destroyed) {
                    res.write(trailing)
                  }
                } catch (error) {
                  logger.error('Bridge stream finalizer error:', error)
                }
              }
              if (!res.destroyed) {
                res.end()
              }
              logger.info('✅ OpenAI bridge stream completed')
            })

            upstream.data.on('error', (error) => {
              logger.error('OpenAI bridge stream error:', error)
              if (!res.headersSent && !res.destroyed) {
                res.status(502).json({
                  type: 'error',
                  error: { type: 'api_error', message: 'Upstream stream error' }
                })
              } else if (!res.destroyed) {
                res.end()
              }
            })
          } else {
            // 非流式请求
            upstream = await axios.post(targetUrl, req.body, axiosConfig)

            if (upstream.status >= 400) {
              logger.error(`❌ OpenAI bridge upstream error: ${upstream.status} ${upstream.statusText}`)
              return res.status(upstream.status).json({
                type: 'error',
                error: {
                  type: 'api_error',
                  message: `Upstream API error: ${upstream.status} ${upstream.statusText}`
                }
              })
            }

            // 转换响应为 Claude 格式
            const converted = req._bridgeNonStreamConvert(upstream.data)
            logger.info('✅ OpenAI bridge completed (non-stream)')
            return res.status(200).json(converted)
          }
        } else if (accountType === 'openai-responses') {
          // OpenAI-Responses 账户：使用 relay service
          const relayService = require('../services/openaiResponsesRelayService')
          req.headers['x-crs-upstream-path'] = '/v1/responses'

          logger.info(`🎬 Calling relay service for OpenAI-Responses account: ${fullAccount.name}`)
          await relayService.handleRequest(req, res, fullAccount, req.apiKey)

          logger.info(`✅ Bridge completed: Claude request → openai-responses → Claude response`)
        } else {
          throw new Error(`Unsupported account type for bridge mode: ${accountType}`)
        }
      }

      // 流式请求完成后 - 如果没有捕获到usage数据，记录警告但不进行估算
      setTimeout(() => {
        if (!usageDataCaptured) {
          logger.warn(
            '⚠️ No usage data captured from SSE stream - no statistics recorded (official data only)'
          )
        }
      }, 1000) // 1秒后检查
    } else {
      // 非流式响应 - 只使用官方真实usage数据
      logger.info('📄 Starting non-streaming request', {
        apiKeyId: req.apiKey.id,
        apiKeyName: req.apiKey.name
      })

      // 生成会话哈希用于sticky会话
      const sessionHash = sessionHelper.generateSessionHash(req.body)

      // 使用统一调度选择账号（传递请求的模型）
      const requestedModel = req.body.model
      const { accountId, accountType } = await unifiedClaudeScheduler.selectAccountForApiKey(
        req.apiKey,
        sessionHash,
        requestedModel
      )

      // 根据账号类型选择对应的转发服务
      let response
      logger.debug(`[DEBUG] Request query params: ${JSON.stringify(req.query)}`)
      logger.debug(`[DEBUG] Request URL: ${req.url}`)
      logger.debug(`[DEBUG] Request path: ${req.path}`)

      if (accountType === 'claude-official') {
        // 官方Claude账号使用原有的转发服务
        response = await claudeRelayService.relayRequest(
          req.body,
          req.apiKey,
          req,
          res,
          req.headers
        )
      } else if (accountType === 'claude-console') {
        // Claude Console账号使用Console转发服务
        logger.debug(
          `[DEBUG] Calling claudeConsoleRelayService.relayRequest with accountId: ${accountId}`
        )
        response = await claudeConsoleRelayService.relayRequest(
          req.body,
          req.apiKey,
          req,
          res,
          req.headers,
          accountId
        )
      } else if (accountType === 'bedrock') {
        // Bedrock账号使用Bedrock转发服务
        try {
          const bedrockAccountResult = await bedrockAccountService.getAccount(accountId)
          if (!bedrockAccountResult.success) {
            throw new Error('Failed to get Bedrock account details')
          }

          const result = await bedrockRelayService.handleNonStreamRequest(
            req.body,
            bedrockAccountResult.data,
            req.headers
          )

          // 构建标准响应格式
          response = {
            statusCode: result.success ? 200 : 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result.success ? result.data : { error: result.error }),
            accountId
          }

          // 如果成功，添加使用统计到响应数据中
          if (result.success && result.usage) {
            const responseData = JSON.parse(response.body)
            responseData.usage = result.usage
            response.body = JSON.stringify(responseData)
          }
        } catch (error) {
          logger.error('❌ Bedrock non-stream request failed:', error)
          response = {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Bedrock service error', message: error.message }),
            accountId
          }
        }
      } else if (accountType === 'ccr') {
        // CCR账号使用CCR转发服务
        logger.debug(`[DEBUG] Calling ccrRelayService.relayRequest with accountId: ${accountId}`)
        response = await ccrRelayService.relayRequest(
          req.body,
          req.apiKey,
          req,
          res,
          req.headers,
          accountId
        )
      } else if (accountType === 'openai' || accountType === 'openai-responses') {
        // 🌉 OpenAI 桥接：非流式请求
        logger.info(
          `🌉 Using OpenAI bridge for non-stream Claude request - Account: ${accountId}, Type: ${accountType}`
        )

        try {
          // 导入必要的服务和转换器（与流式请求相同）
          const config = require('../../config/config')
          const ClaudeToOpenAIResponsesConverter = require('../services/claudeToOpenAIResponses')
          const OpenAIResponsesToClaudeConverter = require('../services/openaiResponsesToClaude')

          // 获取账户信息以获取模型映射
          const accountService =
            accountType === 'openai'
              ? require('../services/openaiAccountService')
              : require('../services/openaiResponsesAccountService')
          const fullAccount = await accountService.getAccount(accountId)

          // 构建模型映射：账户级 → 全局 → 默认
          // claudeModelMapping 已经在 getAccount() 中被解析为对象，直接使用
          const accountMapping =
            fullAccount.claudeModelMapping && typeof fullAccount.claudeModelMapping === 'object'
              ? fullAccount.claudeModelMapping
              : {}
          const globalMapping = config.claudeBridgeDefaults?.modelMapping || {}
          const modelMapping = { ...globalMapping, ...accountMapping }
          const defaultModel = config.claudeBridgeDefaults?.defaultModel || 'gpt-5'

          // 记录映射信息
          const claudeModel = req.body.model
          const mappedModel = modelMapping[claudeModel] || defaultModel
          const mappingSource = modelMapping[claudeModel]
            ? Object.keys(accountMapping).includes(claudeModel)
              ? 'account'
              : 'global'
            : 'default'
          logger.info(
            `🔄 Model mapping: ${claudeModel} → ${mappedModel} (source: ${mappingSource})`
          )

          // 转换 Claude 请求为 OpenAI 请求
          const toOpenAI = new ClaudeToOpenAIResponsesConverter({ modelMapping, defaultModel })
          const toClaude = new OpenAIResponsesToClaudeConverter()

          let openaiRequest
          if (accountType === 'openai-responses') {
            openaiRequest = toOpenAI.convertRequest(req.body)
          } else {
            // OpenAI 直连账户：简化转换
            openaiRequest = {
              model: mappedModel,
              messages: req.body.messages || [],
              stream: false
            }
            if (req.body.system) {
              openaiRequest.messages.unshift({ role: 'system', content: req.body.system })
            }
          }

          // 设置桥接元数据
          req._bridgeForceNonStream = true
          req._bridgeConverter = toClaude
          req._bridgeNonStreamConvert = (responseData) => {
            // responseData 是从 OpenAI API 返回的响应数据
            return toClaude.convertNonStream({ response: responseData })
          }

          // 覆写请求体
          const originalBody = req.body
          req.body = openaiRequest

          // 设置 baseApi 和 apiKey（OpenAI OAuth 账户没有baseApi字段，且accessToken需要解密）
          if (accountType === 'openai') {
            if (!fullAccount.baseApi) {
              // OpenAI OAuth 账户默认使用 ChatGPT Codex API（与 /openai/responses 路由一致）
              fullAccount.baseApi = 'https://chatgpt.com/backend-api/codex'
            }
            // OpenAI OAuth 账户使用 accessToken 作为 apiKey，需要解密
            if (fullAccount.accessToken && !fullAccount.apiKey) {
              const { decrypt } = accountService
              fullAccount.apiKey = decrypt(fullAccount.accessToken)
            }
          }

          // 设置上游路径：OpenAI OAuth 使用 /responses（Codex API），OpenAI-Responses 使用 /v1/responses
          if (accountType === 'openai') {
            req.headers['x-crs-upstream-path'] = '/responses'
          } else if (accountType === 'openai-responses') {
            req.headers['x-crs-upstream-path'] = '/v1/responses'
          }

          // 调试日志
          logger.info('🔍 Bridge debug - Request body:', JSON.stringify(req.body))
          logger.info('🔍 Bridge debug - Account info:', {
            id: fullAccount.id,
            baseApi: fullAccount.baseApi,
            hasApiKey: !!fullAccount.apiKey,
            apiKeyLength: fullAccount.apiKey?.length
          })

          // 调用 relay 服务（返回会被桥接转换器处理）
          const relayService = require('../services/openaiResponsesRelayService')
          await relayService.handleRequest(req, res, fullAccount, req.apiKey)

          logger.info(
            `✅ Non-stream bridge completed: Claude request → ${accountType} → Claude response`
          )

          // 桥接请求已在 relay 服务内部完成，直接返回
          return
        } catch (bridgeError) {
          logger.error('❌ Bridge error details:', {
            message: bridgeError.message,
            stack: bridgeError.stack,
            accountId,
            accountType
          })
          throw bridgeError
        }
      }

      logger.info('📡 Claude API response received', {
        statusCode: response.statusCode,
        headers: JSON.stringify(response.headers),
        bodyLength: response.body ? response.body.length : 0
      })

      res.status(response.statusCode)

      // 设置响应头，避免 Content-Length 和 Transfer-Encoding 冲突
      const skipHeaders = ['content-encoding', 'transfer-encoding', 'content-length']
      Object.keys(response.headers).forEach((key) => {
        if (!skipHeaders.includes(key.toLowerCase())) {
          res.setHeader(key, response.headers[key])
        }
      })

      let usageRecorded = false

      // 尝试解析JSON响应并提取usage信息
      try {
        const jsonData = JSON.parse(response.body)

        logger.info('📊 Parsed Claude API response:', JSON.stringify(jsonData, null, 2))

        // 从Claude API响应中提取usage信息（完整的token分类体系）
        if (
          jsonData.usage &&
          jsonData.usage.input_tokens !== undefined &&
          jsonData.usage.output_tokens !== undefined
        ) {
          const inputTokens = jsonData.usage.input_tokens || 0
          const outputTokens = jsonData.usage.output_tokens || 0
          const cacheCreateTokens = jsonData.usage.cache_creation_input_tokens || 0
          const cacheReadTokens = jsonData.usage.cache_read_input_tokens || 0
          // Parse the model to remove vendor prefix if present (e.g., "ccr,gemini-2.5-pro" -> "gemini-2.5-pro")
          const rawModel = jsonData.model || req.body.model || 'unknown'
          const { baseModel } = parseVendorPrefixedModel(rawModel)
          const model = baseModel || rawModel

          // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
          const { accountId: responseAccountId } = response
          await apiKeyService.recordUsage(
            req.apiKey.id,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            model,
            responseAccountId
          )

          // 更新时间窗口内的token计数和费用
          if (req.rateLimitInfo) {
            const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

            // 更新Token计数（向后兼容）
            await redis.getClient().incrby(req.rateLimitInfo.tokenCountKey, totalTokens)
            logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`)

            // 计算并更新费用计数（新功能）
            if (req.rateLimitInfo.costCountKey) {
              const costInfo = pricingService.calculateCost(jsonData.usage, model)
              if (costInfo.totalCost > 0) {
                await redis
                  .getClient()
                  .incrbyfloat(req.rateLimitInfo.costCountKey, costInfo.totalCost)
                logger.api(`💰 Updated rate limit cost count: +$${costInfo.totalCost.toFixed(6)}`)
              }
            }
          }

          usageRecorded = true
          logger.api(
            `📊 Non-stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
          )
        } else {
          logger.warn('⚠️ No usage data found in Claude API JSON response')
        }

        res.json(jsonData)
      } catch (parseError) {
        logger.warn('⚠️ Failed to parse Claude API response as JSON:', parseError.message)
        logger.info('📄 Raw response body:', response.body)
        res.send(response.body)
      }

      // 如果没有记录usage，只记录警告，不进行估算
      if (!usageRecorded) {
        logger.warn(
          '⚠️ No usage data recorded for non-stream request - no statistics recorded (official data only)'
        )
      }
    }

    const duration = Date.now() - startTime
    logger.api(`✅ Request completed in ${duration}ms for key: ${req.apiKey.name}`)
    return undefined
  } catch (error) {
    logger.error('❌ Claude relay error:', error.message, {
      code: error.code,
      stack: error.stack
    })

    // 确保在任何情况下都能返回有效的JSON响应
    if (!res.headersSent) {
      // 根据错误类型设置适当的状态码
      let statusCode = 500
      let errorType = 'Relay service error'

      if (error.message.includes('Connection reset') || error.message.includes('socket hang up')) {
        statusCode = 502
        errorType = 'Upstream connection error'
      } else if (error.message.includes('Connection refused')) {
        statusCode = 502
        errorType = 'Upstream service unavailable'
      } else if (error.message.includes('timeout')) {
        statusCode = 504
        errorType = 'Upstream timeout'
      } else if (error.message.includes('resolve') || error.message.includes('ENOTFOUND')) {
        statusCode = 502
        errorType = 'Upstream hostname resolution failed'
      }

      return res.status(statusCode).json({
        error: errorType,
        message: error.message || 'An unexpected error occurred',
        timestamp: new Date().toISOString()
      })
    } else {
      // 如果响应头已经发送，尝试结束响应
      if (!res.destroyed && !res.finished) {
        res.end()
      }
      return undefined
    }
  }
}

// 🚀 Claude API messages 端点 - /api/v1/messages
router.post('/v1/messages', authenticateApiKey, handleMessagesRequest)

// 🚀 Claude API messages 端点 - /claude/v1/messages (别名)
router.post('/claude/v1/messages', authenticateApiKey, handleMessagesRequest)

// 📋 模型列表端点 - Claude Code 客户端需要
router.get('/v1/models', authenticateApiKey, async (req, res) => {
  try {
    // 返回支持的模型列表
    const models = [
      {
        id: 'claude-3-5-sonnet-20241022',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-3-5-haiku-20241022',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-3-opus-20240229',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-sonnet-4-20250514',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      }
    ]

    res.json({
      object: 'list',
      data: models
    })
  } catch (error) {
    logger.error('❌ Models list error:', error)
    res.status(500).json({
      error: 'Failed to get models list',
      message: error.message
    })
  }
})

// 🏥 健康检查端点
router.get('/health', async (req, res) => {
  try {
    const healthStatus = await claudeRelayService.healthCheck()

    res.status(healthStatus.healthy ? 200 : 503).json({
      status: healthStatus.healthy ? 'healthy' : 'unhealthy',
      service: 'claude-relay-service',
      version: '1.0.0',
      ...healthStatus
    })
  } catch (error) {
    logger.error('❌ Health check error:', error)
    res.status(503).json({
      status: 'unhealthy',
      service: 'claude-relay-service',
      error: error.message,
      timestamp: new Date().toISOString()
    })
  }
})

// 📊 API Key状态检查端点 - /api/v1/key-info
router.get('/v1/key-info', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      keyInfo: {
        id: req.apiKey.id,
        name: req.apiKey.name,
        tokenLimit: req.apiKey.tokenLimit,
        usage
      },
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ Key info error:', error)
    res.status(500).json({
      error: 'Failed to get key info',
      message: error.message
    })
  }
})

// 📈 使用统计端点 - /api/v1/usage
router.get('/v1/usage', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      usage,
      limits: {
        tokens: req.apiKey.tokenLimit,
        requests: 0 // 请求限制已移除
      },
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ Usage stats error:', error)
    res.status(500).json({
      error: 'Failed to get usage stats',
      message: error.message
    })
  }
})

// 👤 用户信息端点 - Claude Code 客户端需要
router.get('/v1/me', authenticateApiKey, async (req, res) => {
  try {
    // 返回基础用户信息
    res.json({
      id: `user_${req.apiKey.id}`,
      type: 'user',
      display_name: req.apiKey.name || 'API User',
      created_at: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ User info error:', error)
    res.status(500).json({
      error: 'Failed to get user info',
      message: error.message
    })
  }
})

// 💰 余额/限制端点 - Claude Code 客户端需要
router.get('/v1/organizations/:org_id/usage', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      object: 'usage',
      data: [
        {
          type: 'credit_balance',
          credit_balance: req.apiKey.tokenLimit - (usage.totalTokens || 0)
        }
      ]
    })
  } catch (error) {
    logger.error('❌ Organization usage error:', error)
    res.status(500).json({
      error: 'Failed to get usage info',
      message: error.message
    })
  }
})

// 🔢 Token计数端点 - count_tokens beta API
router.post('/v1/messages/count_tokens', authenticateApiKey, async (req, res) => {
  try {
    // 检查权限
    if (
      req.apiKey.permissions &&
      req.apiKey.permissions !== 'all' &&
      req.apiKey.permissions !== 'claude'
    ) {
      return res.status(403).json({
        error: {
          type: 'permission_error',
          message: 'This API key does not have permission to access Claude'
        }
      })
    }

    logger.info(`🔢 Processing token count request for key: ${req.apiKey.name}`)

    // 生成会话哈希用于sticky会话
    const sessionHash = sessionHelper.generateSessionHash(req.body)

    // 选择可用的Claude账户
    const requestedModel = req.body.model
    const { accountId, accountType } = await unifiedClaudeScheduler.selectAccountForApiKey(
      req.apiKey,
      sessionHash,
      requestedModel
    )

    let response
    if (accountType === 'claude-official') {
      // 使用官方Claude账号转发count_tokens请求
      response = await claudeRelayService.relayRequest(
        req.body,
        req.apiKey,
        req,
        res,
        req.headers,
        {
          skipUsageRecord: true, // 跳过usage记录，这只是计数请求
          customPath: '/v1/messages/count_tokens' // 指定count_tokens路径
        }
      )
    } else if (accountType === 'claude-console') {
      // 使用Console Claude账号转发count_tokens请求
      response = await claudeConsoleRelayService.relayRequest(
        req.body,
        req.apiKey,
        req,
        res,
        req.headers,
        accountId,
        {
          skipUsageRecord: true, // 跳过usage记录，这只是计数请求
          customPath: '/v1/messages/count_tokens' // 指定count_tokens路径
        }
      )
    } else if (accountType === 'ccr') {
      // CCR不支持count_tokens
      return res.status(501).json({
        error: {
          type: 'not_supported',
          message: 'Token counting is not supported for CCR accounts'
        }
      })
    } else {
      // Bedrock不支持count_tokens
      return res.status(501).json({
        error: {
          type: 'not_supported',
          message: 'Token counting is not supported for Bedrock accounts'
        }
      })
    }

    // 直接返回响应，不记录token使用量
    res.status(response.statusCode)

    // 设置响应头
    const skipHeaders = ['content-encoding', 'transfer-encoding', 'content-length']
    Object.keys(response.headers).forEach((key) => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, response.headers[key])
      }
    })

    // 尝试解析并返回JSON响应
    try {
      const jsonData = JSON.parse(response.body)
      res.json(jsonData)
    } catch (parseError) {
      res.send(response.body)
    }

    logger.info(`✅ Token count request completed for key: ${req.apiKey.name}`)
  } catch (error) {
    logger.error('❌ Token count error:', error)
    res.status(500).json({
      error: {
        type: 'server_error',
        message: 'Failed to count tokens'
      }
    })
  }
})

module.exports = router
module.exports.handleMessagesRequest = handleMessagesRequest
