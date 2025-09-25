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
    const inputMessages = []

    const pushText = (role, text) => {
      if (!text) return
      inputMessages.push({
        role,
        content: [
          {
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text
          }
        ]
      })
    }

    const pushToolCall = (id, name, input) => {
      if (!id || !name) return
      let args = '{}'
      try {
        args = JSON.stringify(input ?? {})
      } catch (error) {
        logger.warn(`Failed to stringify tool input for ${name}: ${error.message}`)
      }
      inputMessages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            id,
            name,
            arguments: args
          }
        ]
      })
    }

    const pushToolResult = (toolUseId, contentBlocks = [], isError) => {
      if (!toolUseId) return

      const textParts = []
      for (const block of contentBlocks) {
        if (block && block.type === 'text') {
          textParts.push(block.text || '')
        }
      }

      const toolResult = {
        type: 'tool_result',
        tool_call_id: toolUseId,
        output: textParts.join('')
      }

      if (typeof isError === 'boolean') {
        toolResult.is_error = isError
      }

      inputMessages.push({
        role: 'tool',
        content: [toolResult]
      })
    }

    if (system) {
      if (typeof system === 'string') {
        pushText('system', system)
      } else if (Array.isArray(system)) {
        const sysText = system
          .filter((item) => item && item.type === 'text')
          .map((item) => item.text || '')
          .join('')
        pushText('system', sysText)
      }
    }

    if (Array.isArray(messages)) {
      for (const message of messages) {
        const role = message.role === 'assistant' ? 'assistant' : 'user'

        if (typeof message.content === 'string') {
          pushText(role, message.content)
          continue
        }

        if (!Array.isArray(message.content)) {
          pushText(role, '')
          continue
        }

        let buffer = ''
        const flushBuffer = () => {
          if (!buffer) return
          pushText(role, buffer)
          buffer = ''
        }

        for (const block of message.content) {
          if (!block || typeof block !== 'object') continue

          if (block.type === 'text') {
            buffer += block.text || ''
            continue
          }

          if (block.type === 'tool_use') {
            flushBuffer()
            pushToolCall(block.id, block.name, block.input)
            continue
          }

          if (block.type === 'tool_result') {
            flushBuffer()
            pushToolResult(block.tool_use_id, block.content, block.is_error)
            continue
          }
        }

        flushBuffer()
      }
    }

    if (inputMessages.length === 0) {
      throw new Error('Claude request does not contain any message content')
    }

    const responsesRequest = {
      model: openaiModel,
      input: inputMessages,
      stream: !!stream
    }

    if (Array.isArray(claudeRequest.tools) && claudeRequest.tools.length > 0) {
      responsesRequest.tools = claudeRequest.tools
    }

    if (claudeRequest.tool_choice) {
      responsesRequest.tool_choice = claudeRequest.tool_choice
    }

    return responsesRequest
  }
}

module.exports = ClaudeToOpenAIResponsesConverter



