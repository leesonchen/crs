const logger = require('../utils/logger')

class ClaudeToOpenAIResponsesConverter {
  constructor(options = {}) {
    this.modelMapping = options.modelMapping || {}
    this.defaultModel = options.defaultModel || 'gpt-5'
    this._lastToolSummary = null
  }

  mapModel(claudeModel) {
    if (!claudeModel) {
      return this.defaultModel
    }

    const mapped = this.modelMapping[claudeModel]
    if (mapped) {
      return mapped
    }

    logger.warn(
      `Claude→OpenAI model mapping missing for '${claudeModel}', using default ${this.defaultModel}`
    )
    return this.defaultModel
  }

  convertRequest(claudeRequest) {
    if (!claudeRequest || typeof claudeRequest !== 'object') {
      throw new Error('Invalid Claude request body')
    }

    const { model, messages, system, stream } = claudeRequest

    if (this._containsNonTextContent(messages)) {
      const err = new Error('Non-text content is not supported in /claude/openai (phase 1)')
      err.status = 400
      throw err
    }

    const openaiModel = this.mapModel(model)
    const inputMessages = []

    logger.info('Claude→OpenAI bridge payload summary', {
      model,
      hasTools: Array.isArray(claudeRequest.tools) && claudeRequest.tools.length > 0,
      toolCount: Array.isArray(claudeRequest.tools) ? claudeRequest.tools.length : 0,
      hasToolChoice: Boolean(claudeRequest.tool_choice),
      messageCount: Array.isArray(messages) ? messages.length : 0,
      stream: Boolean(stream)
    })

    this._pushSystemMessage(system, inputMessages)
    this._pushConversationMessages(messages, inputMessages)

    if (inputMessages.length === 0) {
      throw new Error('Claude request does not contain any message content')
    }

    const responsesRequest = {
      model: openaiModel,
      input: inputMessages,
      stream: Boolean(stream)
    }

    this._lastToolSummary = null
    const convertedTools = this._convertTools(claudeRequest.tools)
    if (convertedTools.length > 0) {
      responsesRequest.tools = convertedTools
      if (this._lastToolSummary) {
        logger.info('Claude→OpenAI bridge tools forwarded', this._lastToolSummary)
      }
    } else if (this._lastToolSummary && this._lastToolSummary.requestedCount > 0) {
      logger.warn('Claude→OpenAI bridge dropped all tools', this._lastToolSummary)
    }

    const toolChoice = this._convertToolChoice(claudeRequest.tool_choice)
    if (toolChoice) {
      responsesRequest.tool_choice = toolChoice
    }

    if (typeof claudeRequest.parallel_tool_calls === 'boolean') {
      responsesRequest.parallel_tool_calls = claudeRequest.parallel_tool_calls
    }

    return responsesRequest
  }

  _containsNonTextContent(messages) {
    if (!Array.isArray(messages)) {
      return false
    }

    return messages.some((message) => {
      if (!Array.isArray(message?.content)) {
        return false
      }

      return message.content.some((block) => block && block.type && block.type !== 'text')
    })
  }

  _pushSystemMessage(system, inputMessages) {
    if (!system) {
      return
    }

    if (typeof system === 'string') {
      this._pushTextMessage('system', system, inputMessages)
      return
    }

    if (Array.isArray(system)) {
      const systemText = system
        .filter((item) => item && item.type === 'text')
        .map((item) => item.text || '')
        .join('')

      this._pushTextMessage('system', systemText, inputMessages)
    }
  }

  _pushConversationMessages(messages, inputMessages) {
    if (!Array.isArray(messages)) {
      return
    }

    for (const message of messages) {
      const role = message.role === 'assistant' ? 'assistant' : 'user'

      if (typeof message.content === 'string') {
        this._pushTextMessage(role, message.content, inputMessages)
        continue
      }

      if (!Array.isArray(message.content)) {
        this._pushTextMessage(role, '', inputMessages)
        continue
      }

      let textBuffer = ''

      const flushBuffer = () => {
        if (!textBuffer) {
          return
        }
        this._pushTextMessage(role, textBuffer, inputMessages)
        textBuffer = ''
      }

      for (const block of message.content) {
        if (!block || typeof block !== 'object') {
          continue
        }

        if (block.type === 'text') {
          textBuffer += block.text || ''
          continue
        }

        if (block.type === 'tool_use') {
          flushBuffer()
          this._pushToolCall(block, inputMessages)
          continue
        }

        if (block.type === 'tool_result') {
          flushBuffer()
          this._pushToolResult(block, inputMessages)
          continue
        }

        const err = new Error(
          `Content block type '${block.type}' is not supported in Claude→OpenAI bridge`
        )
        err.status = 400
        throw err
      }

      flushBuffer()
    }
  }

