/**
 * OpenAI Responses 中继服务 - 负责与 OpenAI API 的直接通信和真实使用统计
 *
 * 核心职责：
 * 1. 纯转发功能：构建 HTTP 请求 + 发送到上游 OpenAI API
 * 2. 真实使用统计：从上游响应中捕获准确的 token 使用量和费用信息
 * 3. 缓存 Token 处理：正确区分缓存读取、缓存创建和实际输入的差异化计费
 * 4. 账户状态管理：处理限流、认证失败等账户状态
 * 5. 流式响应处理：支持 SSE 流式转发和使用数据捕获
 * 6. 桥接转换支持：为 Claude → OpenAI 桥接提供响应格式转换
 *
 * 设计原则：
 * - 专注转发：只负责与上游 API 的通信，不涉及账户选择和格式转换
 * - 真实统计：记录上游 API 返回的真实使用数据，特别是在桥接场景下
 * - 缓存优化：正确处理缓存 token 的计费差异，降低用户成本
 * - 状态同步：及时更新账户状态以支持调度器的负载均衡
 * - 容错处理：网络中断、客户端断开等异常情况的处理
 */
const axios = require('axios')
const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')
const { filterForOpenAI } = require('../../utils/headerFilter')
const openaiResponsesAccountService = require('../account/openaiResponsesAccountService')
const apiKeyService = require('../apiKeyService')
const unifiedOpenAIScheduler = require('../scheduler/unifiedOpenAIScheduler')
const config = require('../../../config/config')
const crypto = require('crypto')
const LRUCache = require('../../utils/lruCache')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')

// lastUsedAt 更新节流（每账户 60 秒内最多更新一次，使用 LRU 防止内存泄漏）
const lastUsedAtThrottle = new LRUCache(1000) // 最多缓存 1000 个账户
const LAST_USED_AT_THROTTLE_MS = 60000

// 账户服务映射（简化后仍保留，供其他函数使用）
function getAccountService(accountType) {
  if (accountType === 'openai') {
    return require('../account/openaiAccountService')
  } else if (accountType === 'openai-chat') {
    return require('../openaiChatAccountService')
  } else if (accountType === 'openai-responses') {
    return require('../account/openaiResponsesAccountService')
  } else if (accountType === 'claude-official') {
    return require('../account/claudeAccountService')
  } else if (accountType === 'claude-console') {
    return require('../account/claudeConsoleAccountService')
  }
  // 默认使用 openai-responses
  return require('../account/openaiResponsesAccountService')
}

// 抽取缓存写入 token，兼容多种字段命名
function extractCacheCreationTokens(usageData) {
  if (!usageData || typeof usageData !== 'object') {
    return 0
  }

  const details = usageData.input_tokens_details || usageData.prompt_tokens_details || {}
  const candidates = [
    details.cache_creation_input_tokens,
    details.cache_creation_tokens,
    usageData.cache_creation_input_tokens,
    usageData.cache_creation_tokens
  ]

  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== '') {
      const parsed = Number(value)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
  }

  return 0
}

class OpenAIResponsesRelayService {
  constructor() {
    this.defaultTimeout = config.requestTimeout || 600000
  }

  // 节流更新 lastUsedAt
  async _throttledUpdateLastUsedAt(accountId, accountType = 'openai-responses') {
    const now = Date.now()
    const lastUpdate = lastUsedAtThrottle.get(accountId)

    if (lastUpdate && now - lastUpdate < LAST_USED_AT_THROTTLE_MS) {
      return // 跳过更新
    }

    lastUsedAtThrottle.set(accountId, now, LAST_USED_AT_THROTTLE_MS)
    const accountService = getAccountService(accountType)
    if (accountService && accountService.updateAccount) {
      await accountService.updateAccount(accountId, {
        lastUsedAt: new Date().toISOString()
      })
    }
  }

