const logger = require('../utils/logger')

class OpenAIResponsesToClaudeConverter {
  constructor(options = {}) {
    this._resetStreamState()
    this.clientType = options.clientType || 'unknown'
    this.targetFormat = options.targetFormat || 'claude'
    logger.info('🔧 [Bridge] Initialized converter:', {
      clientType: this.clientType,
      targetFormat: this.targetFormat,
      isCodexCLI: this._isCodexClient()
    })
  }

  /**
   * 将 OpenAI Responses 请求格式转换为 Claude 格式
   * @param {Object} openaiRequest - OpenAI Responses 格式的请求
   * @returns {Object} Claude 格式的请求
   */
  convertRequest(openaiRequest) {
    logger.info('🔄 [Bridge] Starting OpenAI Responses → Claude request conversion:', {
      originalKeys: Object.keys(openaiRequest),
      hasInput: !!(openaiRequest.input && Array.isArray(openaiRequest.input)),
      hasMessages: !!(openaiRequest.messages && Array.isArray(openaiRequest.messages)),
      hasInstructions: !!openaiRequest.instructions,
      originalModel: openaiRequest.model,
      stream: Boolean(openaiRequest.stream)
    })

    const claudeRequest = {
      model: openaiRequest.model,
      max_tokens: openaiRequest.max_tokens || openaiRequest.max_output_tokens || 4096,
      stream: Boolean(openaiRequest.stream)
    }

    // 记录字段映射过程
    logger.debug('🔧 [Bridge] Field mapping:', {
      model: `${openaiRequest.model} → ${claudeRequest.model}`,
      max_tokens: `${openaiRequest.max_tokens}/${openaiRequest.max_output_tokens} → ${claudeRequest.max_tokens}`,
      stream: `${openaiRequest.stream} → ${claudeRequest.stream}`
    })

    // 处理 instructions → system
    if (openaiRequest.instructions) {
      claudeRequest.system = openaiRequest.instructions
      logger.info('📝 [Bridge] Mapped instructions → system:', {
        instructionsLength: openaiRequest.instructions.length,
        instructionsPreview: openaiRequest.instructions.substring(0, 100)
      })
    }

    // 处理 input → messages
    if (openaiRequest.input && Array.isArray(openaiRequest.input)) {
      logger.info('🔍 [Bridge] Processing OpenAI Responses input array:', {
        inputLength: openaiRequest.input.length,
        firstItemKeys: openaiRequest.input.length > 0 ? Object.keys(openaiRequest.input[0]) : [],
        firstItemPreview:
          openaiRequest.input.length > 0
            ? {
                hasType: !!openaiRequest.input[0].type,
                hasRole: !!openaiRequest.input[0].role,
                hasContent: openaiRequest.input[0].content !== undefined
              }
            : {}
      })
      claudeRequest.messages = this._postProcessMessages(
        this._convertInputToMessages(openaiRequest.input)
      )
    } else if (openaiRequest.messages && Array.isArray(openaiRequest.messages)) {
      // 兼容传统格式
      logger.info('🔧 [Bridge] Using legacy messages format compatibility mode:', {
        messageCount: openaiRequest.messages.length
      })
      claudeRequest.messages = this._postProcessMessages(openaiRequest.messages)
    } else {
      logger.warn('⚠️ [Bridge] No input or messages array found, creating empty messages array')
      claudeRequest.messages = []
    }

    // 处理其他可选参数
    const optionalParams = ['temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty']
    for (const param of optionalParams) {
      if (openaiRequest[param] !== undefined) {
        claudeRequest[param] = openaiRequest[param]
        logger.debug(`🔧 [Bridge] Mapped optional parameter: ${param}`, {
          value: openaiRequest[param]
        })
      }
    }

    logger.info('📝 [Bridge] OpenAI Responses → Claude conversion complete:', {
      originalModel: openaiRequest.model,
      convertedModel: claudeRequest.model,
      hasSystem: !!claudeRequest.system,
      originalMessageCount: (openaiRequest.input || openaiRequest.messages || []).length,
      convertedMessageCount: claudeRequest.messages.length,
      stream: claudeRequest.stream,
      convertedKeys: Object.keys(claudeRequest),
      messagesPreview: claudeRequest.messages.slice(0, 2).map((m) => ({
        role: m.role,
        contentType: Array.isArray(m.content) ? 'array' : typeof m.content,
        contentLength: this._estimateContentLength(m.content),
        contentPreview: this._buildContentPreview(m.content)
      }))
    })

    return claudeRequest
  }

