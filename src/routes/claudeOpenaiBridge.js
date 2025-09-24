const express = require('express')
const router = express.Router()
const { authenticateApiKey } = require('../middleware/auth')
const logger = require('../utils/logger')
const ClaudeToOpenAIResponsesConverter = require('../services/claudeToOpenAIResponses')
const OpenAIResponsesToClaudeConverter = require('../services/openaiResponsesToClaude')
const openaiResponsesRelayService = require('../services/openaiResponsesRelayService')
const unifiedOpenAIScheduler = require('../services/unifiedOpenAIScheduler')

// Configurable mapping & defaults (phase 1: minimal)
const modelMapping = {}
const defaultModel = 'gpt-5'
const toOpenAI = new ClaudeToOpenAIResponsesConverter({ modelMapping, defaultModel })

// POST /claude/openai/v1/messages
router.post('/v1/messages', authenticateApiKey, async (req, res) => {
  try {
    // 权限：允许 claude 或 all
    const perms = req.apiKey.permissions || 'all'
    if (!(perms === 'all' || perms === 'claude')) {
      return res.status(403).json({ error: { message: 'Permission denied', type: 'permission_denied' } })
    }

    logger.info('🔁 Claude→OpenAI bridge request received', {
      requestId: req.requestId,
      stream: Boolean(req.body && req.body.stream),
      claudeModel: req.body && req.body.model
    })

    res.setHeader('x-crs-bridge', 'claude-openai')

    // 将 Claude 请求转为 OpenAI-Responses 请求
    const toClaude = new OpenAIResponsesToClaudeConverter()
    const responsesRequest = toOpenAI.convertRequest(req.body)

    // 仅调度 OpenAI-Responses 账户
    const { accountId, accountType, account } = await (async () => {
      const result = await unifiedOpenAIScheduler.selectAccountForApiKey(
        req.apiKey,
        null,
        responsesRequest.model
      )
      if (!result || result.accountType !== 'openai-responses') {
        const err = new Error('No OpenAI-Responses account available for bridge')
        err.status = 503
        throw err
      }
      const accountService = require('../services/openaiResponsesAccountService')
      const acc = await accountService.getAccount(result.accountId)
      return { accountId: result.accountId, accountType: result.accountType, account: acc }
    })()

    // 覆写上游路径为 /v1/responses
    req.headers['x-crs-upstream-path'] = '/v1/responses'

    // 覆写 req.body 为转换后的 OpenAI-Responses 请求
    req.body = responsesRequest

    // 流式转换回 Claude SSE
    if (responsesRequest.stream) {
      // 注入流转换回调
      req._bridgeStreamTransform = (chunkStr) => toClaude.convertStreamChunk(chunkStr)
      req._bridgeStreamFinalize = () => toClaude.finalizeStream()
      return openaiResponsesRelayService.handleRequest(req, res, account, req.apiKey)
    }

    // 非流式：让后端返回 JSON，然后在本路由转换为 Claude 消息格式
    req._bridgeNonStreamConvert = (responseData) => toClaude.convertNonStream(responseData)
    return openaiResponsesRelayService.handleRequest(req, res, account, req.apiKey)
  } catch (error) {
    const status = error.status || 500
    logger.error('Claude→OpenAI bridge error:', error)
    return res.status(status).json({ error: { message: error.message || 'bridge error' } })
  }
})

module.exports = router



