const logger = require('../utils/logger')
const OpenAIResponsesFlowSimulator = require('./openAIResponsesFlowSimulator')
const FlowTimingController = require('./flowTimingController')

class ClaudeToOpenAIResponsesConverter {
  constructor(options = {}) {
    this.modelMapping = options.modelMapping || {}
    this.defaultModel = options.defaultModel || 'gpt-5'
    this._lastToolSummary = null

    // 流程模拟器和时序控制器 - 简化架构：禁用流程模拟
    this.clientType = options.clientType || 'unknown'
    this.enableFlowSimulation = false // 强制禁用流程模拟器

    // 移除流程模拟器和时序控制器
    this.flowSimulator = null
    this.timingController = null

    logger.info(`📝 [Converter] Using simplified real-time conversion mode (flow simulation disabled)`)

    // 简化状态管理
    this._simulationState = {
      isActive: false,
      collectedResponse: null,
      eventsBuffer: [],
      completionCallback: null
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
   * 启动流程模拟模式
   * @param {Function} completionCallback - 完成回调函数
   */
  startFlowSimulation(completionCallback) {
    if (!this.enableFlowSimulation) {
      logger.warn(`⚠️ [Converter] Flow simulation not enabled, falling back to legacy mode`)
      return false
    }

    logger.info(`🎬 [Converter] Starting flow simulation mode`)
    this._simulationState = {
      isActive: true,
      collectedResponse: {
        id: `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        model: null,
        content: [],
        usage: null,
        stop_reason: null
      },
      eventsBuffer: [],
      completionCallback
    }

    return true
  }

  /**
   * 收集 Claude 响应数据（用于流程模拟）
   * @param {Object} claudeEventData - Claude 事件数据
   */
  collectClaudeResponse(claudeEventData) {
    if (!this._simulationState.isActive) {
      return
    }

    const { collectedResponse } = this._simulationState

    // 收集不同类型的事件数据
    switch (claudeEventData.type) {
      case 'message_start':
        if (claudeEventData.message?.id) {
          collectedResponse.id = claudeEventData.message.id
        }
        if (claudeEventData.message?.model) {
          collectedResponse.model = claudeEventData.message.model
        }
        break

      case 'content_block_start':
        logger.info(`📝 [Converter] Processing content_block_start:`, {
          hasContentBlock: !!claudeEventData.content_block,
          blockType: claudeEventData.content_block?.type,
          currentContentCount: collectedResponse.content.length
        })
        if (claudeEventData.content_block?.type === 'text') {
          collectedResponse.content.push({
            type: 'text',
            text: ''
          })
          logger.info(`✅ [Converter] Created new text content block, total: ${collectedResponse.content.length}`)
        } else {
          logger.warn(`⚠️ [Converter] Skipped non-text content block: ${claudeEventData.content_block?.type}`)
        }
        break

      case 'content_block_delta':
        if (claudeEventData.delta?.type === 'text_delta' && claudeEventData.delta?.text) {
          const lastContent = collectedResponse.content[collectedResponse.content.length - 1]
          if (lastContent && lastContent.type === 'text') {
            lastContent.text += claudeEventData.delta.text
          } else {
            collectedResponse.content.push({
              type: 'text',
              text: claudeEventData.delta.text
            })
          }
        }
        break

      case 'message_delta':
        if (claudeEventData.usage) {
          collectedResponse.usage = claudeEventData.usage
        }
        if (claudeEventData.delta?.stop_reason) {
          collectedResponse.stop_reason = claudeEventData.delta.stop_reason
        }
        break
    }

    const contentLength = collectedResponse.content.reduce((sum, c) => sum + (c.text?.length || 0), 0)

    logger.info(`📥 [Converter] Collected Claude response data`, {
      eventType: claudeEventData.type,
      hasContent: collectedResponse.content.length > 0,
      contentBlocks: collectedResponse.content.length,
      contentLength,
      contentPreview: contentLength > 0 ? collectedResponse.content[0]?.text?.substring(0, 50) + '...' : '',
      hasUsage: !!collectedResponse.usage,
      hasStopReason: !!collectedResponse.stop_reason,
      model: collectedResponse.model,
      id: collectedResponse.id
    })
  }

  /**
   * 完成数据收集并启动流程模拟
   * @param {Object} finalEventData - 最终事件数据
   * @returns {Promise<void>}
   */
  async completeCollectionAndSimulate(finalEventData) {
    if (!this._simulationState.isActive || !this._simulationState.completionCallback) {
      logger.warn(`⚠️ [Converter] No active simulation or completion callback`)
      return
    }

    // 收集最终数据
    this.collectClaudeResponse(finalEventData)

    const { collectedResponse, completionCallback } = this._simulationState

    logger.info(`🏁 [Converter] Completing collection and starting flow simulation`, {
      hasCollectedData: !!collectedResponse,
      contentLength: collectedResponse.content.reduce((sum, c) => sum + (c.text?.length || 0), 0),
      hasUsage: !!collectedResponse.usage
    })

    try {
      // 使用流程模拟器生成完整事件序列
      const events = this.flowSimulator.simulateCompleteFlow(collectedResponse)

      logger.info(`🎭 [Converter] Generated complete flow simulation`, {
        totalEvents: events.length,
        firstEventType: events[0]?.type,
        lastEventType: events[events.length - 1]?.type
      })

      // 使用时序控制器发送事件
      await this.timingController.sendEventsWithTiming(
        events,
        async (event) => {
          const sseData = `data: ${JSON.stringify(event)}\n\n`
          await completionCallback(sseData)
        },
        {
          enableProgressLog: true,
          progressInterval: 10,
          onProgress: (progress) => {
            logger.debug(`📊 [Converter] Flow simulation progress: ${progress.progress}%`)
          },
          onError: async (error, event, index) => {
            logger.error(`❌ [Converter] Flow simulation error at event ${index}:`, error)
            return true // 继续处理后续事件
          }
        }
      )

      // 发送完成信号
      await completionCallback('data: [DONE]\n\n')

      logger.info(`✅ [Converter] Flow simulation completed successfully`)

    } catch (error) {
      logger.error(`❌ [Converter] Flow simulation failed:`, error)

      // 降级到传统模式
      logger.warn(`🔄 [Converter] Falling back to legacy mode due to simulation failure`)
      this.enableFlowSimulation = false
    }

    // 重置状态
    this._simulationState.isActive = false
    this._simulationState.collectedResponse = null
    this._simulationState.eventsBuffer = []
    this._simulationState.completionCallback = null
  }

  /**
   * 转换 Claude SSE 流式 chunk 为 OpenAI Responses 格式 - 简化架构
   * @param {String} claudeChunk - Claude SSE chunk
   * @returns {String|null} OpenAI Responses SSE chunk
   */
  convertStreamChunk(claudeChunk) {
    // 简化架构：始终使用实时转换模式，移除复杂的流程模拟逻辑
    return this._convertLegacyMode(claudeChunk)
  }

  /**
   * 流程模拟模式：收集数据并准备模拟
   * @private
   */
  _collectAndForwardForSimulation(claudeChunk) {
    logger.debug(`📥 [Converter] Collecting data for flow simulation`, {
      chunkLength: claudeChunk.length,
      isActive: this._simulationState.isActive
    })

    // 解析事件数据
    const eventData = this._parseClaudeEvent(claudeChunk)
    if (!eventData) {
      return null
    }

    // 收集数据用于后续流程模拟
    this.collectClaudeResponse(eventData)

    // 在流程模拟期间，不直接发送转换的事件
    // 等待完整的响应收集完成后，统一生成模拟流程
    if (eventData.type === 'message_stop') {
      logger.info(`🏁 [Converter] Message stop detected, triggering flow simulation`)

      // 异步启动流程模拟
      setImmediate(() => {
        this.completeCollectionAndSimulate(eventData).catch(error => {
          logger.error(`❌ [Converter] Failed to complete collection and simulate:`, error)
        })
      })
    }

    return null // 不立即发送任何事件
  }

  /**
   * 解析 Claude 事件数据
   * @private
   */
  _parseClaudeEvent(claudeChunk) {
    const lines = claudeChunk.trim().split('\n')
    let currentEventType = null
    let events = []

    // 🎯 关键修复：正确处理包含多个事件的 chunk
    // 将 chunk 解析为多个独立的事件
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.startsWith('event:')) {
        currentEventType = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        const jsonStr = line.slice(5).trim()
        if (jsonStr === '[DONE]') {
          events.push({ type: 'DONE' })
          continue
        }

        try {
          const jsonData = JSON.parse(jsonStr)

          // 🎯 关键修复：使用当前的事件类型，而不是 JSON 中的 type 字段
          // 这解决了多个事件在同一个 chunk 中的解析问题
          const eventType = currentEventType || jsonData.type

          events.push({
            type: eventType,
            data: jsonData
          })

        } catch (e) {
          logger.error(`🔧 [Claude→OpenAI] Failed to parse JSON data:`, {
            jsonStr: jsonStr.slice(0, 100),
            error: e.message
          })
          // 继续处理其他事件，不要因为一个解析失败就返回 null
          continue
        }
      }
    }

    // 🎯 关键修复：返回最后一个有效的事件
    // 这符合流式处理的预期：每个 chunk 对应一个主要事件
    if (events.length === 0) {
      return null
    }

    const result = events[events.length - 1]

    logger.info(`🔍 [Converter] Parsed Claude event:`, {
      eventType: result.type,
      hasData: !!result.data,
      dataKeys: result.data ? Object.keys(result.data) : [],
      hasDelta: !!result.data?.delta,
      deltaType: result.data?.delta?.type,
      deltaText: result.data?.delta?.text ? result.data.delta.text.substring(0, 50) + '...' : '',
      totalEventsInChunk: events.length
    })

    return result
  }

  /**
   * 传统模式：直接转换事件
   * @private
   */
  _convertLegacyMode(claudeChunk) {
    logger.info(`🔧 [Claude→OpenAI] Converting stream chunk (legacy mode):`, {
      chunkLength: claudeChunk.length,
      chunkPreview: claudeChunk.slice(0, 100) + (claudeChunk.length > 100 ? '...' : ''),
      startsWithData: claudeChunk.startsWith('data: '),
      startsWithEvent: claudeChunk.startsWith('event:'),
      converterType: 'ClaudeToOpenAIResponsesConverter'
    })

    // 解析事件数据
    const eventData = this._parseClaudeEvent(claudeChunk)
    if (!eventData) {
      return null
    }

    const { type: finalEventType, data: jsonData } = eventData

    if (finalEventType === 'message_start') {
      // 消息开始 - 发送标准 OpenAI Response 事件序列
      const responseId = jsonData.message?.id || `resp_${Date.now()}`
      const mappedModel = this._mapClaudeModelToOpenAI(jsonData.message?.model)

      // 🎯 关键改进：生成完整的事件序列，包含 response.created 和 response.in_progress
      const events = []

      // 1. 发送 response.created 事件
      const responseCreatedEvent = {
        type: 'response.created',
        response: {
          id: responseId,
          created: Math.floor(Date.now() / 1000),
          model: mappedModel,
          object: 'response'
        }
      }
      events.push(responseCreatedEvent)

      // 2. 发送 response.in_progress 事件
      const responseInProgressEvent = {
        type: 'response.in_progress',
        response: {
          status: 'in_progress'
        }
      }
      events.push(responseInProgressEvent)

      logger.info(`🔧 [Claude→OpenAI] Generating complete event sequence for message_start:`, {
        responseId: responseCreatedEvent.response.id,
        model: responseCreatedEvent.response.model,
        created: responseCreatedEvent.response.created,
        eventCount: events.length,
        eventTypes: events.map(e => e.type)
      })

      // 🎯 关键修复：批量发送事件，确保客户端接收到完整序列
      return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    } else if (finalEventType === 'content_block_delta') {
      // 文本增量
      const { delta } = jsonData
      if (delta && delta.type === 'text_delta') {
        return `data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: {
            type: 'text',
            text: delta.text
          }
        })}\n\n`
      } else if (delta && delta.type === 'input_json_delta') {
        // 工具调用参数增量
        return `data: ${JSON.stringify({
          type: 'response.function_call_arguments.delta',
          delta: delta.partial_json,
          index: jsonData.index
        })}\n\n`
      }
    } else if (finalEventType === 'message_delta') {
      // 消息元数据更新（如停止原因）
      if (jsonData.delta?.stop_reason) {
        return `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            error: null
          }
        })}\n\n`
      }

      // 🎯 关键修复：智谱AI的 usage 数据在 message_delta 中
      if (jsonData.usage) {
        logger.info(`🔧 [Claude→OpenAI] Generating response.completed event from message_delta usage:`, {
          inputTokens: jsonData.usage.input_tokens || 0,
          outputTokens: jsonData.usage.output_tokens || 0,
          totalTokens: (jsonData.usage.input_tokens || 0) + (jsonData.usage.output_tokens || 0),
          cacheReadTokens: jsonData.usage.cache_read_input_tokens || 0
        })

        const usage = jsonData.usage
        const completionEvent = `data: ${JSON.stringify({
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
        })}\n\ndata: [DONE]\n\n`

        logger.info(`🔧 [Claude→OpenAI] Generated response.completed + [DONE] events from message_delta`)
        return completionEvent
      }
    } else if (finalEventType === 'message_stop') {
      // 消息结束 - 简化处理，因为 response.completed 已在 message_delta 中生成
      logger.info(`🔧 [Claude→OpenAI] Processing message_stop event (response.completed already sent in message_delta)`)

      // 只发送 [DONE] 信号，response.completed 已在 message_delta 中生成
      return 'data: [DONE]\n\n'
    } else if (finalEventType === 'content_block_start') {
      // 内容块开始 - 发送输出项目添加事件
      if (jsonData.content_block?.type === 'text') {
        // 🎯 关键改进：直接发送 output_item.added 事件，in_progress 已在 message_start 中发送
        const outputItemEvent = {
          type: 'response.output_item.added',
          item: {
            type: 'text',
            text: ''
          },
          index: jsonData.index || 0
        }

        logger.info(`🔧 [Claude→OpenAI] Generating response.output_item.added event for text content:`, {
          index: outputItemEvent.index,
          itemType: outputItemEvent.item.type
        })

        return `data: ${JSON.stringify(outputItemEvent)}\n\n`
      } else if (jsonData.content_block?.type === 'tool_use') {
        return `data: ${JSON.stringify({
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            name: jsonData.content_block.name,
            call_id: jsonData.content_block.id
          },
          index: jsonData.index
        })}\n\n`
      }
    } else if (finalEventType === 'content_block_stop') {
      // 内容块结束
      return `data: ${JSON.stringify({
        type: 'response.output_item.done',
        index: jsonData.index
      })}\n\n`
    } else if (finalEventType === 'ping') {
      // 忽略 ping 事件
      logger.debug(`🔧 [Claude→OpenAI] Skipping ping event`)
      return null
    }

    logger.warn(`🔧 [Claude→OpenAI] Unhandled event type:`, {
      eventType: finalEventType,
      jsonDataKeys: Object.keys(jsonData || {})
    })
    return null
  }

  /**
   * 流式响应结束时调用 - 简化架构
   */
  finalizeStream() {
    // 简化架构：直接返回完成信号，移除复杂的流程控制逻辑
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