  /**
   * 转换 OpenAI Responses 的 input 数组为 Claude 的 messages
   * @private
   */
  _convertInputToMessages(input) {
    const messages = []

    input.forEach((item, index) => {
      let isMessageItem = false
      let formatType = 'unknown'

      if (item && item.type === 'message') {
        isMessageItem = true
        formatType = 'standard'
      } else if (item && item.role && item.content !== undefined) {
        isMessageItem = true
        formatType = 'compat'
        logger.info('🔧 [Bridge] Converting item without type field to message format:', {
          index,
          role: item.role,
          contentType: typeof item.content,
          hasContent: item.content !== undefined
        })
      }

      if (!isMessageItem) {
        logger.warn('⚠️ [Bridge] Skipping non-message item in input array:', {
          index,
          itemType: item?.type,
          hasRole: !!item?.role,
          hasContent: item?.content !== undefined,
          allKeys: item ? Object.keys(item) : []
        })
        return
      }

      const message = {
        role: item.role || 'user',
        content: this._normalizeContentBlocks(item.content)
      }

      if (message.content.length === 0) {
        logger.warn('⚠️ [Bridge] Content is empty after processing, inserting placeholder', {
          index,
          formatType,
          role: message.role,
          originalType: typeof item.content
        })
        message.content = [
          {
            type: 'text',
            text: ''
          }
        ]
      }

      messages.push(message)

      logger.info('✅ [Bridge] Successfully converted message item:', {
        index,
        formatType,
        role: message.role,
        contentType: Array.isArray(message.content) ? 'array' : typeof message.content,
        contentLength: this._estimateContentLength(message.content)
      })
    })

    logger.info('📊 [Bridge] Input to messages conversion complete:', {
      inputItemsCount: input.length,
      outputMessagesCount: messages.length,
      skippedItemsCount: input.length - messages.length
    })

    return messages
  }

  _postProcessMessages(messages) {
    if (!Array.isArray(messages)) {
      return []
    }

    const normalizedMessages = messages
      .map((msg, index) => {
        if (!msg || typeof msg !== 'object') {
          logger.warn('⚠️ [Bridge] Encountered invalid message during post-processing', {
            index,
            type: typeof msg
          })
          return null
        }

        const role = msg.role || 'user'
        const content = this._normalizeContentBlocks(msg.content)

        if (content.length === 0) {
          return null
        }

        return {
          role,
          content
        }
      })
      .filter(Boolean)

    if (normalizedMessages.length === 0) {
      return []
    }

    const mergedMessages = this._mergeConsecutiveUserMessages(normalizedMessages)
    this._ensureExecutionDirective(mergedMessages)

    const lastUser = [...mergedMessages]
      .reverse()
      .find((msg) => msg.role === 'user')

    if (lastUser) {
      const aggregatedText = this._extractAllText(lastUser.content)
      logger.info('🔍 [Bridge] Compiled user message preview', {
        totalLength: aggregatedText.length,
        head: aggregatedText.substring(0, 160),
        tail: aggregatedText.slice(-160)
      })
    }

    return mergedMessages
  }

  _normalizeContentBlocks(content) {
    const blocks = []

    if (Array.isArray(content)) {
      content.forEach((block, index) => {
        const normalized = this._normalizeContentBlock(block, index)
        if (Array.isArray(normalized)) {
          blocks.push(...normalized)
        } else if (normalized) {
          blocks.push(normalized)
        }
      })
      return this._mergeAdjacentTextBlocks(blocks)
    }

    if (typeof content === 'string') {
      return [{ type: 'text', text: content }]
    }

    if (content && typeof content === 'object') {
      const extracted = this._extractTextFromObject(content)
      if (extracted) {
        return [{ type: 'text', text: extracted }]
      }
    }

    if (content !== undefined && content !== null) {
      return [{ type: 'text', text: String(content) }]
    }

    return []
  }

  _normalizeContentBlock(block, index) {
    if (!block || typeof block !== 'object') {
      if (block !== undefined && block !== null) {
        return { type: 'text', text: String(block) }
      }
      return null
    }

    const { type } = block

    if (!type || type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = this._extractTextFromObject(block)
      if (text) {
        return { type: 'text', text }
      }
      return null
    }

    if (type === 'image') {
      return block
    }

    const textFallback = this._extractTextFromObject(block)
    if (textFallback) {
      logger.debug('🔧 [Bridge] Normalized non-text block via fallback text extraction', {
        blockIndex: index,
        normalizedType: type
      })
      return { type: 'text', text: textFallback }
    }

    logger.warn('⚠️ [Bridge] Dropping unsupported content block', {
      blockIndex: index,
      blockType: type,
      availableKeys: Object.keys(block)
    })
    return null
  }