  // 处理请求转发
  async handleRequest(req, res, account, apiKeyData) {
    let abortController = null
    let handleClientDisconnect = null
    let accountType = 'openai-responses' // 默认值，在函数作用域中定义

    // 获取会话哈希（如果有的话）
    const sessionId = req.headers['session_id'] || req.body?.session_id
    const sessionHash = sessionId
      ? crypto.createHash('sha256').update(sessionId).digest('hex')
      : null

    try {
      // 重构后：直接使用传入的标准化账户对象
      // Bridge Service 已经完成了账户查询、解密和标准化
      const fullAccount = account
      accountType = account.accountType || 'openai-responses'

      // 验证账户对象必需字段
      if (!fullAccount.apiKey) {
        throw new Error('Invalid account: missing apiKey')
      }
      if (!fullAccount.baseApi) {
        throw new Error('Invalid account: missing baseApi')
      }

      logger.debug(`🔗 Using standardized account, type: ${accountType}`, {
        accountId: fullAccount.id,
        accountName: fullAccount.name,
        platform: fullAccount.platform || 'unknown',
        hasProxy: !!fullAccount.proxy
      })

      // 🔄 模型映射处理（与 Claude Console 架构保持一致）
      const originalModel = req.body?.model
      let mappedModel = originalModel
      let requestBody = req.body

      // 简化：既然已通过路由层进入此方法，即为 OpenAI-Responses 服务
      logger.debug(`🔄 Starting model mapping process:`, {
        accountId: fullAccount.id,
        accountType,
        originalModel
      })

      // ✅ 简化判断：直接检查原始模型是否存在
      if (originalModel) {
        try {
          // 使用对应账户服务的模型映射
          const accountService = getAccountService(accountType)
          if (
            fullAccount.supportedModels &&
            typeof fullAccount.supportedModels === 'object' &&
            !Array.isArray(fullAccount.supportedModels) &&
            accountService.getMappedModel
          ) {
            const newModel = accountService.getMappedModel(
              fullAccount.supportedModels,
              originalModel
            )
            if (newModel && newModel !== originalModel) {
              logger.debug(`🔄 Mapping model from ${originalModel} to ${newModel}`, {
                accountId: fullAccount.id,
                accountName: fullAccount.name
              })
              mappedModel = newModel
              // 创建修改后的请求体副本
              requestBody = {
                ...req.body,
                model: newModel
              }
            }
          }
        } catch (mappingError) {
          logger.warn(`⚠️ [Relay] Model mapping failed for ${originalModel}:`, mappingError)
          // 映射失败时使用原始模型
          requestBody = req.body
        }
      }

      // 创建 AbortController 用于取消请求
      abortController = new AbortController()

      // 设置客户端断开监听器
      // 若客户端中途断开（CLI 关闭、用户中止等），主动中断上游请求并记录
      handleClientDisconnect = () => {
        logger.info('🔌 Client disconnected, aborting OpenAI-Responses request')
        if (abortController && !abortController.signal.aborted) {
          abortController.abort()
        }
      }

      // 监听客户端断开事件
      req.once('close', handleClientDisconnect)
      res.once('close', handleClientDisconnect)

      // 构建目标 URL（允许通过头覆盖上游路径，并根据 providerEndpoint 归一化）
      const providerEndpoint = fullAccount.providerEndpoint || 'responses'
      const upstreamPath = req.headers['x-crs-upstream-path'] || req.path
      let targetPath = upstreamPath

      // 根据 providerEndpoint 配置归一化路径
      // 注意：unified.js 已将 /v1/chat/completions 的请求体转换为 Responses 格式，
      // 因此这里只需归一化路径即可；反向 responses→completions 需要同时转换请求体，
      // 目前不支持，所以只保留 responses 和 auto 两种模式
      if (
        providerEndpoint === 'responses' &&
        (targetPath === '/v1/chat/completions' || targetPath === '/chat/completions')
      ) {
        const newPath = targetPath.startsWith('/v1') ? '/v1/responses' : '/responses'
        logger.info(`📝 Normalized path (${req.path}) → ${newPath} (providerEndpoint=responses)`)
        targetPath = newPath
      }
      // providerEndpoint === 'auto' 时保持原始路径不变

      // 智能拼接 URL，避免重复路径片段
      let targetUrl
      const baseApi = fullAccount.baseApi.replace(/\/+$/, '') // 移除末尾斜杠

      // 防止 baseApi 已含 /v1 时路径重复（如 baseApi=http://host/v1 + targetPath=/v1/responses → /v1/v1/responses）
      if (baseApi.endsWith('/v1') && targetPath.startsWith('/v1/')) {
        targetPath = targetPath.slice(3) // '/v1/responses' → '/responses'
      }

      const upstreamVersionedPathMatch = targetPath.match(/^\/v\d+(\/.*)$/)
      const baseApiVersionedMatch = baseApi.match(/\/v\d+$/)
      // 如果 baseApi 已包含完整路径（如 /v1/responses），则检测并避免重复
      if (baseApi.endsWith(targetPath)) {
        targetUrl = baseApi
      } else if (baseApiVersionedMatch && upstreamVersionedPathMatch) {
        // baseApi 已带版本路径（如 /v1、/v2），请求路径也带版本时仅拼接资源部分
        // 例如: https://host/v2 + /v1/chat/completions => https://host/v2/chat/completions
        targetUrl = `${baseApi}${upstreamVersionedPathMatch[1]}`
      } else {
        // 正常拼接
        targetUrl = `${baseApi}${targetPath}`
      }
      logger.info(`🎯 Forwarding to: ${targetUrl}`)

      // 构建请求头 - 使用统一的 headerFilter 移除 CDN headers
      const headers = {
        ...filterForOpenAI(req.headers),
        Authorization: `Bearer ${fullAccount.apiKey}`,
        'Content-Type': 'application/json'
      }

      // User-Agent 处理
      if (fullAccount.userAgent) {
        headers['User-Agent'] = fullAccount.userAgent
      } else if (req.headers['user-agent']) {
        headers['User-Agent'] = req.headers['user-agent']
      }

      // ChatGPT Codex API 特殊 headers（由 Bridge Service 准备的 chatgptAccountId）
      if (accountType === 'openai' && fullAccount.chatgptAccountId) {
        headers['chatgpt-account-id'] = fullAccount.chatgptAccountId
        headers['host'] = 'chatgpt.com'
        logger.debug(`🔑 Codex API headers: chatgpt-account-id=${fullAccount.chatgptAccountId}`)
      }

      // 配置请求选项
      const requestOptions = {
        method: req.method,
        url: targetUrl,
        headers,
        data: requestBody,
        timeout: this.defaultTimeout,
        responseType: requestBody?.stream ? 'stream' : 'json',
        validateStatus: () => true, // 允许处理所有状态码
        signal: abortController.signal
      }

      // 配置代理（如果有）
      if (fullAccount.proxy) {
        const proxyAgent = ProxyHelper.createProxyAgent(fullAccount.proxy)
        if (proxyAgent) {
          requestOptions.httpAgent = proxyAgent
          requestOptions.httpsAgent = proxyAgent
          requestOptions.proxy = false
          logger.info(
            `🌐 Using proxy for OpenAI-Responses: ${ProxyHelper.getProxyDescription(fullAccount.proxy)}`
          )
        }
      }

      // 记录请求信息
      logger.info('📤 OpenAI-Responses relay request', {
        accountId: account.id,
        accountName: account.name,
        targetUrl,
        method: req.method,
        stream: requestBody?.stream || false,
        originalModel: originalModel || 'unknown',
        finalModel: mappedModel || 'unknown',
        modelMapped: mappedModel !== originalModel,
        userAgent: headers['User-Agent'] || 'not set'
      })

      // 发送请求
      const response = await axios(requestOptions)

      // 处理 429 限流错误
      if (response.status === 429) {
        const { resetsInSeconds, errorData } = await this._handle429Error(
          account,
          response,
          req.body?.stream,
          sessionHash,
          accountType
        )

        const oaiAutoProtectionDisabled =
          account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
        if (!oaiAutoProtectionDisabled) {
          await upstreamErrorHelper
            .markTempUnavailable(
              account.id,
              'openai-responses',
              429,
              resetsInSeconds || upstreamErrorHelper.parseRetryAfter(response.headers)
            )
            .catch(() => {})
        }

        // 返回错误响应（使用处理后的数据，避免循环引用）
        const errorResponse = errorData || {
          error: {
            message: 'Rate limit exceeded',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
            resets_in_seconds: resetsInSeconds
          }
        }
        return res.status(429).json(errorResponse)
      }

      // 处理其他错误状态码
      if (response.status >= 400) {
        // 处理流式错误响应
        let errorData = response.data
        if (response.data && typeof response.data.pipe === 'function') {
          // 流式响应需要先读取内容
          const chunks = []
          await new Promise((resolve) => {
            response.data.on('data', (chunk) => chunks.push(chunk))
            response.data.on('end', resolve)
            response.data.on('error', resolve)
            setTimeout(resolve, 5000) // 超时保护
          })
          const fullResponse = Buffer.concat(chunks).toString()

          // 尝试解析错误响应
          try {
            if (fullResponse.includes('data: ')) {
              // SSE格式
              const lines = fullResponse.split('\n')
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const jsonStr = line.slice(6).trim()
                  if (jsonStr && jsonStr !== '[DONE]') {
                    errorData = JSON.parse(jsonStr)
                    break
                  }
                }
              }
            } else if (fullResponse && fullResponse.trim()) {
              // 普通JSON - 只在有内容时解析
              try {
                errorData = JSON.parse(fullResponse)
              } catch (parseError) {
                logger.debug('Failed to parse as JSON, treating as plain text:', parseError.message)
                errorData = { error: { message: fullResponse.trim() } }
              }
            } else {
              // 空响应
              logger.warn('⚠️ Upstream returned empty response body')
              errorData = { error: { message: 'Empty response from upstream' } }
            }
          } catch (e) {
            logger.error('Failed to parse error response:', e)
            errorData = { error: { message: fullResponse || 'Unknown error' } }
          }
        }

        logger.error('OpenAI-Responses API error', {
          status: response.status,
          statusText: response.statusText,
          errorData
        })

        // 处理 502 Bad Gateway 错误
        if (response.status === 502) {
          let reason = 'OpenAI 上游服务不可用（502 Bad Gateway）'

          // 特殊处理 ChatGPT Codex API
          if (fullAccount.baseApi?.includes('chatgpt.com')) {
            reason =
              'ChatGPT Codex API 返回 502 错误，可能原因：\n' +
              '1. 账户无 Codex API 访问权限\n' +
              '2. API 端点不支持当前认证方式\n' +
              '3. 上游服务暂时不可用\n' +
              '建议：使用 OpenAI-Responses (API Key) 账户代替 OAuth 账户'
          }

          await this._handle502Error(account, response, req.body?.stream, sessionHash, accountType)

          const errorResponse = {
            type: 'error',
            error: {
              type: 'api_error',
              message: reason
            }
          }
          return res.status(502).json(errorResponse)
        }

        if (response.status === 401) {
          logger.warn(`🚫 OpenAI Responses账号认证失败（401错误）for account ${account?.id}`)

          try {
            // 仅临时暂停，不永久禁用
            const oaiAutoProtectionDisabled =
              account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
            if (!oaiAutoProtectionDisabled) {
              await upstreamErrorHelper
                .markTempUnavailable(account.id, 'openai-responses', 401)
                .catch(() => {})
            }
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.error(
              '❌ Failed to mark OpenAI-Responses account temporarily unavailable after 401:',
              markError
            )
          }

          let unauthorizedResponse = errorData
          if (
            !unauthorizedResponse ||
            typeof unauthorizedResponse !== 'object' ||
            unauthorizedResponse.pipe ||
            Buffer.isBuffer(unauthorizedResponse)
          ) {
            const fallbackMessage =
              typeof errorData === 'string' && errorData.trim() ? errorData.trim() : 'Unauthorized'
            unauthorizedResponse = {
              error: {
                message: fallbackMessage,
                type: 'unauthorized',
                code: 'unauthorized'
              }
            }
          }

          // 清理监听器
          req.removeListener('close', handleClientDisconnect)
          res.removeListener('close', handleClientDisconnect)

          return res.status(401).json(unauthorizedResponse)
        }

        // 处理 5xx 上游错误
        if (response.status >= 500 && account?.id) {
          try {
            const oaiAutoProtectionDisabled =
              account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
            if (!oaiAutoProtectionDisabled) {
              await upstreamErrorHelper.markTempUnavailable(
                account.id,
                'openai-responses',
                response.status
              )
            }
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.warn(
              'Failed to mark OpenAI-Responses account temporarily unavailable:',
              markError
            )
          }
        }

        // 清理监听器
        req.removeListener('close', handleClientDisconnect)
        res.removeListener('close', handleClientDisconnect)

        return res
          .status(response.status)
          .json(upstreamErrorHelper.sanitizeErrorForClient(errorData))
      }

