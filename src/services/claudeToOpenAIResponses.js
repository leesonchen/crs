const logger = require('../utils/logger')

class ClaudeToOpenAIResponsesConverter {
  constructor(options = {}) {
    this.modelMapping = options.modelMapping || {}
    this.defaultModel = options.defaultModel || 'gpt-5'
    this.clientType = options.clientType || 'unknown'
    this._lastToolSummary = null
    this._resetSession()
  }

  _resetSession() {
    this._session = {
      initialized: false,
      responseId: null,
      mappedModel: null,
      created: null,
      outputCounter: 0,
      partCounter: 0,
      blocks: new Map(),
      pendingUsage: null,
      pendingStopReason: null
    }
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

        if (block.type === 'thinking') {
          const thinkingText = block.thinking || block.text || ''
          if (thinkingText) {
            textBuffer += `[Thinking: ${thinkingText}]
`
          }
          continue
        }

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
    const title = block.title || 'Document'
    const content = block.content || block.document || block.text || ''

    if (!content) {
      return
    }

    const documentText = `[${title}]
${content}`
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
          openaiResponse.response.output.push({
            type: 'function_call',
            name: block.name,
            call_id: block.id,
            arguments: JSON.stringify(block.input)
          })
        }
      }
    }

    if (claudeResponse.usage) {
      openaiResponse.response.usage = {
        input_tokens: claudeResponse.usage.input_tokens || 0,
        output_tokens: claudeResponse.usage.output_tokens || 0,
        total_tokens:
          (claudeResponse.usage.input_tokens || 0) + (claudeResponse.usage.output_tokens || 0)
      }

      if (claudeResponse.usage.cache_read_input_tokens) {
        openaiResponse.response.usage.input_tokens_details = {
          cached_tokens: claudeResponse.usage.cache_read_input_tokens
        }
      }
    }

    if (claudeResponse.stop_reason) {
      openaiResponse.response.stop_reason = this._mapStopReason(claudeResponse.stop_reason)
    }

    return openaiResponse
  }

  convertStreamChunk(claudeChunk) {
    if (!claudeChunk || !claudeChunk.trim()) {
      return null
    }

    const eventDataList = this._parseClaudeEvent(claudeChunk)
    if (!eventDataList || eventDataList.length === 0) {
      return null
    }

    return this._transformEvents(eventDataList)
  }

  _parseClaudeEvent(claudeChunk) {
    const lines = claudeChunk.trim().split('\n')
    let currentEventType = null
    let events = []

    logger.info(`🔧 [Claude→OpenAI] Parsing Claude chunk:`, {
      chunkLines: lines.length,
      chunkPreview: claudeChunk.slice(0, 200) + (claudeChunk.length > 200 ? '...' : ''),
      rawLines: lines.map((line, i) => `${i}: "${line}"`)
    })

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.startsWith('event:')) {
        currentEventType = line.slice(6).trim()
        logger.info(`🔧 [Claude→OpenAI] Found event type: "${currentEventType}"`)
      } else if (line.startsWith('data:')) {
        const jsonStr = line.slice(5).trim()
        if (jsonStr === '[DONE]') {
          events.push({ type: 'DONE' })
          logger.info(`🔧 [Claude→OpenAI] Found [DONE] marker`)
          continue
        }

        try {
          const jsonData = JSON.parse(jsonStr)
          const eventType = currentEventType || jsonData.type

          const eventData = {
            type: eventType,
            data: jsonData
          }

          events.push(eventData)

          logger.info(`🔧 [Claude→OpenAI] Parsed event:`, {
            eventType,
            hasData: !!jsonData,
            dataKeys: Object.keys(jsonData || {}),
            eventDataPreview: JSON.stringify(jsonData).slice(0, 100)
          })
        } catch (e) {
          logger.error(`🔧 [Claude→OpenAI] Failed to parse JSON data:`, {
            jsonStr: jsonStr.slice(0, 100),
            error: e.message,
            lineIndex: i,
            rawLine: line
          })
          continue
        }
      } else if (line.trim() === '') {
        // Empty line between events, skip
        continue
      } else {
        logger.warn(`🔧 [Claude→OpenAI] Unexpected line format:`, {
          lineIndex: i,
          lineContent: line,
          isEventLine: line.startsWith('event:'),
          isDataLine: line.startsWith('data:')
        })
      }
    }

    if (events.length === 0) {
      logger.warn(`🔧 [Claude→OpenAI] No events parsed from chunk`)
      return null
    }

    logger.info(`🔍 [Converter] Parsed Claude events:`, {
      eventCount: events.length,
      eventTypes: events.map(e => e.type),
      totalEventsInChunk: events.length,
      allEvents: events.map(e => ({
        type: e.type,
        dataPreview: JSON.stringify(e.data).slice(0, 50)
      }))
    })

    return events
  }

  _transformEvents(eventDataList) {
    if (!Array.isArray(eventDataList) || eventDataList.length === 0) {
      return null
    }

    const allResults = []

    for (const eventData of eventDataList) {
      const result = this._transformEvent(eventData)
      if (result !== null && result !== undefined) {
        allResults.push(result)
      }
    }

    if (allResults.length === 0) {
      return null
    }

    // Combine all results
    return allResults.join('')
  }

  _transformEvent(eventData) {
    const { type: eventType, data } = eventData

    switch (eventType) {
      case 'message_start':
        return this._handleMessageStart(data)
      case 'content_block_start':
        return this._handleContentBlockStart(data)
      case 'content_block_delta':
        return this._handleContentBlockDelta(data)
      case 'content_block_stop':
        return this._handleContentBlockStop(data)
      case 'message_delta':
        return this._handleMessageDelta(data)
      case 'message_stop':
        return this._handleMessageStop()
      case 'error':
        return this._handleError(data)
      case 'DONE':
        return 'data: [DONE]\n\n'
      case 'ping':
        return null
      default:
        logger.warn(`🔧 [Claude→OpenAI] Unhandled event type:`, {
          eventType,
          jsonDataKeys: Object.keys(data || {})
        })
        return null
    }
  }

  _handleMessageStart(data) {
    this._resetSession()

    const responseId = data?.message?.id || this._makeUid('resp')
    const mappedModel = this._mapClaudeModelToOpenAI(data?.message?.model)

    this._session.initialized = true
    this._session.responseId = responseId
    this._session.mappedModel = mappedModel
    this._session.created = Math.floor(Date.now() / 1000)

    const events = [
      {
        type: 'response.created',
        response: {
          id: responseId,
          created: this._session.created,
          model: mappedModel,
          object: 'response'
        }
      },
      {
        type: 'response.in_progress',
        response: {
          status: 'in_progress'
        }
      }
    ]

    logger.info(`🔧 [Claude→OpenAI] Generating response.created & response.in_progress events`, {
      responseId,
      model: mappedModel
    })

    return this._formatEvents(events)
  }

  _handleContentBlockStart(data) {
    if (!this._session.initialized) {
      logger.warn('🔧 [Claude→OpenAI] content_block_start received before message_start, ignoring')
      return null
    }

    const blockType = data?.content_block?.type
    const indexKey = String(data?.index ?? this._session.outputCounter)

    logger.info(`🔧 [Claude→OpenAI] Processing content_block_start`, {
      blockType,
      indexKey,
      dataIndex: data?.index,
      outputCounter: this._session.outputCounter,
      sessionInitialized: this._session.initialized
    })

    const existing = this._session.blocks.get(indexKey)
    let blockInfo = existing

    if (!existing) {
      const outputIndex = this._session.outputCounter++

      if (blockType === 'text' || blockType === 'thinking') {
        const itemId = this._makeUid('item')
        const partId = this._makeUid('part')
        blockInfo = {
          type: 'text',
          outputIndex,
          itemId,
          partId,
          textBuffer: ''
        }
        this._session.blocks.set(indexKey, blockInfo)

        const events = [
          {
            type: 'response.output_item.added',
            item: {
              type: 'message',
              role: 'assistant',
              content: []
            },
            item_id: itemId,
            output_index: outputIndex
          },
          {
            type: 'response.content_part.added',
            item_id: itemId,
            part: partId,
            content_index: 0,
            output_index: outputIndex
          }
        ]

        logger.info(`🔧 [Claude→OpenAI] Added message content block`, {
          outputIndex,
          itemId,
          partId
        })

        return this._formatEvents(events)
      }

      if (blockType === 'tool_use') {
        const itemId = this._makeUid('fn')
        blockInfo = {
          type: 'tool_use',
          outputIndex,
          itemId,
          callId: data.content_block.id,
          name: data.content_block.name,
          argumentsBuffer: ''
        }
        this._session.blocks.set(indexKey, blockInfo)

        const events = [
          {
            type: 'response.output_item.added',
            item: {
              type: 'function_call',
              name: data.content_block.name,
              call_id: data.content_block.id,
              arguments: ''
            },
            item_id: itemId,
            output_index: outputIndex
          }
        ]

        logger.info(`🔧 [Claude→OpenAI] Added function call block`, {
          outputIndex,
          itemId,
          name: data.content_block.name,
          callId: data.content_block.id
        })

        return this._formatEvents(events)
      }

      logger.warn(`🔧 [Claude→OpenAI] Unsupported content block type: ${blockType}`)
      return null
    }

    return null
  }

  _handleContentBlockDelta(data) {
    const indexKey = String(data?.index ?? 0)
    const block = this._session.blocks.get(indexKey)

    if (!block) {
      logger.warn(`🔧 [Claude→OpenAI] content_block_delta without start (index=${indexKey})`, {
        sessionInitialized: this._session.initialized,
        availableBlocks: Array.from(this._session.blocks.keys()),
        deltaData: {
          hasData: !!data,
          hasIndex: data?.index !== undefined,
          index: data?.index,
          deltaType: data?.delta?.type
        }
      })
      return null
    }

    if (block.type === 'text') {
      const delta = data?.delta
      if (!delta || delta.type !== 'text_delta' || !delta.text) {
        return null
      }

      block.textBuffer += delta.text

      const events = [
        {
          type: 'response.output_text.delta',
          delta: {
            type: 'text',
            text: delta.text
          },
          item_id: block.itemId,
          part: block.partId,
          content_index: 0,
          output_index: block.outputIndex
        }
      ]

      return this._formatEvents(events)
    }

    if (block.type === 'tool_use') {
      const delta = data?.delta
      if (!delta || delta.type !== 'input_json_delta') {
        return null
      }

      const partial = delta.partial_json || ''
      block.argumentsBuffer += partial

      const events = [
        {
          type: 'response.function_call_arguments.delta',
          delta: partial,
          index: parseInt(data.index),
          item_id: block.itemId,
          output_index: block.outputIndex
        }
      ]

      return this._formatEvents(events)
    }

    return null
  }

  _handleContentBlockStop(data) {
    const indexKey = String(data?.index ?? 0)
    const block = this._session.blocks.get(indexKey)

    if (!block) {
      return null
    }

    const events = []

    if (block.type === 'text') {
      events.push(
        {
          type: 'response.output_text.done',
          item_id: block.itemId,
          part: block.partId,
          content_index: 0,
          output_index: block.outputIndex,
          text: block.textBuffer
        },
        {
          type: 'response.content_part.done',
          item_id: block.itemId,
          part: block.partId,
          content_index: 0,
          output_index: block.outputIndex
        },
        {
          type: 'response.output_item.done',
          item_id: block.itemId,
          output_index: block.outputIndex
        }
      )
    } else if (block.type === 'tool_use') {
      events.push(
        {
          type: 'response.function_call_arguments.done',
          item_id: block.itemId,
          arguments: block.argumentsBuffer,
          output_index: block.outputIndex
        },
        {
          type: 'response.output_item.done',
          item_id: block.itemId,
          output_index: block.outputIndex
        }
      )
    }

    // 标记块为已完成，但不删除，保留��� message_stop 使用
    block.completed = true

    return this._formatEvents(events)
  }

  _handleMessageDelta(data) {
    if (data?.delta?.stop_reason) {
      this._session.pendingStopReason = this._mapStopReason(data.delta.stop_reason)
    }

    if (data?.usage) {
      this._session.pendingUsage = this._convertUsage(data.usage)

      // 🎯 关键修复：message_delta包含usage时，立即发送usage更新事件
      const events = [{
        type: 'response.delta',
        delta: {
          usage: this._session.pendingUsage
        }
      }]

      logger.info(`🔧 [Claude→OpenAI] Sending usage update from message_delta`, {
        inputTokens: this._session.pendingUsage.input_tokens,
        outputTokens: this._session.pendingUsage.output_tokens,
        totalTokens: this._session.pendingUsage.total_tokens
      })

      return this._formatEvents(events)
    }

    return null
  }

  _handleMessageStop(data) {
    if (!this._session.initialized) {
      return 'data: [DONE]\n\n'
    }

    // 如果 message_stop 事件包含 usage 数据，直接处理
    if (data?.usage) {
      this._session.pendingUsage = this._convertUsage(data.usage)
    }

    const stopReason = this._session.pendingStopReason || 'stop'
    const events = []

    events.push({
      type: 'response.delta',
      delta: {
        stop_reason: stopReason
      }
    })

    const completed = {
      type: 'response.completed',
      response: {
        id: this._session.responseId || this._makeUid('resp'),
        object: 'response',
        status: 'completed',
        created: this._session.created || Math.floor(Date.now() / 1000),
        model: this._session.mappedModel || this.defaultModel,
        stop_reason: stopReason,
        output: []
      }
    }

    // 构建输出数组，包含所有已完成的文本块
    for (const [key, block] of this._session.blocks.entries()) {
      if (block.completed && block.type === 'text' && block.textBuffer) {
        completed.response.output.push({
          type: 'message',
          id: block.itemId,
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: block.textBuffer
            }
          ]
        })
      }
    }

    if (this._session.pendingUsage) {
      completed.response.usage = this._session.pendingUsage
    }

    events.push(completed)

    logger.info('🔧 [Claude→OpenAI] Finalized response stream', {
      responseId: completed.response.id,
      stopReason,
      hasUsage: Boolean(this._session.pendingUsage)
    })

    this._resetSession()

    return this._formatEvents(events)
  }

  _handleError(data) {
    const errorType = data?.error?.type || 'unknown_error'
    const errorMessage = data?.error?.message || 'Unknown error occurred'
    const requestId = data?.request_id

    logger.error(`🔧 [Claude→OpenAI] Received error event:`, {
      errorType,
      errorMessage,
      requestId,
      fullData: data
    })

    // 创建错误响应事件
    const events = [
      {
        type: 'response.error',
        error: {
          type: errorType,
          message: errorMessage,
          code: errorType
        }
      }
    ]

    // 添加完成事件以正确结束流
    events.push('[DONE]')

    return this._formatEvents(events)
  }

  _convertUsage(usage) {
    const converted = {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
    }

    if (usage.cache_read_input_tokens) {
      converted.input_tokens_details = {
        cached_tokens: usage.cache_read_input_tokens
      }
    }

    if (usage.output_tokens_details) {
      converted.output_tokens_details = usage.output_tokens_details
    }

    return converted
  }

  _formatEvents(events) {
    if (!Array.isArray(events) || events.length === 0) {
      return null
    }

    const chunks = events
      .map((event) => {
        if (event === '[DONE]') {
          return 'data: [DONE]\n\n'
        }
        return `data: ${JSON.stringify(event)}\n\n`
      })
      .filter(Boolean)

    if (chunks.length === 0) {
      return null
    }

    return chunks.join('')
  }

  _makeUid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }

  _mapClaudeModelToOpenAI(claudeModel) {
    const mapping = this.modelMapping || {}

    for (const [openaiModel, mappedClaude] of Object.entries(mapping)) {
      if (mappedClaude === claudeModel) {
        return openaiModel
      }
    }

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

  _mapStopReason(claudeStopReason) {
    const mapping = {
      end_turn: 'stop',
      max_tokens: 'length',
      stop_sequence: 'stop',
      tool_use: 'tool_calls'
    }

    return mapping[claudeStopReason] || 'stop'
  }

  /**
   * 完成流式响应，返回最终的完成事件
   * @returns {string} 格式化的SSE事件字符串
   */
  finalizeStream() {
    logger.info('🔧 [Claude→OpenAI] Finalizing stream converter')

    if (!this._session.initialized) {
      logger.warn('🔧 [Claude→OpenAI] Stream finalize called but session not initialized')
      return 'data: [DONE]\n\n'
    }

    const stopReason = this._session.pendingStopReason || 'stop'
    const events = []

    // 添加结束事件
    events.push({
      type: 'response.delta',
      delta: {
        stop_reason: stopReason
      }
    })

    // 添加完成事件
    const completed = {
      type: 'response.completed',
      response: {
        id: this._session.responseId || this._makeUid('resp'),
        object: 'response',
        status: 'completed',
        created: this._session.created || Math.floor(Date.now() / 1000),
        model: this._session.mappedModel || this.defaultModel,
        stop_reason: stopReason,
        output: []
      }
    }

    // 构建输出数组，包含所有已完成的文本块
    for (const [key, block] of this._session.blocks.entries()) {
      if (block.completed && block.type === 'text' && block.textBuffer) {
        completed.response.output.push({
          type: 'message',
          id: block.itemId,
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: block.textBuffer
            }
          ]
        })
      }
    }

    if (this._session.pendingUsage) {
      completed.response.usage = this._session.pendingUsage
    }

    events.push(completed)
    events.push('[DONE]')

    logger.info('🔧 [Claude→OpenAI] Stream finalized with completion event', {
      responseId: completed.response.id,
      stopReason,
      hasUsage: Boolean(this._session.pendingUsage)
    })

    // 重置会话状态
    this._resetSession()

    // 格式化并返回事件
    return this._formatEvents(events) || 'data: [DONE]\n\n'
  }
}

module.exports = ClaudeToOpenAIResponsesConverter