  _extractTextFromObject(content) {
    if (!content || typeof content !== 'object') {
      return ''
    }

    const candidateKeys = [
      'text',
      'content',
      'message',
      'input',
      'prompt',
      'value',
      'string'
    ]

    for (const key of candidateKeys) {
      if (typeof content[key] === 'string' && content[key].trim()) {
        return content[key]
      }
    }

    if (Array.isArray(content.parts)) {
      return content.parts
        .map((part) => {
          if (typeof part === 'string') {
            return part
          }
          if (part && typeof part.text === 'string') {
            return part.text
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }

    return ''
  }

  _mergeConsecutiveUserMessages(messages) {
    const merged = []

    for (const message of messages) {
      const last = merged[merged.length - 1]

      if (last && last.role === 'user' && message.role === 'user') {
        last.content = this._mergeAdjacentTextBlocks([...last.content, ...message.content])
        continue
      }

      merged.push({
        role: message.role,
        content: this._mergeAdjacentTextBlocks(message.content)
      })
    }

    return merged
  }

  _mergeAdjacentTextBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return []
    }

    const merged = []

    for (const block of blocks) {
      if (!block) {
        continue
      }

      if (block.type === 'text') {
        if (merged.length > 0 && merged[merged.length - 1].type === 'text') {
          merged[merged.length - 1] = {
            type: 'text',
            text: this._mergeTextContent(merged[merged.length - 1].text, block.text)
          }
        } else {
          merged.push({
            type: 'text',
            text: block.text || ''
          })
        }
      } else {
        merged.push(block)
      }
    }

    return merged
  }

  _mergeTextContent(left = '', right = '') {
    if (!left) {
      return right || ''
    }
    if (!right) {
      return left
    }

    const needsSpacing = !/\s$/.test(left) && !/^\s/.test(right)

    return needsSpacing ? `${left}\n\n${right}` : `${left}${right}`
  }

  _ensureExecutionDirective(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return
    }

    const directive = [
      '请直接根据以上上下文完成用户任务，并一次性输出最终结果。',
      '禁止寒暄、问候、再次确认问题或询问下一步，直接给出最终答案。',
      '回答中不得包含疑问句或“如何协助”等表述，也不得请求更多指示。',
      'If the user asked for analysis or a document, produce it immediately without introductory phrases.'
    ].join('\n')

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role !== 'user') {
        continue
      }

      const existingText = this._extractAllText(message.content)
      if (existingText.includes(directive)) {
        return
      }