      // 更新最后使用时间（节流）
      await this._throttledUpdateLastUsedAt(account.id, accountType)

      // 处理流式响应（支持转换器）
      if (req.body?.stream && response.data && typeof response.data.pipe === 'function') {
        return this._handleStreamResponse(
          response,
          res,
          account,
          apiKeyData,
          req.body?.model,
          handleClientDisconnect,
          req,
          accountType
        )
      }

      // 处理非流式响应
      return this._handleNormalResponse(
        response,
        res,
        account,
        apiKeyData,
        req.body?.model,
        req,
        accountType
      )
    } catch (error) {
      // 清理 AbortController
      if (abortController && !abortController.signal.aborted) {
        abortController.abort()
      }

      if (handleClientDisconnect) {
        req.removeListener('close', handleClientDisconnect)
        res.removeListener('close', handleClientDisconnect)
      }

      // axios 在 abort() 后会抛出 CanceledError，这属于预期流程而非异常
      const isClientCanceled =
        error?.code === 'ERR_CANCELED' ||
        error?.name === 'CanceledError' ||
        error?.message === 'canceled'

      if (isClientCanceled) {
        logger.info('OpenAI-Responses relay canceled due to client disconnect', {
          requestId: req.requestId
        })

        if (!res.headersSent && !res.writableEnded) {
          // 499 用于标记客户端主动断开，方便上游或日志聚合识别
          return res.status(499).json({ error: { message: 'Client disconnected' } })
        }
        return res.end()
      }

      // 安全地记录错误，避免循环引用
      const errorInfo = {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        statusText: error.response?.statusText
      }
      logger.error('OpenAI-Responses relay error:', errorInfo)

      // 检查是否是网络错误（根据 accountType 动态选择 service）
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        if (account?.id) {
          const oaiAutoProtectionDisabled =
            account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
          if (!oaiAutoProtectionDisabled) {
            await upstreamErrorHelper
              .markTempUnavailable(account.id, 'openai-responses', 503)
              .catch(() => {})
          }
        }
      }

      // 如果已经发送了响应头，直接结束
      if (res.headersSent) {
        return res.end()
      }

      // 检查是否是axios错误并包含响应
      if (error.response) {
        // 处理axios错误响应
        const status = error.response.status || 500
        let errorData = {
          error: {
            message: error.response.statusText || 'Request failed',
            type: 'api_error',
            code: error.code || 'unknown'
          }
        }

        // 如果响应包含数据，尝试使用它
        if (error.response.data) {
          // 检查是否是流
          if (typeof error.response.data === 'object' && !error.response.data.pipe) {
            errorData = error.response.data
          } else if (typeof error.response.data === 'string') {
            try {
              errorData = JSON.parse(error.response.data)
            } catch (e) {
              errorData.error.message = error.response.data
            }
          }
        }

        if (status === 401) {
          logger.warn(
            `🚫 OpenAI Responses账号认证失败（401错误）for account ${account?.id} (catch handler)`
          )

          try {
            // 仅临时暂停，不永久禁用
            const oaiAutoProtectionDisabled =
              account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
            if (!oaiAutoProtectionDisabled) {
              await upstreamErrorHelper
                .markTempUnavailable(account.id, 'openai-responses', 401)
                .catch(() => {})
            }
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.error(
              '❌ Failed to mark OpenAI-Responses account temporarily unavailable in catch handler:',
              markError
            )
          }

          let unauthorizedResponse = errorData
          if (
            !unauthorizedResponse ||
            typeof unauthorizedResponse !== 'object' ||
            unauthorizedResponse.pipe ||
            Buffer.isBuffer(unauthorizedResponse)
          ) {
            const fallbackMessage =
              typeof errorData === 'string' && errorData.trim() ? errorData.trim() : 'Unauthorized'
            unauthorizedResponse = {
              error: {
                message: fallbackMessage,
                type: 'unauthorized',
                code: 'unauthorized'
              }
            }
          }

          return res.status(401).json(unauthorizedResponse)
        }

        return res.status(status).json(upstreamErrorHelper.sanitizeErrorForClient(errorData))
      }

      // 其他错误
      return res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'internal_error',
          details: error.message
        }
      })
    }
  }

  // 处理流式响应
  async _handleStreamResponse(
    response,
    res,
    account,
    apiKeyData,
    requestedModel,
    handleClientDisconnect,
    req,
    accountType = 'openai-responses'
  ) {
    const forceNonStream = Boolean(req._bridgeForceNonStream)

    if (!forceNonStream) {
      // SSE 响应头仅在原始请求就是流式时设置
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders()
      }
    } else {
      // 非流式模式同样关闭缓存
      res.setHeader('Cache-Control', 'no-cache')
    }

    let usageData = null
    let actualModel = null
    let buffer = ''
    let rateLimitDetected = false
    let rateLimitResetsInSeconds = null
    let streamEnded = false
    const _eventDebugCount = 0
    const allSSEEvents = [] // 记录所有SSE事件用于完整调试

    // 解析 SSE 事件以捕获 usage 数据和 model - 支持多种供应商格式
    const parseSSEForUsage = (data) => {
      const lines = data.split('\n')

      for (const line of lines) {
        if (line.startsWith('data:')) {
          try {
            const jsonStr = line.slice(5).trim()
            if (jsonStr === '[DONE]') {
              continue
            }

            const eventData = JSON.parse(jsonStr)

            // 供应商格式识别
            const detectedVendor = this._detectSSEVendor(eventData)

            // 记录所有SSE事件完整内容（移除5事件限制）
            const eventDataSummary = {
              eventNumber: allSSEEvents.length + 1,
              type: eventData.type,
              vendor: detectedVendor,
              hasUsage: !!(
                eventData.response?.usage ||
                eventData.usage ||
                eventData.message?.usage
              ),
              hasModel: !!(
                eventData.response?.model ||
                eventData.model ||
                eventData.message?.model
              ),
              hasContent: !!(
                eventData.content ||
                eventData.delta ||
                eventData.response?.output_text
              ),
              keys: Object.keys(eventData),
              // 记录完整事件内容用于深度调试
              fullContent: eventData
            }

            allSSEEvents.push(eventDataSummary)

            logger.info('📡 [SSE] Received event:', {
              eventNumber: eventDataSummary.eventNumber,
              type: eventData.type,
              vendor: detectedVendor,
              hasUsage: eventDataSummary.hasUsage,
              hasModel: eventDataSummary.hasModel,
              hasContent: eventDataSummary.hasContent,
              keys: eventDataSummary.keys,
              // 记录关键内容但避免日志过于冗长
              ...(eventDataSummary.hasUsage && {
                usage: eventData.response?.usage || eventData.usage || eventData.message?.usage
              }),
              ...(eventDataSummary.hasModel && {
                model: eventData.response?.model || eventData.model || eventData.message?.model
              }),
              ...(eventDataSummary.hasContent && {
                contentPreview: this._extractContentPreview(eventData)
              })
            })

            // 支持多种供应商格式的 usage 和 model 提取

            // 1. OpenAI Responses 格式：response.completed
            if (eventData.type === 'response.completed' && eventData.response) {
              if (eventData.response.model) {
                actualModel = eventData.response.model
                logger.debug(`📊 Captured actual model from response.completed: ${actualModel}`)
              }
              if (eventData.response.usage) {
                usageData = eventData.response.usage
                logger.info('📊 Successfully captured usage data from response.completed:', {
                  input_tokens: usageData.input_tokens,
                  output_tokens: usageData.output_tokens,
                  total_tokens: usageData.total_tokens
                })
              }
            }

            // 2. 智谱AI/Claude 格式：message_stop（带完整响应信息）
            else if (eventData.type === 'message_stop' && eventData.message) {
              if (eventData.message.model) {
                actualModel = eventData.message.model
                logger.debug(`📊 Captured actual model from message_stop: ${actualModel}`)
              }
              if (eventData.message.usage) {
                usageData = eventData.message.usage
                logger.info('📊 Successfully captured usage data from message_stop:', {
                  input_tokens: usageData.input_tokens,
                  output_tokens: usageData.output_tokens,
                  total_tokens: usageData.total_tokens
                })
              }
            }

            // 3. Claude 标准格式：message_delta（增量usage信息）
            else if (eventData.type === 'message_delta') {
              if (eventData.model) {
                actualModel = eventData.model
                logger.debug(`📊 Captured actual model from message_delta: ${actualModel}`)
              }
              if (eventData.usage) {
                usageData = { ...usageData, ...eventData.usage } // 合并usage数据
                logger.debug(
                  '📊 Captured incremental usage data from message_delta:',
                  eventData.usage
                )
              }
              // 检查 stop_reason 表示流结束
              if (eventData.delta?.stop_reason) {
                logger.debug('📊 Stream completion detected via message_delta stop_reason')
              }
            }

            // 4. 其他可能的格式：直接在事件根级别包含usage/model
            else if (eventData.type && (eventData.usage || eventData.model)) {
              if (eventData.model) {
                actualModel = eventData.model
                logger.debug(`📊 Captured actual model from direct event: ${actualModel}`)
              }
              if (eventData.usage) {
                usageData = { ...usageData, ...eventData.usage }
                logger.debug('📊 Captured usage data from direct event:', eventData.usage)
              }
            }

            // 检查是否是流完成事件（各种格式）
            if (
              eventData.type === 'message_stop' ||
              eventData.type === 'response.completed' ||
              (eventData.type === 'message_delta' && eventData.delta?.stop_reason)
            ) {
              logger.debug(`📊 Stream completion detected via event: ${eventData.type}`)
            }

            // 检查是否有限流错误（各种格式）
            if (eventData.error) {
              if (
                eventData.error.type === 'rate_limit_error' ||
                eventData.error.type === 'usage_limit_reached' ||
                eventData.error.type === 'rate_limit_exceeded'
              ) {
                rateLimitDetected = true
                if (eventData.error.resets_in_seconds) {
                  rateLimitResetsInSeconds = eventData.error.resets_in_seconds
                  logger.warn(
                    `🚫 Rate limit detected in stream, resets in ${rateLimitResetsInSeconds} seconds (${Math.ceil(rateLimitResetsInSeconds / 60)} minutes)`
                  )
                }
              }
            }
          } catch (e) {
            logger.debug('Failed to parse SSE event:', e.message)
          }
        }
      }
    }

    // 监听数据流
    response.data.on('data', (chunk) => {
      try {
        const chunkStr = chunk.toString()

        // 转发数据（允许桥接路由注入转换器）
        if (!forceNonStream && !res.destroyed && !streamEnded) {
          const transform = req._bridgeStreamTransform

          if (typeof transform === 'function') {
            const converted = transform(chunkStr)
            if (converted) {
              res.write(converted)
              if (typeof res.flush === 'function') {
                res.flush()
              }
            }
          } else {
            res.write(chunk)
            if (typeof res.flush === 'function') {
              res.flush()
            }
          }
        } else if (forceNonStream) {
          // 强制非流式时也要执行转换器，以便缓存最终响应
          const transform = req._bridgeStreamTransform
          if (typeof transform === 'function') {
            transform(chunkStr)
          }
        }

        // 同时解析数据以捕获 usage 信息
        buffer += chunkStr

        // 处理完整的 SSE 事件
        if (buffer.includes('\n\n')) {
          const events = buffer.split('\n\n')
          buffer = events.pop() || ''

          for (const event of events) {
            if (event.trim()) {
              parseSSEForUsage(event)
            }
          }
        }
      } catch (error) {
        logger.error('Error processing stream chunk:', error)
      }
    })

    response.data.on('end', async () => {
      streamEnded = true

      // 处理剩余的 buffer
      if (buffer.trim()) {
        parseSSEForUsage(buffer)
      }

      if (typeof req._bridgeStreamFinalize === 'function') {
        try {
          const trailing = req._bridgeStreamFinalize()
          if (!forceNonStream && trailing && !res.destroyed) {
            res.write(trailing)
            if (typeof res.flush === 'function') {
              res.flush()
            }
          }
        } catch (error) {
          logger.error('Bridge stream finalizer error:', error)
        }
      }

      // 记录使用统计 - 支持多格式的usage数据
      if (usageData) {
        try {
          // 确保usageData包含所有必要字段，支持多种格式
          const consolidatedUsage = {
            input_tokens: usageData.input_tokens || usageData.prompt_tokens || 0,
            output_tokens: usageData.output_tokens || usageData.completion_tokens || 0,
            total_tokens: usageData.total_tokens || 0,
            cache_creation_input_tokens: usageData.cache_creation_input_tokens || 0,
            cache_read_input_tokens: usageData.input_tokens_details?.cached_tokens || 0,
            input_tokens_details: usageData.input_tokens_details || {}
          }

          // 如果没有total_tokens，计算总和
          if (!consolidatedUsage.total_tokens) {
            consolidatedUsage.total_tokens =
              consolidatedUsage.input_tokens +
              consolidatedUsage.output_tokens +
              consolidatedUsage.cache_creation_input_tokens
          }

          // 提取缓存相关的 tokens（如果存在）
          const cacheReadTokens = consolidatedUsage.cache_read_input_tokens
          const cacheCreateTokens = extractCacheCreationTokens(consolidatedUsage)
          // 计算实际输入token（总输入减去缓存部分）
          const actualInputTokens = Math.max(0, consolidatedUsage.input_tokens - cacheReadTokens)

          const modelToRecord = actualModel || requestedModel || 'unknown'

          const serviceTier = req._serviceTier || null
          await apiKeyService.recordUsage(
            apiKeyData.id,
            actualInputTokens, // 传递实际输入（不含缓存）
            consolidatedUsage.output_tokens,
            cacheCreateTokens,
            cacheReadTokens,
            modelToRecord,
            account.id,
            'openai-responses',
            serviceTier,
            req
          )

          logger.info(
            `📊 Successfully recorded usage - Input: ${consolidatedUsage.input_tokens}(actual:${actualInputTokens}+cached:${cacheReadTokens}), CacheCreate: ${cacheCreateTokens}, Output: ${consolidatedUsage.output_tokens}, Total: ${consolidatedUsage.total_tokens}, Model: ${modelToRecord}`
          )

          // 更新账户的 token 使用统计（根据 accountType 动态选择 service）
          const accountService = getAccountService(accountType)
          if (accountService.updateAccountUsage) {
            await accountService.updateAccountUsage(account.id, consolidatedUsage.total_tokens)
          }

          // 更新账户使用额度（如果设置了额度限制）
          if (parseFloat(account.dailyQuota) > 0) {
            // 使用CostCalculator正确计算费用（考虑缓存token的不同价格）
            const CostCalculator = require('../../utils/costCalculator')
            const costInfo = CostCalculator.calculateCost(
              {
                input_tokens: actualInputTokens, // 实际输入（不含缓存）
                output_tokens: consolidatedUsage.output_tokens,
                cache_creation_input_tokens: cacheCreateTokens,
                cache_read_input_tokens: cacheReadTokens
              },
              modelToRecord,
              serviceTier
            )
            if (accountService.updateUsageQuota) {
              await accountService.updateUsageQuota(account.id, costInfo.costs.total)
            }
          }
        } catch (error) {
          logger.error('Failed to record usage:', error)
        }
      } else {
        // 如果没有捕获到usage数据，使用备用统计机制
        logger.warn('⚠️ No usage data captured from stream, using fallback estimation', {
          accountId: account.id,
          actualModel: actualModel || 'unknown',
          requestedModel: requestedModel || 'unknown'
        })

        try {
          // 估算输入token（基于请求内容）
          let estimatedInputTokens = 0
          if (req.body) {
            const messages = req.body.messages || []
            for (const message of messages) {
              if (message.content) {
                if (typeof message.content === 'string') {
                  estimatedInputTokens += Math.ceil(message.content.length / 4)
                } else if (Array.isArray(message.content)) {
                  for (const part of message.content) {
                    if (typeof part.text === 'string') {
                      estimatedInputTokens += Math.ceil(part.text.length / 4)
                    }
                  }
                }
              }
            }
          }

          // 从流式响应中提取内容用于估算输出token
          let estimatedOutputTokens = 0
          for (const event of allSSEEvents) {
            if (event.hasContent && event.fullContent) {
              const content = this._extractFullContent(event.fullContent)
              if (content) {
                estimatedOutputTokens += Math.ceil(content.length / 4)
              }
            }
          }

          // 如果仍然没有内容，使用默认值
          if (estimatedInputTokens === 0 && estimatedOutputTokens === 0) {
            estimatedInputTokens = 100 // 默认输入token
            estimatedOutputTokens = 50 // 默认输出token
          }

          const modelToRecord = actualModel || requestedModel || 'unknown'

          await apiKeyService.recordUsage(
            apiKeyData.id,
            estimatedInputTokens,
            estimatedOutputTokens,
            0, // cache_create_tokens
            0, // cache_read_tokens
            modelToRecord,
            account.id,
            'openai-responses',
            req
          )

          logger.info(
            `📊 Fallback usage estimation recorded - Input: ${estimatedInputTokens}, Output: ${estimatedOutputTokens}, Model: ${modelToRecord}`
          )

          // 更新账户的使用统计
          const accountService = getAccountService(accountType)
          if (accountService.updateAccountUsage) {
            await accountService.updateAccountUsage(
              account.id,
              estimatedInputTokens + estimatedOutputTokens
            )
          }

          // 更新账户使用额度（如果设置了额度限制）
          if (parseFloat(account.dailyQuota) > 0) {
            const CostCalculator = require('../utils/costCalculator')
            const costInfo = CostCalculator.calculateCost(
              {
                input_tokens: estimatedInputTokens,
                output_tokens: estimatedOutputTokens,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0
              },
              modelToRecord
            )
            if (accountService.updateUsageQuota) {
              await accountService.updateUsageQuota(account.id, costInfo.costs.total)
            }
          }
        } catch (fallbackError) {
          logger.error('Failed to record fallback usage:', fallbackError)
        }
      }

      // 如果在流式响应中检测到限流
      if (rateLimitDetected) {
        // 使用统一调度器处理限流（与非流式响应保持一致）
        const sessionId = req.headers['session_id'] || req.body?.session_id
        const sessionHash = sessionId
          ? crypto.createHash('sha256').update(sessionId).digest('hex')
          : null

        await unifiedOpenAIScheduler.markAccountRateLimited(
          account.id,
          accountType,
          sessionHash,
          rateLimitResetsInSeconds
        )

        logger.warn(
          `🚫 Processing rate limit for OpenAI-Responses account ${account.id} from stream`
        )
      }

      // 清理监听器
      req.removeListener('close', handleClientDisconnect)
      res.removeListener('close', handleClientDisconnect)

      if (forceNonStream) {
        try {
          const convert = req._bridgeNonStreamConvert
          if (typeof convert !== 'function') {
            throw new Error('Missing bridge non-stream converter')
          }

          const convertedPayload = convert()
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'application/json')
          }
          if (!res.destroyed) {
            res.status(200).json(convertedPayload)
          }
        } catch (error) {
          logger.error('Bridge non-stream conversion failed:', error)
          if (!res.headersSent) {
            res.status(500).json({ error: { message: 'Bridge conversion failed' } })
          } else if (!res.destroyed) {
            res.end()
          }
        }
      } else if (!res.destroyed) {
        // 检查是否是流程模拟模式，如果是则不立即结束响应流
        const isFlowSimulationActive =
          req._bridgeConverter &&
          req._bridgeConverter._simulationState &&
          req._bridgeConverter._simulationState.isActive
        if (!isFlowSimulationActive) {
          res.end()
        } else {
          logger.info(`🔄 [Relay] Stream end deferred - flow simulation active`)
        }
      }

      // 记录完整的SSE事件序列总结
      const vendorsDetected = [...new Set(allSSEEvents.map((e) => e.vendor))]
      logger.info('📊 [SSE] Complete event sequence summary:', {
        accountId: account.id,
        totalEvents: allSSEEvents.length,
        detectedVendors: vendorsDetected,
        eventTypes: allSSEEvents.map((e) => e.type),
        hasUsage: !!usageData,
        actualModel: actualModel || 'unknown',
        requestedModel: requestedModel || 'unknown',
        eventsWithUsage: allSSEEvents.filter((e) => e.hasUsage).length,
        eventsWithModel: allSSEEvents.filter((e) => e.hasModel).length,
        eventsWithContent: allSSEEvents.filter((e) => e.hasContent).length,
        completionEvent:
          allSSEEvents.find(
            (e) =>
              e.type === 'response.completed' ||
              e.type === 'message_stop' ||
              (e.type === 'message_delta' && e.fullContent.delta?.stop_reason)
          )?.type || 'none',
        vendorDistribution: vendorsDetected.map((vendor) => ({
          vendor,
          count: allSSEEvents.filter((e) => e.vendor === vendor).length,
          types: [...new Set(allSSEEvents.filter((e) => e.vendor === vendor).map((e) => e.type))]
        }))
      })

      // 如果需要，可以记录详细的事件内容（仅在调试模式下）
      if (process.env.NODE_ENV === 'development' || process.env.DEBUG_SSE_EVENTS === 'true') {
        logger.debug('📊 [SSE] Detailed event contents:', {
          accountId: account.id,
          events: allSSEEvents.map((e) => ({
            eventNumber: e.eventNumber,
            type: e.type,
            keys: e.keys,
            hasUsage: e.hasUsage,
            hasModel: e.hasModel,
            content: e.fullContent
          }))
        })
      }

      logger.info('✅ Stream response completed successfully', {
        accountId: account.id,
        hasUsage: !!usageData,
        actualModel: actualModel || 'unknown',
        requestedModel: requestedModel || 'unknown',
        streamEndedProperly: true
      })
    })

    response.data.on('error', (error) => {
      streamEnded = true
      // 流式转发过程中同样区分正常断开与实际异常，避免噪声告警
      const isClientCanceled =
        error?.code === 'ERR_CANCELED' ||
        error?.name === 'CanceledError' ||
        error?.message === 'canceled'

      if (isClientCanceled) {
        logger.info('Stream canceled due to client disconnect', {
          requestId: req.requestId
        })
      } else {
        logger.error('Stream error:', error)
      }

      // 清理监听器
      if (handleClientDisconnect) {
        req.removeListener('close', handleClientDisconnect)
        res.removeListener('close', handleClientDisconnect)
      }

      if (!res.headersSent) {
        if (isClientCanceled) {
          res.status(499).json({ error: { message: 'Client disconnected' } })
        } else {
          res.status(502).json({ error: { message: 'Upstream stream error' } })
        }
      } else if (!res.destroyed) {
        res.end()
      }
    })

    // 处理客户端断开连接
    const cleanup = () => {
      streamEnded = true
      try {
        response.data?.unpipe?.(res)
        response.data?.destroy?.()
      } catch (_) {
        // 忽略清理错误
      }
    }

    req.on('close', cleanup)
    req.on('aborted', cleanup)
  }

  // 处理非流式响应
  async _handleNormalResponse(
    response,
    res,
    account,
    apiKeyData,
    requestedModel,
    req,
    accountType = 'openai-responses'
  ) {
    const responseData = response.data

    // 提取 usage 数据和实际 model
    // 支持两种格式：直接的 usage 或嵌套在 response 中的 usage
    const usageData = responseData?.usage || responseData?.response?.usage
    const actualModel =
      responseData?.model || responseData?.response?.model || requestedModel || 'gpt-4'

    // 记录使用统计
    if (usageData) {
      try {
        // OpenAI-Responses 使用 input_tokens/output_tokens，标准 OpenAI 使用 prompt_tokens/completion_tokens
        const totalInputTokens = usageData.input_tokens || usageData.prompt_tokens || 0
        const outputTokens = usageData.output_tokens || usageData.completion_tokens || 0

        // 提取缓存相关的 tokens（如果存在）
        const cacheReadTokens = usageData.input_tokens_details?.cached_tokens || 0
        const cacheCreateTokens = extractCacheCreationTokens(usageData)
        // 计算实际输入token（总输入减去缓存部分）
        const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

        const totalTokens =
          usageData.total_tokens || totalInputTokens + outputTokens + cacheCreateTokens

        const serviceTier = req._serviceTier || null
        await apiKeyService.recordUsage(
          apiKeyData.id,
          actualInputTokens, // 传递实际输入（不含缓存）
          outputTokens,
          cacheCreateTokens,
          cacheReadTokens,
          actualModel,
          account.id,
          'openai-responses',
          serviceTier,
          req
        )

        logger.info(
          `📊 Recorded non-stream usage - Input: ${totalInputTokens}(actual:${actualInputTokens}+cached:${cacheReadTokens}), CacheCreate: ${cacheCreateTokens}, Output: ${outputTokens}, Total: ${totalTokens}, Model: ${actualModel}`
        )

        // 更新账户的 token 使用统计（根据 accountType 动态选择 service）
        const accountService = getAccountService(accountType)
        if (accountService.updateAccountUsage) {
          await accountService.updateAccountUsage(account.id, totalTokens)
        }

        // 更新账户使用额度（如果设置了额度限制）
        if (parseFloat(account.dailyQuota) > 0) {
          // 使用CostCalculator正确计算费用（考虑缓存token的不同价格）
          const CostCalculator = require('../../utils/costCalculator')
          const costInfo = CostCalculator.calculateCost(
            {
              input_tokens: actualInputTokens, // 实际输入（不含缓存）
              output_tokens: outputTokens,
              cache_creation_input_tokens: cacheCreateTokens,
              cache_read_input_tokens: cacheReadTokens
            },
            actualModel,
            serviceTier
          )
          if (accountService.updateUsageQuota) {
            await accountService.updateUsageQuota(account.id, costInfo.costs.total)
          }
        }
      } catch (error) {
        logger.error('Failed to record usage:', error)
      }
    } else {
      // 如果没有捕获到usage数据，使用备用统计机制
      logger.warn('⚠️ No usage data captured from normal response, using fallback estimation', {
        accountId: account.id,
        actualModel: actualModel || 'unknown',
        requestedModel: requestedModel || 'unknown'
      })

      try {
        // 估算输入token（基于请求内容）
        let estimatedInputTokens = 0
        if (req.body) {
          const messages = req.body.messages || []
          for (const message of messages) {
            if (message.content) {
              if (typeof message.content === 'string') {
                estimatedInputTokens += Math.ceil(message.content.length / 4)
              } else if (Array.isArray(message.content)) {
                for (const part of message.content) {
                  if (typeof part.text === 'string') {
                    estimatedInputTokens += Math.ceil(part.text.length / 4)
                  }
                }
              }
            }
          }
        }

        // 估算输出token（基于响应内容）
        let estimatedOutputTokens = 0
        if (responseData?.response?.output_text) {
          const outputText = responseData.response.output_text
          if (typeof outputText === 'string') {
            estimatedOutputTokens = Math.ceil(outputText.length / 4)
          } else if (Array.isArray(outputText)) {
            for (const item of outputText) {
              if (typeof item === 'string') {
                estimatedOutputTokens += Math.ceil(item.length / 4)
              } else if (item.text) {
                estimatedOutputTokens += Math.ceil(String(item.text).length / 4)
              }
            }
          }
        } else if (responseData?.choices?.[0]?.message?.content) {
          const { content } = responseData.choices[0].message
          estimatedOutputTokens = Math.ceil(String(content).length / 4)
        } else if (responseData?.content) {
          estimatedOutputTokens = Math.ceil(String(responseData.content).length / 4)
        }

        // 如果仍然没有内容，使用默认值
        if (estimatedInputTokens === 0 && estimatedOutputTokens === 0) {
          estimatedInputTokens = 100 // 默认输入token
          estimatedOutputTokens = 50 // 默认输出token
        }

        const modelToRecord = actualModel || requestedModel || 'unknown'

        await apiKeyService.recordUsage(
          apiKeyData.id,
          estimatedInputTokens,
          estimatedOutputTokens,
          0, // cache_create_tokens
          0, // cache_read_tokens
          modelToRecord,
          account.id,
          'openai-responses',
          req
        )

        logger.info(
          `📊 Fallback usage estimation recorded (non-stream) - Input: ${estimatedInputTokens}, Output: ${estimatedOutputTokens}, Model: ${modelToRecord}`
        )

        // 更新账户的使用统计
        const accountService = getAccountService(accountType)
        if (accountService.updateAccountUsage) {
          await accountService.updateAccountUsage(
            account.id,
            estimatedInputTokens + estimatedOutputTokens
          )
        }

        // 更新账户使用额度（如果设置了额度限制）
        if (parseFloat(account.dailyQuota) > 0) {
          const CostCalculator = require('../utils/costCalculator')
          const costInfo = CostCalculator.calculateCost(
            {
              input_tokens: estimatedInputTokens,
              output_tokens: estimatedOutputTokens,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0
            },
            modelToRecord
          )
          if (accountService.updateUsageQuota) {
            await accountService.updateUsageQuota(account.id, costInfo.costs.total)
          }
        }
      } catch (fallbackError) {
        logger.error('Failed to record fallback usage:', fallbackError)
      }
    }

    // 返回响应（允许桥接路由转换为 Claude 格式）
    const bridgeConvert = req._bridgeNonStreamConvert
    if (typeof bridgeConvert === 'function') {
      const converted = bridgeConvert(responseData)
      return res.status(200).json(converted)
    }
    res.status(response.status).json(responseData)

    logger.info('Normal response completed', {
      accountId: account.id,
      status: response.status,
      hasUsage: !!usageData,
      model: actualModel
    })
  }

  // 处理 429 限流错误
  async _handle429Error(
    account,
    response,
    isStream = false,
    sessionHash = null,
    accountType = 'openai-responses'
  ) {
    let resetsInSeconds = null
    let errorData = null

    try {
      // 对于429错误，响应可能是JSON或SSE格式
      if (isStream && response.data && typeof response.data.pipe === 'function') {
        // 流式响应需要先收集数据
        const chunks = []
        await new Promise((resolve, reject) => {
          response.data.on('data', (chunk) => chunks.push(chunk))
          response.data.on('end', resolve)
          response.data.on('error', reject)
          // 设置超时防止无限等待
          setTimeout(resolve, 5000)
        })

        const fullResponse = Buffer.concat(chunks).toString()

        // 尝试解析SSE格式的错误响应
        if (fullResponse.includes('data: ')) {
          const lines = fullResponse.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const jsonStr = line.slice(6).trim()
                if (jsonStr && jsonStr !== '[DONE]') {
                  errorData = JSON.parse(jsonStr)
                  break
                }
              } catch (e) {
                // 继续尝试下一行
              }
            }
          }
        }

        // 如果SSE解析失败，尝试直接解析为JSON
        if (!errorData) {
          try {
            errorData = JSON.parse(fullResponse)
          } catch (e) {
            logger.error('Failed to parse 429 error response:', e)
            logger.debug('Raw response:', fullResponse)
          }
        }
      } else if (response.data && typeof response.data !== 'object') {
        // 如果response.data是字符串，尝试解析为JSON
        try {
          errorData = JSON.parse(response.data)
        } catch (e) {
          logger.error('Failed to parse 429 error response as JSON:', e)
          errorData = { error: { message: response.data } }
        }
      } else if (response.data && typeof response.data === 'object' && !response.data.pipe) {
        // 非流式响应，且是对象，直接使用
        errorData = response.data
      }

      // 从响应体中提取重置时间（OpenAI 标准格式）
      if (errorData && errorData.error) {
        if (errorData.error.resets_in_seconds) {
          resetsInSeconds = errorData.error.resets_in_seconds
          logger.info(
            `🕐 Rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes / ${Math.ceil(resetsInSeconds / 3600)} hours)`
          )
        } else if (errorData.error.resets_in) {
          // 某些 API 可能使用不同的字段名
          resetsInSeconds = parseInt(errorData.error.resets_in)
          logger.info(
            `🕐 Rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes / ${Math.ceil(resetsInSeconds / 3600)} hours)`
          )
        }
      }

      if (!resetsInSeconds) {
        logger.warn('⚠️ Could not extract reset time from 429 response, using default 60 minutes')
      }
    } catch (e) {
      logger.error('⚠️ Failed to parse rate limit error:', e)
    }

    // 使用统一调度器标记账户为限流状态（与普通OpenAI账号保持一致）
    await unifiedOpenAIScheduler.markAccountRateLimited(
      account.id,
      accountType,
      sessionHash,
      resetsInSeconds
    )

    logger.warn('OpenAI-Responses account rate limited', {
      accountId: account.id,
      accountName: account.name,
      resetsInSeconds: resetsInSeconds || 'unknown',
      resetInMinutes: resetsInSeconds ? Math.ceil(resetsInSeconds / 60) : 60,
      resetInHours: resetsInSeconds ? Math.ceil(resetsInSeconds / 3600) : 1
    })

    // 返回处理后的数据，避免循环引用
    return { resetsInSeconds, errorData }
  }

  // 处理 502 Bad Gateway 错误
  async _handle502Error(
    account,
    response,
    _isStream = false,
    _sessionHash = null,
    accountType = 'openai-responses'
  ) {
    logger.warn(
      `⚠️ Upstream API returned 502 Bad Gateway for account ${account.id} (${accountType})`
    )

    // 502 通常是临时性的上游问题，不标记账户为错误状态
    // 特殊处理 ChatGPT Codex API
    if (account.baseApi?.includes('chatgpt.com')) {
      logger.warn(
        '⚠️ ChatGPT Codex API 502 错误可能表示：OAuth token 不支持 Codex API 或账户无访问权限'
      )
    }

    // 可以记录到监控系统，但不影响账户状态
    return { handled: true }
  }

  // 过滤请求头 - 已迁移到 headerFilter 工具类
  // 此方法保留用于向后兼容，实际使用 filterForOpenAI()
  _filterRequestHeaders(headers) {
    return filterForOpenAI(headers)
  }

  // 🔍 检测SSE事件的供应商格式
  _detectSSEVendor(eventData) {
    // OpenAI Responses 格式特征
    if (eventData.type && eventData.type.startsWith('response.')) {
      return 'openai-responses'
    }
    if (eventData.response && eventData.response.output_text) {
      return 'openai-responses'
    }
    if (eventData.delta && eventData.delta.output_text) {
      return 'openai-responses'
    }

    // 智谱AI格式特征 (类似Claude格式)
    if (
      eventData.type === 'message_start' ||
      eventData.type === 'content_block' ||
      eventData.type === 'content_block_start' ||
      eventData.type === 'content_block_stop' ||
      eventData.type === 'message_stop' ||
      eventData.type === 'message_delta'
    ) {
      return 'zhipuai-claude'
    }

    // Claude官方格式特征
    if (eventData.type && eventData.type.includes('message')) {
      return 'claude-official'
    }
    if (eventData.message && eventData.message.usage) {
      return 'claude-official'
    }

    // Gemini格式特征
    if (eventData.candidate || eventData.usageMetadata) {
      return 'gemini'
    }
    if (eventData.type && eventData.type.includes('candidate')) {
      return 'gemini'
    }

    // 通用格式检测
    if (eventData.usage && eventData.usage.input_tokens) {
      return 'generic-with-usage'
    }
    if (eventData.model && typeof eventData.model === 'string') {
      return 'generic-with-model'
    }

    return 'unknown'
  }

  // 🔍 提取事件内容预览
  _extractContentPreview(eventData) {
    let contentPreview = ''

    // OpenAI Responses 格式
    if (eventData.delta && eventData.delta.output_text) {
      contentPreview =
        typeof eventData.delta.output_text === 'string'
          ? eventData.delta.output_text.substring(0, 50)
          : JSON.stringify(eventData.delta.output_text).substring(0, 50)
    } else if (eventData.response && eventData.response.output_text) {
      contentPreview = Array.isArray(eventData.response.output_text)
        ? eventData.response.output_text.join('').substring(0, 50)
        : String(eventData.response.output_text).substring(0, 50)
    }

    // Claude/智谱AI 格式
    else if (eventData.content && eventData.content.text) {
      contentPreview = eventData.content.text.substring(0, 50)
    } else if (eventData.delta && eventData.delta.text) {
      contentPreview = eventData.delta.text.substring(0, 50)
    } else if (eventData.content && typeof eventData.content === 'string') {
      contentPreview = eventData.content.substring(0, 50)
    }

    // Gemini 格式
    else if (eventData.candidate && eventData.candidate.content) {
      const text = eventData.candidate.content.parts?.[0]?.text || ''
      contentPreview = text.substring(0, 50)
    }

    // 通用内容提取
    else if (eventData.text) {
      contentPreview = eventData.text.substring(0, 50)
    } else if (eventData.content) {
      contentPreview =
        typeof eventData.content === 'string'
          ? eventData.content.substring(0, 50)
          : JSON.stringify(eventData.content).substring(0, 50)
    }

    return contentPreview || 'no_content'
  }

  // 🔍 提取完整事件内容（用于备用统计）
  _extractFullContent(eventData) {
    let content = ''

    // OpenAI Responses 格式
    if (eventData.delta && eventData.delta.output_text) {
      if (typeof eventData.delta.output_text === 'string') {
        content += eventData.delta.output_text
      } else if (Array.isArray(eventData.delta.output_text)) {
        content += eventData.delta.output_text.join('')
      } else {
        content += JSON.stringify(eventData.delta.output_text)
      }
    } else if (eventData.response && eventData.response.output_text) {
      if (typeof eventData.response.output_text === 'string') {
        content += eventData.response.output_text
      } else if (Array.isArray(eventData.response.output_text)) {
        content += eventData.response.output_text.join('')
      } else {
        content += JSON.stringify(eventData.response.output_text)
      }
    }

    // Claude/智谱AI 格式
    else if (eventData.content && eventData.content.text) {
      content += eventData.content.text
    } else if (eventData.delta && eventData.delta.text) {
      content += eventData.delta.text
    } else if (eventData.content && typeof eventData.content === 'string') {
      content += eventData.content
    }

    // Gemini 格式
    else if (eventData.candidate && eventData.candidate.content) {
      const text = eventData.candidate.content.parts?.[0]?.text || ''
      content += text
    }

    // 通用内容提取
    else if (eventData.text) {
      content += eventData.text
    } else if (eventData.content) {
      if (typeof eventData.content === 'string') {
        content += eventData.content
      } else {
        content += JSON.stringify(eventData.content)
      }
    }

    return content
  }

  // 估算费用（简化版本，实际应该根据不同的定价模型）
  _estimateCost(model, inputTokens, outputTokens) {
    // 这是一个简化的费用估算，实际应该根据不同的 API 提供商和模型定价
    const rates = {
      'gpt-4': { input: 0.03, output: 0.06 }, // per 1K tokens
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
      'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
      'claude-3-opus': { input: 0.015, output: 0.075 },
      'claude-3-sonnet': { input: 0.003, output: 0.015 },
      'claude-3-haiku': { input: 0.00025, output: 0.00125 }
    }

    // 查找匹配的模型定价
    let rate = rates['gpt-3.5-turbo'] // 默认使用 GPT-3.5 的价格
    for (const [modelKey, modelRate] of Object.entries(rates)) {
      if (model.toLowerCase().includes(modelKey.toLowerCase())) {
        rate = modelRate
        break
      }
    }

    const inputCost = (inputTokens / 1000) * rate.input
    const outputCost = (outputTokens / 1000) * rate.output
    return inputCost + outputCost
  }
}

module.exports = new OpenAIResponsesRelayService()