  _pushTextMessage(role, text, inputMessages) {
    if (!text) {
      return
    }

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

  _pushToolCall(block, inputMessages) {
    if (!block.id || !block.name) {
      return
    }

    let argumentsString = '{}'
    try {
      argumentsString = JSON.stringify(block.input ?? {})
    } catch (error) {
      logger.warn(`Failed to stringify tool input for ${block.name}: ${error.message}`)
    }

    inputMessages.push({
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          id: block.id,
          name: block.name,
          arguments: argumentsString
        }
      ]
    })
  }

  _pushToolResult(block, inputMessages) {
    if (!block.tool_use_id) {
      return
    }

    const outputFragments = []

    const blocks = Array.isArray(block.content) ? block.content : [block.content]
    for (const item of blocks) {
      if (!item || typeof item !== 'object') {
        continue
      }

      if (item.type === 'text') {
        outputFragments.push(item.text || '')
        continue
      }

      if (item.type === 'json' && item.json !== undefined) {
        outputFragments.push(JSON.stringify(item.json))
      }
    }

    const toolResult = {
      type: 'tool_result',
      tool_call_id: block.tool_use_id,
      output: outputFragments.join('')
    }

    if (typeof block.is_error === 'boolean') {
      toolResult.is_error = block.is_error
    }

    inputMessages.push({
      role: 'tool',
      content: [toolResult]
    })
  }

  _convertTools(tools) {
    if (!Array.isArray(tools)) {
      return []
    }

    const summary = {
      requestedCount: tools.length,
      forwardedCount: 0,
      forwardedNames: [],
      skippedInvalid: 0,
      forwardedWithoutSchema: []
    }

    const converted = []

    tools.forEach((tool, index) => {
      if (!tool || typeof tool !== 'object') {
        summary.skippedInvalid += 1
        return
      }

      if (!tool.name) {
        summary.skippedInvalid += 1
        return
      }

      const schema = this._extractToolSchema(tool)
      if (!schema) {
        summary.forwardedWithoutSchema.push(tool.name)
      }

      const convertedTool = {
        type: 'function',
        name: tool.name,
        description: tool.description || ''
      }

      if (schema) {
        convertedTool.parameters = schema
      }

      if (typeof tool.strict === 'boolean') {
        convertedTool.strict = tool.strict
      }

      if (tool.examples) {
        convertedTool.examples = tool.examples
      }

      converted.push(convertedTool)

      summary.forwardedCount += 1
      summary.forwardedNames.push({
        index,
        name: tool.name,
        schemaKeys: schema ? Object.keys(schema) : []
      })
    })

    this._lastToolSummary = summary
    return converted
  }

  _extractToolSchema(tool) {
    if (!tool || typeof tool !== 'object') {
      return null
    }

    if (tool.input_schema && typeof tool.input_schema === 'object') {
      return tool.input_schema
    }

    if (tool.parameters && typeof tool.parameters === 'object') {
      return tool.parameters
    }

    return null
  }

  _convertToolChoice(choice) {
    if (!choice) {
      return null
    }

    if (typeof choice === 'string') {
      if (choice === 'auto') {
        return 'auto'
      }

      if (choice === 'none') {
        return { type: 'none' }
      }

      return {
        type: 'tool',
        name: choice
      }
    }

    if (typeof choice !== 'object') {
      return null
    }

    if (choice.type === 'tool' && choice.name) {
      return { type: 'tool', name: choice.name }
    }

    if (choice.type === 'auto') {
      return 'auto'
    }

    if (choice.type === 'none') {
      return { type: 'none' }
    }

    return null
  }
}

module.exports = ClaudeToOpenAIResponsesConverter
