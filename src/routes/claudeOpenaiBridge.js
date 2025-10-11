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

// POST /claude/openai/v1/messages
router.post('/v1/messages', authenticateApiKey, async (req, res) => {
  try {
    // 权限：允许 claude 或 all
    const perms = req.apiKey.permissions || 'all'
    if (!(perms === 'all' || perms === 'claude')) {
      return res
        .status(403)
        .json({ error: { message: 'Permission denied', type: 'permission_denied' } })
    }

    logger.info('🔁 Claude→OpenAI bridge request received', {
      requestId: req.requestId,
      stream: Boolean(req.body && req.body.stream),
      claudeModel: req.body && req.body.model
    })

    res.setHeader('x-crs-bridge', 'claude-openai')

    // 将 Claude 请求转为 OpenAI-Responses 请求
    const clientType = req.headers['user-agent'] ? req.headers['user-agent'].toLowerCase().includes('codex_cli') ? 'codex_cli' : 'unknown' : 'unknown'
    const toOpenAI = new ClaudeToOpenAIResponsesConverter({ modelMapping, defaultModel })
    const toClaude = new OpenAIResponsesToClaudeConverter({
      clientType,
      targetFormat: 'claude'
    })
    const originalStream = Boolean(req.body && req.body.stream)
    const responsesRequest = toOpenAI.convertRequest(req.body)

    // 仅调度 OpenAI-Responses 账户
    const { account } = await (async () => {
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

    if (!originalStream) {
      responsesRequest.stream = true
      req._bridgeForceNonStream = true
      req._bridgeConverter = toClaude
      req._bridgeStreamTransform = (chunkStr) => {
        toClaude.convertStreamChunk(chunkStr)
        return null
      }
      req._bridgeStreamFinalize = () => {
        toClaude.finalizeStream()
        return null
      }
      req._bridgeNonStreamConvert = () => {
        const finalResponse = toClaude.getFinalResponse()
        if (!finalResponse) {
          throw new Error('Upstream did not provide a final response payload')
        }
        return toClaude.convertNonStream({ response: finalResponse })
      }
    } else {
      // 流式：直接将 SSE 转回 Claude 兼容格式
      req._bridgeStreamTransform = (chunkStr) => toClaude.convertStreamChunk(chunkStr)
      req._bridgeStreamFinalize = () => toClaude.finalizeStream()
    }

    // 覆写 req.body 为转换后的 OpenAI-Responses 请求
    req.body = responsesRequest

    return openaiResponsesRelayService.handleRequest(req, res, account, req.apiKey)
  } catch (error) {
    const status = error.status || 500
    logger.error('Claude→OpenAI bridge error:', error)
    return res.status(status).json({ error: { message: error.message || 'bridge error' } })
  }
})

module.exports = router
