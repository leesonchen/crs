const logger = require('../utils/logger')

class ClaudeToOpenAIResponsesConverter {
  constructor(options = {}) {
    this.modelMapping = options.modelMapping || {}
    this.defaultModel = options.defaultModel || 'gpt-5'
  }

  mapModel(claudeModel) {
    if (!claudeModel) return this.defaultModel
    const mapped = this.modelMapping[claudeModel]
    if (mapped) return mapped
    logger.warn(`Claude→OpenAI model mapping missing for '${claudeModel}', using default ${this.defaultModel}`)
    return this.defaultModel
  }

  convertRequest(claudeRequest) {
    if (!claudeRequest || typeof claudeRequest !== 'object') {
      throw new Error('Invalid Claude request body')
    }

    const { model, messages, system, stream } = claudeRequest

    // First phase: limitations for v1
    if (claudeRequest.tools || claudeRequest.tool_choice) {
      const err = new Error('Tools are not supported in /claude/openai (phase 1)')
      err.status = 400
      throw err
    }

    // Multi-modal not supported in phase 1
    const hasNonText = Array.isArray(messages) && messages.some((m) => {
      if (Array.isArray(m.content)) return m.content.some((c) => c.type && c.type !== 'text')
      return false
    })
    if (hasNonText) {
      const err = new Error('Non-text content is not supported in /claude/openai (phase 1)')
      err.status = 400
      throw err
    }

    const openaiModel = this.mapModel(model)

    // Compose OpenAI messages: merge system into first system message
    const openaiMessages = []
    if (system) {
      if (typeof system === 'string') {
        openaiMessages.push({ role: 'system', content: system })
      } else if (Array.isArray(system) && system.length > 0) {
        // Claude system could be array of text blocks
        const first = system[0]
        if (first && first.type === 'text' && first.text) {
          openaiMessages.push({ role: 'system', content: first.text })
        }
      }
    }

    if (Array.isArray(messages)) {
      for (const m of messages) {
        const role = m.role === 'assistant' ? 'assistant' : 'user'
        let contentText = ''
        if (typeof m.content === 'string') contentText = m.content
        else if (Array.isArray(m.content)) {
          const texts = m.content.filter((c) => c.type === 'text').map((c) => c.text || '')
          contentText = texts.join('')
        }
        openaiMessages.push({ role, content: contentText })
      }
    }

    const responsesRequest = {
      model: openaiModel,
      input: openaiMessages,
      // The OpenAI Responses API treats streaming differently; we pass through
      stream: !!stream
    }

    return responsesRequest
  }
}

module.exports = ClaudeToOpenAIResponsesConverter



