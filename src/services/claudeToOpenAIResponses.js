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

    // 支持的内容类型：text, tool_use, tool_result, thinking (extended thinking), document
    const allowedTypes = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'document'])

    return messages.some((message) => {
      if (!Array.isArray(message?.content)) {
        return false
      }

      return message.content.some((block) => {
        if (!block || !block.type) {
          return false
        }
        return !allowedTypes.has(block.type)
      })
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

        // 支持 extended thinking 内容
        if (block.type === 'thinking') {
          const thinkingText = block.thinking || block.text || ''
          if (thinkingText) {
            textBuffer += `[Thinking: ${thinkingText}]\n`
          }
          continue
        }

        // 支持 document 内容
        if (block.type === 'document') {
          flushBuffer()
          this._pushDocumentContent(block, inputMessages)
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

    const sanitizedInput = this._sanitizeToolInput(block.input)

    let argumentsString = '{}'
    try {
      argumentsString = JSON.stringify(sanitizedInput)
    } catch (error) {
      logger.warn(`Failed to stringify tool input for ${block.name}: ${error.message}`)
    }

    const summary = `[tool_call name=${block.name} id=${block.id}] ${argumentsString}`
    this._pushTextMessage('assistant', summary, inputMessages)
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

    const payload = outputFragments.join('').trim()
    if (!payload) {
      return
    }

    const prefix = block.is_error ? '[tool_error]' : '[tool_result]'
    const summary = `${prefix} id=${block.tool_use_id} ${payload}`
    this._pushTextMessage('user', summary, inputMessages)
  }

  _pushDocumentContent(block, inputMessages) {
    // 处理 document 类型的内容块
    const title = block.title || 'Document'
    const content = block.content || block.document || block.text || ''

    if (!content) {
      return
    }

    // 将文档内容格式化为文本消息
    const documentText = `[${title}]\n${content}`
    this._pushTextMessage('user', documentText, inputMessages)
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

  _sanitizeToolInput(rawInput) {
    if (!rawInput || typeof rawInput !== 'object') {
      return {}
    }

    const inputCopy = { ...rawInput }

    if (Array.isArray(inputCopy.allowed_domains)) {
      const filtered = inputCopy.allowed_domains.filter(
        (item) => typeof item === 'string' && item.trim()
      )
      if (filtered.length > 0) {
        inputCopy.allowed_domains = filtered
      } else {
        delete inputCopy.allowed_domains
      }
    } else if (inputCopy.allowed_domains !== null && inputCopy.allowed_domains !== undefined) {
      delete inputCopy.allowed_domains
    }

    if (Array.isArray(inputCopy.blocked_domains)) {
      const filtered = inputCopy.blocked_domains.filter(
        (item) => typeof item === 'string' && item.trim()
      )
      if (filtered.length > 0) {
        inputCopy.blocked_domains = filtered
      } else {
        delete inputCopy.blocked_domains
      }
    } else if (inputCopy.blocked_domains !== null && inputCopy.blocked_domains !== undefined) {
      delete inputCopy.blocked_domains
    }

    if (inputCopy.allowed_domains && inputCopy.blocked_domains) {
      delete inputCopy.blocked_domains
    }

    return inputCopy
  }

  /**
   * 转换 Claude 非流式响应为 OpenAI Responses 格式
   * @param {Object} claudeResponse - Claude API 响应
   * @returns {Object} OpenAI Responses 格式响应
   */
  convertNonStream(claudeResponse) {
    const openaiResponse = {
      type: 'response',
      response: {
        id: claudeResponse.id || `resp_${Date.now()}`,
        model: this._mapClaudeModelToOpenAI(claudeResponse.model),
        created: Math.floor(Date.now() / 1000),
        output: []
      }
    }

    // 转换内容
    if (claudeResponse.content && Array.isArray(claudeResponse.content)) {
      for (const block of claudeResponse.content) {
        if (block.type === 'text') {
          openaiResponse.response.output.push({
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: block.text
              }
            ]
          })
        } else if (block.type === 'tool_use') {
          // 处理工具调用
          openaiResponse.response.output.push({
            type: 'function_call',
            name: block.name,
            call_id: block.id,
            arguments: JSON.stringify(block.input)
          })
        }
      }
    }

    // 转��� usage
    if (claudeResponse.usage) {
      openaiResponse.response.usage = {
        input_tokens: claudeResponse.usage.input_tokens || 0,
        output_tokens: claudeResponse.usage.output_tokens || 0,
        total_tokens:
          (claudeResponse.usage.input_tokens || 0) + (claudeResponse.usage.output_tokens || 0)
      }

      // 缓存 tokens 映射
      if (claudeResponse.usage.cache_read_input_tokens) {
        openaiResponse.response.usage.input_tokens_details = {
          cached_tokens: claudeResponse.usage.cache_read_input_tokens
        }
      }
    }

    // 转换停止原因
    if (claudeResponse.stop_reason) {
      openaiResponse.response.stop_reason = this._mapStopReason(claudeResponse.stop_reason)
    }

    return openaiResponse
  }

  /**
   * 转换 Claude SSE 流式 chunk 为 OpenAI Responses 格式
   * @param {String} claudeChunk - Claude SSE chunk
   * @returns {String|null} OpenAI Responses SSE chunk
   */
  convertStreamChunk(claudeChunk) {
    // 解析 Claude SSE 格式
    if (!claudeChunk.startsWith('data: ')) {
      // 可能是 event: 行，保留
      if (claudeChunk.startsWith('event:')) {
        return null // 暂不转发 event 行
      }
      return null
    }

    const jsonStr = claudeChunk.slice(6).trim()
    if (jsonStr === '[DONE]') {
      return 'data: [DONE]\n\n'
    }

    try {
      const claudeEvent = JSON.parse(jsonStr)

      // 根据 Claude 事件类型转换
      if (claudeEvent.type === 'message_start') {
        // 消息开始
        return `data: ${JSON.stringify({
          type: 'response.started',
          response: {
            id: claudeEvent.message?.id || `resp_${Date.now()}`,
            model: this._mapClaudeModelToOpenAI(claudeEvent.message?.model)
          }
        })}\n\n`
      } else if (claudeEvent.type === 'content_block_delta') {
        // 文本增量
        const { delta } = claudeEvent
        if (delta.type === 'text_delta') {
          return `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: {
              type: 'text',
              text: delta.text
            }
          })}\n\n`
        } else if (delta.type === 'input_json_delta') {
          // 工具调用参数增量
          return `data: ${JSON.stringify({
            type: 'response.function_call_arguments.delta',
            delta: delta.partial_json,
            index: claudeEvent.index
          })}\n\n`
        }
      } else if (claudeEvent.type === 'message_delta') {
        // 消息元数据更新（如停止原因）
        if (claudeEvent.delta?.stop_reason) {
          return `data: ${JSON.stringify({
            type: 'response.delta',
            delta: {
              stop_reason: this._mapStopReason(claudeEvent.delta.stop_reason)
            }
          })}\n\n`
        }
        if (claudeEvent.usage) {
          // Usage 数据 - 不直接转发，等待 message_stop
          return null
        }
      } else if (claudeEvent.type === 'message_stop') {
        // 消息结束 - 转发 usage
        const events = []
        if (claudeEvent.usage || claudeEvent['amazon-bedrock-invocationMetrics']) {
          const usage = claudeEvent.usage || {}
          events.push(
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                usage: {
                  input_tokens: usage.input_tokens || 0,
                  output_tokens: usage.output_tokens || 0,
                  total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                  input_tokens_details: usage.cache_read_input_tokens
                    ? { cached_tokens: usage.cache_read_input_tokens }
                    : undefined
                }
              }
            })}\n\n`
          )
        }
        events.push('data: [DONE]\n\n')
        return events.join('')
      } else if (claudeEvent.type === 'content_block_start') {
        // 内容块开始
        if (claudeEvent.content_block?.type === 'tool_use') {
          return `data: ${JSON.stringify({
            type: 'response.output_item.added',
            item: {
              type: 'function_call',
              name: claudeEvent.content_block.name,
              call_id: claudeEvent.content_block.id
            },
            index: claudeEvent.index
          })}\n\n`
        }
      } else if (claudeEvent.type === 'content_block_stop') {
        // 内容块结束
        return `data: ${JSON.stringify({
          type: 'response.output_item.done',
          index: claudeEvent.index
        })}\n\n`
      }
    } catch (e) {
      console.error('Failed to parse Claude SSE chunk:', e)
    }

    return null
  }

  /**
   * 流式响应结束时调用
   */
  finalizeStream() {
    return 'data: [DONE]\n\n'
  }

  /**
   * 映射 Claude 模型到 OpenAI 模型
   * @private
   */
  _mapClaudeModelToOpenAI(claudeModel) {
    const mapping = this.modelMapping || {}

    // 反向查找
    for (const [openaiModel, mappedClaude] of Object.entries(mapping)) {
      if (mappedClaude === claudeModel) {
        return openaiModel
      }
    }

    // 默认映射规则
    if (claudeModel && claudeModel.includes('sonnet')) {
      return 'gpt-5'
    }
    if (claudeModel && claudeModel.includes('opus')) {
      return 'gpt-5-plus'
    }
    if (claudeModel && claudeModel.includes('haiku')) {
      return 'gpt-5-mini'
    }

    return this.defaultModel || 'gpt-5'
  }

  /**
   * 映射 Claude 停止原因到 OpenAI 格式
   * @private
   */
  _mapStopReason(claudeStopReason) {
    const mapping = {
      end_turn: 'stop',
      max_tokens: 'length',
      stop_sequence: 'stop',
      tool_use: 'tool_calls'
    }

    return mapping[claudeStopReason] || 'stop'
  }
}

module.exports = ClaudeToOpenAIResponsesConverter