      this._appendTextBlock(message, directive)
      return
    }
  }

  _appendTextBlock(message, text) {
    if (!text || !message) {
      return
    }

    if (!Array.isArray(message.content)) {
      message.content = this._normalizeContentBlocks(message.content)
    }

    if (message.content.length === 0) {
      message.content.push({ type: 'text', text })
      return
    }

    const lastBlock = message.content[message.content.length - 1]

    if (lastBlock.type === 'text') {
      lastBlock.text = this._mergeTextContent(lastBlock.text, text)
    } else {
      message.content.push({ type: 'text', text })
    }
  }

  _extractAllText(content) {
    if (typeof content === 'string') {
      return content
    }

    if (!Array.isArray(content)) {
      return ''
    }

    return content
      .map((block) => {
        if (block && block.type === 'text') {
          return block.text || ''
        }
        return ''
      })
      .join('\n')
  }

  _estimateContentLength(content) {
    if (typeof content === 'string') {
      return content.length
    }

    if (!Array.isArray(content)) {
      return 0
    }

    return content.reduce((sum, block) => {
      if (block && block.type === 'text') {
        return sum + (block.text ? block.text.length : 0)
      }
      return sum + 1
    }, 0)
  }

  _buildContentPreview(content) {
    if (typeof content === 'string') {
      return content.substring(0, 50)
    }

    if (!Array.isArray(content) || content.length === 0) {
      return '[]'
    }

    const first = content[0]
    if (first.type === 'text') {
      return first.text ? first.text.substring(0, 50) : ''
    }

    return `[${content.length} blocks]`
  }

  convertNonStream(responseData) {
    logger.info('🔄 [Bridge] Starting non-stream response conversion (OpenAI Responses → Claude):', {
      responseDataKeys: Object.keys(responseData || {}),
      hasResponse: !!(responseData?.response),
      responseKeys: responseData?.response ? Object.keys(responseData.response) : [],
      originalType: responseData?.type || 'unknown'
    })

    const resp = responseData?.response || responseData || {}
    this.finalResponse = resp
    const usage = this._extractUsage(responseData)
    const stopReason = this._mapStopReason(
      resp?.stop_reason || resp?.status || responseData?.stop_reason
    )

    logger.debug('🔧 [Bridge] Extracted response metadata:', {
      originalStopReason: resp?.stop_reason || resp?.status || responseData?.stop_reason,
      mappedStopReason: stopReason,
      hasUsage: !!(usage && (usage.input_tokens > 0 || usage.output_tokens > 0)),
      usage,
      model: resp?.model || 'unknown'
    })

    const content = this._convertOutputContent(resp)
    if (content.length === 0) {
      logger.warn('⚠️ [Bridge] No content found in response, attempting fallback text extraction')
      const fallbackText = this._extractText(resp)
      if (fallbackText) {
        content.push({ type: 'text', text: fallbackText })
        logger.info('✅ [Bridge] Successfully extracted fallback text:', {
          textLength: fallbackText.length,
          textPreview: fallbackText.substring(0, 100)
        })
      } else {
        logger.error('❌ [Bridge] Failed to extract any content from response')
      }
    }

    const claudeResponse = {
      id: resp?.id || this._generateId('msg'),
      type: 'message',
      role: 'assistant',
      model: resp?.model || 'unknown',
      stop_reason: stopReason,
      content,
      usage
    }

    logger.info('📝 [Bridge] Non-stream conversion complete:', {
      claudeId: claudeResponse.id,
      model: claudeResponse.model,
      stopReason: claudeResponse.stop_reason,
      contentBlockCount: claudeResponse.content.length,
      totalContentLength: claudeResponse.content.reduce((sum, block) =>
        sum + (block.text ? block.text.length : 0), 0),
      hasUsage: !!(claudeResponse.usage && (claudeResponse.usage.input_tokens > 0 || claudeResponse.usage.output_tokens > 0)),
      usage: claudeResponse.usage
    })

    return claudeResponse
  }

  convertStreamChunk(rawChunk) {
    if (!rawChunk || typeof rawChunk !== 'string') {
      logger.warn('⚠️ [Bridge] Invalid stream chunk received:', {
        chunkType: typeof rawChunk,
        chunkValue: rawChunk
      })
      return ''
    }

    this.streamBuffer += rawChunk.replace(/\r\n/g, '\n')

    logger.debug('🔄 [Bridge] Received stream chunk:', {
      chunkLength: rawChunk.length,
      chunkPreview: rawChunk.length > 200 ? `${rawChunk.substring(0, 200)}...` : rawChunk,
      bufferLength: this.streamBuffer.length,
      hasCompleteEvents: rawChunk.includes('\n\n'),
      streamState: {
        messageStarted: this.messageStarted,
        contentBlockStarted: this.contentBlockStarted,
        streamFinished: this.streamFinished
      }
    })

    return this._drainBuffer(false)
  }

  finalizeStream() {
    return this._drainBuffer(true)
  }

  _drainBuffer(force) {
    const output = []

    let drained = false

    while (!drained) {
      const separatorIndex = this.streamBuffer.indexOf('\n\n')
      if (separatorIndex === -1) {
        if (force && this.streamBuffer.trim()) {
          output.push(...this._processBlock(this.streamBuffer))
          this.streamBuffer = ''
        }
        drained = true
        continue
      }

      const block = this.streamBuffer.slice(0, separatorIndex)
      this.streamBuffer = this.streamBuffer.slice(separatorIndex + 2)
      output.push(...this._processBlock(block))
    }

    if (force && !this.streamFinished && this.messageStarted) {
      output.push(...this._emitCompletion(null))
    }

    this._logEmittedEvents(output)

    return output.join('')
  }

  _processBlock(block) {
    const events = []
    const lines = block.split('\n')

    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        continue
      }

      const payload = line.slice(6).trim()
      if (!payload) {
        continue
      }

      if (payload === '[DONE]') {
        events.push(...this._emitCompletion(null))
        continue
      }

      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch (error) {
        this.streamBuffer = `${block}\n\n${this.streamBuffer}`
        break
      }

      events.push(...this._handleEvent(parsed))
    }

    return events
  }

  _handleEvent(event) {
    if (!event || this.streamFinished) {
      if (this.streamFinished) {
        logger.debug('🚫 [Bridge] Ignoring event - stream already finished:', {
          eventType: event?.type,
          streamFinished: this.streamFinished
        })
      }
      return []
    }

    // 记录所有接收到的事件（移除5事件限制）
    logger.info('📥 [Bridge] Received SSE event:', {
      eventNumber: this.debugEventCount + 1,
      type: event.type,
      hasResponse: Boolean(event.response),
      hasMessage: Boolean(event.message),
      hasDelta: Boolean(event.delta),
      hasItem: Boolean(event.item),
      hasContent: Boolean(event.content),
      hasUsage: Boolean(event.usage),
      keys: Object.keys(event || {}),
      streamState: {
        messageStarted: this.messageStarted,
        contentBlockStarted: this.contentBlockStarted,
        streamFinished: this.streamFinished
      },
      // 记录关键内容预览
      contentPreview: event.content ?
        (event.content.text ? event.content.text.substring(0, 50) + '...' : 'present') :
        'none',
      deltaPreview: event.delta ?
        (typeof event.delta === 'string' ? event.delta.substring(0, 50) + '...' :
         event.delta.text ? event.delta.text.substring(0, 50) + '...' :
         JSON.stringify(event.delta).substring(0, 50) + '...') :
        'none'
    })
    this.debugEventCount += 1

    // 处理智谱AI/标准Claude格式事件
    switch (event.type) {
      // 智谱AI/Claude格式事件
      case 'message_start':
        if (event.message) {
          this.messageId = event.message.id
          return this._emitMessageStart()
        }
        return this._emitMessageStart()

      case 'content_block':
        // 智谱AI的content_block事件需要转换为start+delta
        if (event.content && event.content.type === 'text' && event.content.text) {
          const events = []
          events.push(...this._emitMessageStart())
          events.push(...this._ensureTextBlock())
          events.push(
            this._sse({
              type: 'content_block_delta',
              index: event.index || 0,
              delta: {
                type: 'text_delta',
                text: event.content.text
              }
            })
          )
          return events
        }
        return this._ensureTextBlock()

      case 'content_block_stop':
        return [
          this._sse({
            type: 'content_block_stop',
            index: event.index || 0
          })
        ]

      case 'message_delta':
        const events = []

        // 累积使用数据（智谱AI格式的usage通常在message_delta事件中）
        if (event.usage) {
          logger.info('📊 [Bridge] Accumulating usage from message_delta:', {
            usage: event.usage,
            currentAccumulated: this.accumulatedUsage
          })

          if (event.usage.input_tokens) {
            this.accumulatedUsage.input_tokens += event.usage.input_tokens
          }
          if (event.usage.output_tokens) {
            this.accumulatedUsage.output_tokens += event.usage.output_tokens
          }
        }

        if (event.delta && event.delta.stop_reason) {
          events.push(
            this._sse({
              type: 'message_delta',
              delta: {
                stop_reason: this._mapStopReason(event.delta.stop_reason)
              },
              usage: event.usage || {}
            })
          )
        }
        return events

      case 'message_stop':
        logger.info('📥 [Bridge] Processing message_stop event for completion:', {
          isCodexClient: this._isCodexClient(),
          clientType: this.clientType,
          eventType: 'message_stop',
          streamState: {
            messageStarted: this.messageStarted,
            contentBlockStarted: this.contentBlockStarted,
            streamFinished: this.streamFinished
          }
        })

        // 对于智谱AI格式的message_stop事件，如果是Codex CLI，也需要发送双完成事件
        // 这里使用��积的usage数据（如果有）
        const accumulatedUsage = this._extractUsage({ usage: null })
        const completionPayload = {
          id: this.messageId,
          usage: accumulatedUsage,
          stop_reason: 'end_turn'
        }

        return this._emitCompletion(completionPayload)

      // OpenAI Responses格式事件
      case 'response.started':
        return this._emitMessageStart()
      case 'response.output_text.delta':
        if (typeof event.delta === 'string' && event.delta) {
          return this._emitTextDelta(event.delta)
        }
        if (event.delta && typeof event.delta.text === 'string') {
          return this._emitTextDelta(event.delta.text)
        }
        return []
      case 'response.output_text.delta.appended':
        if (typeof event.delta === 'string' && event.delta) {
          return this._emitTextDelta(event.delta)
        }
        return []
      case 'response.output_text.done':
        if (Array.isArray(event.output)) {
          const text = this._collectOutputText(event.output)
          if (text) {
            return this._emitTextDelta(text)
          }
        }
        return []
      case 'response.output_item.added':
        return this._handleOutputItemAdded(event)
      case 'response.function_call_arguments.delta':
        return this._handleFunctionCallArgumentsDelta(event)
      case 'response.function_call_arguments.done':
        return this._handleFunctionCallArgumentsDone(event)
      case 'response.output_item.done':
        return this._handleOutputItemDone(event)
      case 'response.completed':
        return this._emitCompletion(event.response)
      case 'response.error':
        return this._emitError(event.error || event)
      case 'response.delta':
        return this._handleResponseDelta(event)
      default:
        // 未知事件类型，记录日志但不抛出错误
        if (this.debugEventCount < 5) {
          logger.warn('⚠️ 未知的SSE事件类型:', {
            type: event.type,
            data: event
          })
        }
        return []
    }
  }

  _handleResponseDelta(event) {
    if (!event?.delta || this.streamFinished) {
      return []
    }

    const fragments = []
    if (typeof event.delta === 'string') {
      fragments.push(event.delta)
    } else if (Array.isArray(event.delta?.output_text)) {
      for (const piece of event.delta.output_text) {
        if (typeof piece === 'string') {
          fragments.push(piece)
        }
      }
    } else if (typeof event.delta?.output_text === 'string') {
      fragments.push(event.delta.output_text)
    }

    if (fragments.length === 0) {
      return []
    }

    return this._emitTextDelta(fragments.join(''))
  }

  _emitMessageStart() {
    if (this.messageStarted) {
      return []
    }

    this.messageStarted = true
    this.messageId = this.messageId || this._generateId('msg')

    return [
      this._sse({
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          usage: {
            input_tokens: 0,
            output_tokens: 0
          }
        }
      })
    ]
  }

  _ensureTextBlock() {
    if (this.contentBlockStarted) {
      return []
    }

    this.contentBlockStarted = true
    this.contentBlockId = this._generateId('cb')

    return [
      this._sse({
        type: 'content_block_start',
        index: 0,
        content_block: {
          id: this.contentBlockId,
          type: 'text',
          text: ''
        }
      })
    ]
  }

  _emitTextDelta(deltaText) {
    if (!deltaText) {
      return []
    }

    const events = []
    events.push(...this._emitMessageStart())
    events.push(...this._ensureTextBlock())

    events.push(
      this._sse({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: deltaText
        }
      })
    )

    return events
  }

  _emitCompletion(responsePayload) {
    if (this.streamFinished) {
      return []
    }

    logger.info('🎯 [Bridge] Emitting completion event:', {
      isCodexClient: this._isCodexClient(),
      clientType: this.clientType,
      targetFormat: this.targetFormat,
      hasResponsePayload: !!responsePayload,
      streamState: {
        messageStarted: this.messageStarted,
        contentBlockStarted: this.contentBlockStarted,
        streamFinished: this.streamFinished
      }
    })

    // 如果是 Codex CLI，发送 OpenAI Responses 格式的完成事件
    if (this._isCodexClient()) {
      const completionEvents = this._emitOpenAIResponsesCompletion(responsePayload)

      // 也要发送标准的Claude格式事件以确保兼容性
      const claudeEvents = this._emitClaudeCompletion(responsePayload)

      this.streamFinished = true

      if (responsePayload) {
        this.finalResponse = responsePayload
      }

      logger.info('📤 [Bridge] Sent dual completion events for Codex CLI:', {
        openAIEventsCount: completionEvents.length,
        claudeEventsCount: claudeEvents.length,
        totalEvents: completionEvents.length + claudeEvents.length
      })

      return [...completionEvents, ...claudeEvents]
    }

    // 非Codex客户端，只发送标准Claude格式完成事件
    const events = this._emitClaudeCompletion(responsePayload)

    this.streamFinished = true

    if (responsePayload) {
      this.finalResponse = responsePayload
    }

    return events
  }

  /**
   * 发送标准Claude格式的完成事件
   * @private
   */
  _emitClaudeCompletion(responsePayload) {
    const events = []
    events.push(...this._emitMessageStart())

    if (this.contentBlockStarted) {
      events.push(
        this._sse({
          type: 'content_block_stop',
          index: 0
        })
      )
      this.contentBlockStarted = false
      this.contentBlockId = null
    }

    if (this.toolBlock) {
      events.push(
        this._sse({
          type: 'content_block_stop',
          index: this.toolBlock.index
        })
      )
      this.toolBlock = null
    }

    const usage = this._extractUsage({ usage: responsePayload?.usage })
    const stopReason = this._mapStopReason(responsePayload?.stop_reason || responsePayload?.status)

    events.push(
      this._sse({
        type: 'message_delta',
        delta: {
          stop_reason: stopReason
        },
        usage
      })
    )

    events.push(this._sse({ type: 'message_stop' }))

    return events
  }

  _emitError(errorPayload) {
    this._resetStreamState()
    this.streamFinished = true
    return [
      this._sse({
        type: 'error',
        error: errorPayload || { message: 'Unknown error' }
      })
    ]
  }

  _handleOutputItemAdded(event) {
    const { item } = event
    if (!item || item.type !== 'function_call') {
      return []
    }

    const blockId = item.id || this._generateId('tool')
    this.toolBlock = {
      id: blockId,
      name: item.name || 'tool',
      args: '',
      index: 1
    }

    return [
      this._sse({
        type: 'content_block_start',
        index: 1,
        content_block: {
          id: blockId,
          type: 'tool_use',
          name: this.toolBlock.name,
          input: {}
        }
      })
    ]
  }

  _handleFunctionCallArgumentsDelta(event) {
    if (!this.toolBlock || event.item_id !== this.toolBlock.id) {
      return []
    }

    let chunk = ''
    if (typeof event.delta === 'string') {
      chunk = event.delta
    } else if (event.delta && typeof event.delta.partial_json === 'string') {
      chunk = event.delta.partial_json
    }

    if (!chunk) {
      return []
    }

    this.toolBlock.args += chunk

    logger.info('Claude bridge接收 tool arguments delta', {
      itemId: event.item_id,
      chunkPreview: chunk.length > 120 ? `${chunk.slice(0, 120)}…` : chunk,
      chunkLength: chunk.length
    })

    return []
  }

  _handleFunctionCallArgumentsDone(event) {
    if (!this.toolBlock || event.item_id !== this.toolBlock.id) {
      return []
    }

    if (typeof event.arguments !== 'string' || !event.arguments) {
      return []
    }

    this.toolBlock.args = this._sanitizeToolArguments(event.arguments)

    logger.info('Claude bridge完成 tool arguments', {
      itemId: event.item_id,
      argumentLength: this.toolBlock.args.length
    })

    return [
      this._sse({
        type: 'content_block_delta',
        index: this.toolBlock.index,
        delta: {
          type: 'input_json',
          partial_json: this.toolBlock.args
        }
      })
    ]
  }

  _handleOutputItemDone(event) {
    if (!this.toolBlock || event.item?.id !== this.toolBlock.id) {
      return []
    }

    const events = [
      this._sse({
        type: 'content_block_stop',
        index: this.toolBlock.index
      })
    ]

    this.toolBlock = null
    return events
  }

  _collectOutputText(output) {
    if (!output) {
      return ''
    }

    if (typeof output === 'string') {
      return output
    }

    if (!Array.isArray(output)) {
      return ''
    }

    const fragments = []

    for (const part of output) {
      if (!part) {
        continue
      }

      if (typeof part === 'string') {
        fragments.push(part)
      } else if (part.type === 'output_text' && typeof part.text === 'string') {
        fragments.push(part.text)
      }
    }

    return fragments.join('')
  }

  _convertOutputContent(resp) {
    if (!resp || !Array.isArray(resp.output)) {
      return []
    }

    const content = []

    for (const item of resp.output) {
      if (!item || typeof item !== 'object') {
        continue
      }

      if (item.type === 'message' && Array.isArray(item.content)) {
        const text = this._collectOutputText(item.content)
        if (text) {
          content.push({ type: 'text', text })
        }
        continue
      }

      if (item.type === 'function_call') {
        let parsedArgs = {}
        if (typeof item.arguments === 'string') {
          try {
            parsedArgs = JSON.parse(item.arguments)
          } catch (error) {
            logger.warn('Failed to parse function_call arguments for Claude bridge', {
              error: error.message
            })
            parsedArgs = { raw: item.arguments }
          }
        }

        content.push({
          type: 'tool_use',
          id: item.id || this._generateId('tool'),
          name: item.name || 'tool',
          input: parsedArgs
        })
      }
    }

    return content
  }

  _extractText(resp) {
    if (!resp) {
      return ''
    }

    if (typeof resp.output_text === 'string') {
      return resp.output_text
    }

    if (Array.isArray(resp.output)) {
      const texts = []
      for (const seg of resp.output) {
        if (typeof seg === 'string') {
          texts.push(seg)
        } else if (seg?.content) {
          texts.push(String(seg.content))
        } else if (seg?.text) {
          texts.push(String(seg.text))
        }
      }
      if (texts.length > 0) {
        return texts.join('')
      }
    }

    if (typeof resp.content === 'string') {
      return resp.content
    }

    return ''
  }

  _extractUsage(data) {
    // 如果有累积的使用数据，优先使用累积数据
    if (this.accumulatedUsage && (this.accumulatedUsage.input_tokens > 0 || this.accumulatedUsage.output_tokens > 0)) {
      logger.info('📊 [Bridge] Using accumulated usage data:', {
        accumulatedUsage: this.accumulatedUsage,
        fallbackUsage: data?.usage || data?.response?.usage || {}
      })
      return {
        input_tokens: this.accumulatedUsage.input_tokens,
        output_tokens: this.accumulatedUsage.output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    }

    const usage = data?.usage || data?.response?.usage || {}
    return {
      input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
      output_tokens: usage.output_tokens || usage.completion_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.input_tokens_details?.cached_tokens || 0
    }
  }

  _mapStopReason(reason) {
    if (!reason) {
      return 'end_turn'
    }

    const normalized = String(reason).toLowerCase()

    if (['stop', 'completed', 'end_turn', 'normal'].includes(normalized)) {
      return 'end_turn'
    }

    if (['length', 'max_tokens'].includes(normalized)) {
      return 'max_tokens'
    }

    if (['tool_use', 'tool_calls', 'function_call'].includes(normalized)) {
      return 'tool_use'
    }

    if (['cancelled', 'canceled', 'abort', 'aborted'].includes(normalized)) {
      return 'stop_sequence'
    }

    return 'end_turn'
  }

  _sse(payload) {
    return `event: ${payload.type || 'event'}\n` + `data: ${JSON.stringify(payload)}\n\n`
  }

  _generateId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  }

  _resetStreamState() {
    this.streamBuffer = ''
    this.messageStarted = false
    this.contentBlockStarted = false
    this.streamFinished = false
    this.messageId = null
    this.contentBlockId = null
    this.toolBlock = null
    this.debugEventCount = 0
    this.debugEmitCount = 0
    this.finalResponse = null
    this.accumulatedUsage = null // 新增：累积的usage数据
  }

  /**
   * 检测是否为 Codex CLI 客户端
   * @private
   */
  _isCodexClient() {
    return this.clientType === 'codex_cli' ||
           (this.clientType === 'unknown' && this.targetFormat === 'openai-responses')
  }

  /**
   * 为 Codex CLI 生成 OpenAI Responses 格式的完成事件
   * @private
   */
  _emitOpenAIResponsesCompletion(responsePayload) {
    const usage = this._extractUsage({ usage: responsePayload?.usage })
    const stopReason = this._mapStopReason(responsePayload?.stop_reason || responsePayload?.status)

    logger.info('🎯 [Bridge] Emitting OpenAI Responses completion for Codex CLI:', {
      hasUsage: !!(usage && (usage.input_tokens > 0 || usage.output_tokens > 0)),
      stopReason,
      usage,
      clientType: this.clientType
    })

    const events = []

    // 发送 response.completed 事件（Codex CLI 期望的格式）
    events.push(
      this._sse({
        type: 'response.completed',
        response: {
          id: this.messageId || this._generateId('resp'),
          status: 'completed',
          status_details: {
            type: 'content_filter',
            stop_reason: stopReason
          },
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens
          },
          model: 'gpt-5-codex' // Codex CLI 期望的模型名称
        }
      })
    )

    return events
  }

  _sanitizeToolArguments(rawArguments) {
    try {
      const parsed = JSON.parse(rawArguments)

      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.allowed_domains)) {
          const filteredAllowed = parsed.allowed_domains.filter(
            (item) => typeof item === 'string' && item.trim()
          )
          if (filteredAllowed.length > 0) {
            parsed.allowed_domains = filteredAllowed
          } else {
            delete parsed.allowed_domains
          }
        } else if (parsed.allowed_domains !== null && parsed.allowed_domains !== undefined) {
          delete parsed.allowed_domains
        }

        if (Array.isArray(parsed.blocked_domains)) {
          const filteredBlocked = parsed.blocked_domains.filter(
            (item) => typeof item === 'string' && item.trim()
          )
          if (filteredBlocked.length > 0) {
            parsed.blocked_domains = filteredBlocked
          } else {
            delete parsed.blocked_domains
          }
        } else if (parsed.blocked_domains !== null && parsed.blocked_domains !== undefined) {
          delete parsed.blocked_domains
        }

        if (parsed.allowed_domains && parsed.blocked_domains) {
          // Claude CLI 不允许同时指定，优先保留 allow 列表
          delete parsed.blocked_domains
        }

        return JSON.stringify(parsed)
      }
    } catch (error) {
      logger.warn('Failed to sanitize tool arguments JSON', { message: error.message })
    }

    return rawArguments
  }

  getFinalResponse() {
    return this.finalResponse
  }

  _logEmittedEvents(events) {
    if (!events || events.length === 0) {
      return
    }

    if (this.debugEmitCount >= 10) {
      return
    }

    const names = []
    for (const evt of events) {
      const match = evt.match(/event: ([^\n]+)/)
      if (match && match[1]) {
        names.push(match[1])
      }
    }

    if (names.length > 0) {
      logger.info('📤 [Bridge] 向客户端写出事件', {
        events: names,
        count: names.length,
        streamFinished: this.streamFinished,
        messageStarted: this.messageStarted,
        contentBlockStarted: this.contentBlockStarted
      })
      this.debugEmitCount += 1
    }
  }
}

module.exports = OpenAIResponsesToClaudeConverter
